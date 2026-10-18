'use strict';
/* Parity harness for assets/exercise-worker.js.

   The worker cannot run in node (importScripts, Worker), but its Python half is
   what decides a learner's grade, so this file loads the REAL worker source into
   a vm context with a fake `self` and a fake Pyodide, and drives real CPython
   behind that fake. Nothing is copied out of the worker: a bug in the shipped
   file fails here.

   The fake Pyodide is faithful on the two points that matter. `runPython` is
   SYNCHRONOUS and `globals.get()` sees what it just wrote, exactly like the real
   one — the worker reads globals immediately after a runPython and cannot await
   in between. And the interpreter PERSISTS: one CPython process lives for the
   whole file, driven over a request/response file pair, because the real worker
   owns one interpreter that every run shares.

   Both used to be false, and it mattered. The previous version started a
   throwaway interpreter per run and replayed the snippets into a fresh dict,
   which made "a previous run cannot leave a variable behind" pass for the wrong
   reason: the fake had thrown the state away, so it could never have leaked.
   That test was asserting something about the harness, not about the worker.

   Verdicts are then compared against scripts/check_exercise_references.py, the
   harness the corpus is proved against, so "the worker and the harness agree" is
   measured rather than asserted.

   Usage:  node scripts/test-exercise-worker.cjs
*/
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync, spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WORKER = path.join(ROOT, 'assets/exercise-worker.js');
const VENV_PYTHON = path.join(ROOT, '.venv/Scripts/python.exe');
const PYTHON = process.env.PYTHON || (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python');

/* A LONG-LIVED CPython process, driven one request at a time through a request
   file and a response file in a temp directory.

   Two properties matter here and neither was true of the version this replaced.

   SYNCHRONOUS. The worker reads pyodide.globals.get(...) immediately after
   runPython, exactly as the real Pyodide allows, and cannot await in between.
   So the fake cannot answer from a microtask; it blocks until Python is done.
   The node side waits on Atomics.wait, which parks the thread WITHOUT pumping
   the event loop — that is what a synchronous runPython looks like from the
   worker's side.

   PERSISTENT. The real worker owns one interpreter that every run shares, so
   "a previous run cannot leave a variable behind" can only fail if state really
   does survive between runs. The version this replaced started a throwaway
   interpreter per run and replayed the snippets into a fresh dict, which made
   that case pass for the wrong reason: the fake had discarded the state, so it
   could never have leaked.

   File hand-off rather than pipes, because reading a child's stdout pipe
   synchronously is not portable to Windows. */
const DRIVER = `
import json, os, sys, time, traceback

HERE = sys.argv[1]
REQ = os.path.join(HERE, 'req.json')
RES = os.path.join(HERE, 'res.json')

NAMES = ['__sils_stdout', '__sils_error', '__sils_ok', '__sils_assert_ok',
         '__sils_assert_detail', '__sils_found', '__sils_value']

def encode(value):
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        if value != value or value in (float('inf'), float('-inf')):
            return {'__nonfinite__': repr(value)}
        return value
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return {'__opaque__': type(value).__name__}

def snapshot(session):
    # The learner's globals, as the worker's values field reports them.
    out = {}
    for key, value in list(session.items()):
        if key.startswith('__sils_') or key.startswith('_sils_'):
            continue
        if value is None or isinstance(value, (bool, int, float, str)):
            out[key] = value
        elif isinstance(value, (list, tuple, dict)):
            try:
                json.dumps(value)
                out[key] = list(value) if isinstance(value, tuple) else value
            except (TypeError, ValueError):
                out[key] = {'__type__': type(value).__name__}
        else:
            out[key] = {'__type__': type(value).__name__}
    return out

# The interpreter's own namespace, kept for the life of the process.
SESSION = {}

while True:
    if not os.path.exists(REQ):
        time.sleep(0.002)
        continue
    try:
        with open(REQ, 'r', encoding='utf-8') as handle:
            request = json.load(handle)
        os.remove(REQ)
    except (OSError, ValueError):
        continue
    if request.get('stop'):
        break
    error = None
    try:
        for code in request['codes']:
            exec(compile(code, '<exercise>', 'exec'), SESSION)
    except BaseException:
        error = traceback.format_exc(limit=8)
    payload = {'error': error,
               'values': {name: encode(SESSION.get(name)) for name in NAMES},
               'learner': snapshot(SESSION)}
    with open(RES, 'w', encoding='utf-8') as handle:
        json.dump(payload, handle)
`;

/* One CPython process that lives as long as the fake worker does. */
function createInterpreter() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sils-worker-'));
  const req = path.join(dir, 'req.json');
  const res = path.join(dir, 'res.json');
  const child = spawn(PYTHON, ['-X', 'utf8', '-u', '-c', DRIVER, dir], { stdio: 'ignore' });
  const park = new Int32Array(new SharedArrayBuffer(4));

  return {
    run(codes) {
      fs.writeFileSync(req, JSON.stringify({ codes }), 'utf8');
      const deadline = Date.now() + 30000;
      while (!fs.existsSync(res)) {
        if (Date.now() > deadline) throw new Error('the python driver stopped responding');
        Atomics.wait(park, 0, 0, 2);
      }
      const payload = JSON.parse(fs.readFileSync(res, 'utf8'));
      fs.rmSync(res, { force: true });
      return payload;
    },
    close() {
      try { fs.writeFileSync(req, JSON.stringify({ stop: true }), 'utf8'); } catch (failure) { /* gone */ }
      child.kill();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

// The real corpus harness — the same module Task 3 wrote and CI runs.
const PROBE = `
import json, sys
from pathlib import Path
sys.path.insert(0, str(Path(sys.argv[1]).resolve()))
import check_exercise_references as H

request = json.loads(sys.stdin.read())
if request['mode'] == 'corpus':
    items = []
    for lang, where, item in H.executable_items():
        if item['type'] not in H.EXECUTABLE_TYPES:
            continue
        items.append({'where': where, 'item': {
            key: item.get(key)
            for key in ('id', 'type', 'checks', 'starter', 'reference')}})
    print(json.dumps(items))
else:
    item = request['item']
    mode, stdout, namespace, problem = H.solve(item)
    verdicts = None
    if problem is None:
        verdicts = [H.outcome(check, stdout, namespace) for check in (item.get('checks') or [])]
    print(json.dumps({'problem': problem, 'stdout': stdout, 'verdicts': verdicts}))
`;

function python(source, payload) {
  const result = spawnSync(PYTHON, ['-X', 'utf8', '-c', source, path.join(ROOT, 'scripts')], {
    input: JSON.stringify(payload), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`python failed (${result.status}): ${String(result.stderr || '').trim()}`);
  }
  return JSON.parse(result.stdout);
}

const SANDBOX = path.join(ROOT, 'assets/exercise-sandbox.js');

const SANDBOX_KINDS = new Set(['assert_python', 'var_equals', 'var_in_range']);
const SHARED_KINDS = new Set([
  'assert_python', 'var_equals', 'var_in_range',
  'stdout_contains', 'stdout_equals', 'stdout_matches',
]);

/* The private guard namespace the worker seals the JS bridge into. Only the
   protocol matters to this fake; the seal's Python is exercised for real
   against a real Pyodide by scripts/test-exercise-sandbox-real.cjs. */
const guard = { capture: {} };

function createWorkerHost(override) {
  const source = override || fs.readFileSync(WORKER, 'utf8');
  let handler = null;
  let codes = [];
  let snapshot = {};
  const replies = [];
  const imported = [];
  // ONE interpreter for the lifetime of this host, exactly like the real
  // worker: a single worker owns a single Python namespace that every run
  // shares. Starting a fresh interpreter per run would make the cross-run
  // leakage cases pass for the wrong reason.
  const interpreter = createInterpreter();

  function flush() {
    const result = interpreter.run(codes.slice());
    codes.length = 0;
    if (result.error) {
      const lines = String(result.error).trim().split('\n');
      throw new Error(lines[lines.length - 1] || 'python snippet failed');
    }
    snapshot = result.values;
    // The `values` field the real runtime produces for the result.
    guard.capture = result.learner;
  }

  function makeRuntime() {
    const bindings = Object.create(null);
    return {
      silsGuard: null,
      globals: {
        get(name) {
          if (name === 'dict') return () => guard;
          return Object.prototype.hasOwnProperty.call(snapshot, name) ? snapshot[name] : undefined;
        },
        // Names bound into the interpreter namespace from JS. The real
        // pyodide globals.set() takes any value and converts it; the only
        // thing the worker binds is a Python function proxy, which JSON
        // cannot express, so it is kept here and re-entered when the matching
        // runPython call comes around.
        set(name, value) { bindings[name] = value; },
        delete(name) { delete bindings[name]; },
      },
      runPython(code, options) {
        // runPython(code, {globals}) targets the private guard namespace where
        // the JS-bridge seal lives. This fake models the PROTOCOL of that; the
        // seal's Python is executed for real against a real Pyodide by
        // scripts/test-exercise-sandbox-real.cjs. What the worker reads back
        // out of the namespace is the capture function.
        if (options && options.globals) {
          // The real Pyodide hands back a Python function proxy here, and the
          // matching call comes back as a dict proxy carrying toJs().
          if (code === '_sils_capture') return () => ({ toJs: () => guard.capture });
          return undefined;
        }
        const call = /^([A-Za-z_]\w*)\(globals\(\)\)$/.exec(code);
        if (call && bindings[call[1]]) return bindings[call[1]]();
        codes.push(code);
        flush();
        return undefined;
      },
    };
  }

  const context = {
    self: {
      addEventListener(type, listener) { if (type === 'message') handler = listener; },
      postMessage(message) { replies.push(message); },
    },
    // Recorded, not executed: the real loader cannot run outside a browser,
    // and loadPyodide is faked anyway. The URL is still worth asserting.
    importScripts(url) { imported.push(url); },
    loadPyodide: async () => makeRuntime(),
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'assets/exercise-worker.js' });

  return {
    loaded: typeof handler === 'function',
    imported,
    close() { interpreter.close(); },
    async run(request) {
      codes = [];
      snapshot = {};
      replies.length = 0;
      const nonce = request && request.nonce !== undefined ? request.nonce : 'test-nonce';
      await handler({ data: Object.assign({ type: 'run' }, request, { nonce }) });
      assert.equal(replies.length, 2, 'the worker must post a loading notice and one result per run');
      assert.equal(replies[0].type, 'loading');
      assert.equal(replies[0].nonce, nonce);
      assert.equal(replies[1].type, 'result');
      assert.equal(replies[1].nonce, nonce, 'the result must echo the request nonce');
      return replies[1];
    },
  };
}

const host = createWorkerHost();
assert.equal(host.loaded, true, 'the worker must register a message listener when it loads');

// The facade queues its runs, so postMessage lands a microtask later.
const settle = () => new Promise(resolve => setImmediate(resolve));

/* The facade, loaded the same way with a Worker it can pull strings on. */
function createSandbox() {
  const spawned = [];
  const pending = [];
  class FakeWorker {
    constructor(url) {
      this.url = url;
      this.listeners = new Map();
      this.terminated = false;
      spawned.push(this);
    }
    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(listener);
    }
    removeEventListener(type, listener) {
      const kept = (this.listeners.get(type) || []).filter(one => one !== listener);
      this.listeners.set(type, kept);
    }
    postMessage(data) { pending.push({ worker: this, data }); }
    terminate() { this.terminated = true; }
    emit(type, event) { for (const listener of this.listeners.get(type) || []) listener(event); }
  }
  const module = { exports: {} };
  const context = {
    module,
    exports: module.exports,
    Worker: FakeWorker,
    setTimeout,
    clearTimeout,
    crypto: { getRandomValues: bytes => require('node:crypto').randomFillSync(bytes) },
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(SANDBOX, 'utf8'), context, { filename: 'assets/exercise-sandbox.js' });
  return {
    api: module.exports,
    spawned,
    pending,
    take() {
      assert.equal(pending.length, 1, 'expected exactly one in-flight postMessage');
      return pending.shift();
    },
    peek() { return pending.length; },
  };
}

const CASES = [
  ['G9: Pyodide stays out of index.html and is loaded from the worker, on demand', async () => {
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    assert.ok(!/<script[^>]*pyodide/i.test(html), 'index.html must not carry a Pyodide script tag');
    assert.deepEqual(host.imported, [], 'the runtime must not load before the first run');
    await host.run({ code: 'pass\n', checks: [] });
    // The worker lives in assets/, so the vendored loader is one level down.
    assert.deepEqual(host.imported, ['./vendor/pyodide/pyodide.js']);
  }],

  ['a correct program passes every check and reports its stdout', async () => {
    const result = await host.run({
      code: 'name = "Ada"\nrole = "Agent"\nprint(f"I am {name}, I want to learn {role}")\n',
      checks: [
        { kind: 'stdout_matches', pattern: 'I am [\\s\\S]{1,20},\\s*I want to learn\\s*[^\\s]', weight: 6 },
        { kind: 'assert_python', code: "assert isinstance(name, str) and name.strip(), 'name must be set'", weight: 2 },
        { kind: 'var_equals', name: 'name', value: 'Ada', weight: 2 },
        { kind: 'stdout_contains', value: 'I am Ada', weight: 3 },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.error, '');
    assert.equal(result.stdout, 'I am Ada, I want to learn Agent\n');
    assert.equal(result.outcomes.length, 4);
    assert.deepEqual(result.outcomes.map(one => one.ok), [true, true, true, true]);
  }],

  ['a syntax error scores zero and still returns one outcome per check', async () => {
    const checks = [
      { kind: 'stdout_contains', value: 'anything', weight: 1 },
      { kind: 'assert_python', code: 'assert True', weight: 1 },
      { kind: 'var_equals', name: 'x', value: 1, weight: 1 },
    ];
    const result = await host.run({ code: 'def broken(:\n    pass\n', checks });
    assert.equal(result.ok, false);
    assert.match(result.error, /SyntaxError/);
    assert.equal(result.outcomes.length, checks.length, 'outcomes must stay index-aligned');
    assert.deepEqual(result.outcomes.map(one => one.ok), [false, false, false]);
    // A crashed program still gets its stdout checks graded (the buffer is
    // empty); only the sandbox kinds are blanked, per harness point 2.
    assert.deepEqual(result.outcomes.map(one => one.detail), [
      'output does not contain "anything"', 'code did not run', 'code did not run',
    ]);
  }],

  ['stdout printed before a crash survives and is still graded', async () => {
    const result = await host.run({
      code: 'print("partial result")\nraise ValueError("boom")\n',
      checks: [
        { kind: 'stdout_contains', value: 'partial result', weight: 1 },
        { kind: 'assert_python', code: 'assert False', weight: 1 },
      ],
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /ValueError: boom/);
    assert.equal(result.stdout, 'partial result\n');
    assert.deepEqual(result.outcomes.map(one => one.ok), [true, false]);
  }],

  ['stderr is merged into the same buffer as stdout', async () => {
    // Harness point 1: stdout_* really means stdout + stderr, in BOTH the
    // worker and scripts/check_exercise_references.py.
    const item = {
      checks: [{ kind: 'stdout_contains', value: 'from stderr', weight: 1 }],
      reference: 'import sys\nprint("from stderr", file=sys.stderr)\n',
    };
    const result = await host.run({ code: item.reference, checks: item.checks });
    assert.equal(result.outcomes[0].ok, true);
    assert.equal(result.stdout, 'from stderr\n');
    const harness = python(PROBE, { mode: 'grade', item });
    assert.equal(harness.problem, null);
    assert.equal(harness.verdicts[0], true, 'the harness must agree');
  }],

  ['a failed assertion reports the assertion message', async () => {
    const result = await host.run({
      code: 'answer = 41\n',
      checks: [{ kind: 'assert_python', code: "assert answer == 42, 'answer must be 42'", weight: 1 }],
    });
    assert.equal(result.ok, true);
    assert.equal(result.outcomes[0].ok, false);
    assert.equal(result.outcomes[0].detail, 'AssertionError: answer must be 42');
  }],

  ['var_equals separates never assigned from assigned the wrong value', async () => {
    const result = await host.run({
      code: 'weight_bytes = 3\n',
      checks: [
        { kind: 'var_equals', name: 'weight_bytes', value: 14000000000, weight: 1 },
        { kind: 'var_equals', name: 'never_assigned', value: 1, weight: 1 },
        { kind: 'var_in_range', name: 'weight_bytes', min: 1, max: 10, weight: 1 },
        { kind: 'var_in_range', name: 'weight_bytes', min: 100, max: 200, weight: 1 },
        { kind: 'var_in_range', name: 'never_assigned', min: 1, max: 10, weight: 1 },
      ],
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.outcomes.map(one => one.ok), [false, false, true, false, false]);
    assert.deepEqual(result.outcomes.map(one => one.detail), [
      'got 3',
      'never_assigned was never assigned',
      'got 3',
      'got 3',
      'never_assigned was never assigned',
    ]);
  }],

  ['var_in_range names the type when the value is not a number', async () => {
    // `Number('abc')` is NaN, and the old detail printed "got NaN", which tells
    // a learner nothing about what they actually assigned.
    const result = await host.run({
      code: 'score = "not a number"\n',
      checks: [{ kind: 'var_in_range', name: 'score', min: 1, max: 10, weight: 1 }],
    });
    assert.equal(result.outcomes[0].ok, false);
    assert.equal(result.outcomes[0].detail, 'score is the text "not a number", not a number');
    assert.ok(!/NaN/.test(result.outcomes[0].detail), 'NaN must not be shown to the learner');
  }],

  ['var_equals reads the variable the check names, not one called `name`', async () => {
    // The brief's readVariable emitted a bare `name in globals()`. A learner who
    // happens to define `name` would silently answer a different question, and
    // everyone else would take the whole run down with a NameError.
    const result = await host.run({
      code: 'name = "shadow"\nweight_bytes = 14\n',
      checks: [
        { kind: 'var_equals', name: 'weight_bytes', value: 14, weight: 1 },
        { kind: 'var_equals', name: 'other', value: 'shadow', weight: 1 },
      ],
    });
    assert.deepEqual(result.outcomes.map(one => one.ok), [true, false]);
  }],

  ['a previous run cannot leave a variable behind for the next one', async () => {
    await host.run({ code: 'total = 5\n', checks: [] });
    const second = await host.run({
      code: 'print("no total this time")\n',
      checks: [{ kind: 'var_equals', name: 'total', value: 5, weight: 1 }],
    });
    assert.equal(second.outcomes[0].ok, false, 'a stale global must not satisfy this run');
    assert.equal(second.outcomes[0].detail, 'total was never assigned');
  }],

  ['an underscore-prefixed global is cleaned too, not just a plain one', async () => {
    // The cleanup once kept every name starting with '_', so a learner who
    // wrote `_total = 5` still had it on the next run and could pass a check
    // they had stopped satisfying. Only this worker's own __sils_* slots stay.
    await host.run({ code: '_total = 5\n', checks: [] });
    const second = await host.run({
      code: 'pass\n',
      checks: [{ kind: 'var_equals', name: '_total', value: 5, weight: 1 }],
    });
    assert.equal(second.outcomes[0].ok, false, 'a stale _global must not satisfy this run');
    assert.equal(second.outcomes[0].detail, '_total was never assigned');
  }],

  ['the result carries a snapshot of the learner globals in `values`', async () => {
    const result = await host.run({
      code: 'answer = 42\nlabel = "hi"\nitems = [1, 2]\nclass Thing:\n    pass\nthing = Thing()\n',
      checks: [],
    });
    assert.equal(result.ok, true);
    assert.equal(result.values.answer, 42);
    assert.equal(result.values.label, 'hi');
    assert.deepEqual(result.values.items, [1, 2]);
    // Anything that cannot cross into JSON is reported by type rather than
    // dropped: "there is a thing and it is a Thing" is information a caller
    // can use, whereas a silent omission is indistinguishable from "never set".
    assert.deepEqual(result.values.thing, { __type__: 'Thing' });
    assert.ok(!('__sils_stdout' in result.values), 'worker internals must not leak into values');
  }],

  ['a failed run still returns a `values` field', async () => {
    const result = await host.run({ code: 'def broken(:\n    pass\n', checks: [] });
    assert.equal(result.ok, false);
    assert.deepEqual(result.values, {}, 'callers must never have to test whether values exists');
  }],

  ['mixed check kinds stay index-aligned', async () => {
    const result = await host.run({
      code: 'score = 7\nprint("done")\n',
      answer: ['B', 'A'],
      checks: [
        { kind: 'stdout_matches', pattern: 'done', weight: 1 },
        { kind: 'self_assessed', weight: 1 },
        { kind: 'var_in_range', name: 'score', min: 5, max: 10, weight: 1 },
        { kind: 'output_choice', correct: ['A', 'B'], weight: 1 },
        { kind: 'assert_python', code: 'assert score == 7', weight: 1 },
        { kind: 'stdout_equals', value: 'nope', weight: 1 },
      ],
    });
    assert.equal(result.outcomes.length, 6);
    assert.deepEqual(result.outcomes.map(one => one.ok), [true, false, true, true, true, false]);
    assert.equal(result.outcomes[1].detail, 'not evaluated');
  }],

  ['a runtime failure still answers with one outcome per check', async () => {
    // The worker's catch path must not hand the grader a short array: a
    // truncated outcomes list mislabels every check after the real fault.
    const original = fs.readFileSync(WORKER, 'utf8');
    const broken = original.replace(
      'const pyodide = await ready;',
      'throw new Error("runtime exploded");');
    assert.notEqual(broken, original, 'the mutation must apply');
    const crashed = createWorkerHost(broken);
    try {
      const result = await crashed.run({
        code: 'print("hi")\n',
        checks: [
          { kind: 'stdout_contains', value: 'hi', weight: 1 },
          { kind: 'assert_python', code: 'assert True', weight: 1 },
        ],
      });
      assert.equal(result.ok, false);
      assert.match(result.error, /runtime exploded/);
      assert.equal(result.outcomes.length, 2);
      assert.deepEqual(result.outcomes.map(one => one.ok), [false, false]);
    } finally {
      // Its own interpreter: without this the child outlives the run.
      crashed.close();
    }
  }],

  ['every corpus reference scores the same as the harness says it does', async () => {
    const items = python(PROBE, { mode: 'corpus' });
    assert.ok(items.length >= 9, `expected the frozen corpus, found ${items.length} items`);
    let compared = 0;
    for (const entry of items) {
      const { item } = entry;
      const result = await host.run({ code: item.reference || '', checks: item.checks || [] });
      assert.equal(result.outcomes.length, (item.checks || []).length,
        `${entry.where}: outcomes must stay aligned with checks`);
      const harness = python(PROBE, { mode: 'grade', item });
      if (harness.problem !== null) {
        assert.equal(result.ok, false,
          `${entry.where}: the harness reports "${harness.problem}", so the worker must not pass`);
        for (const [index, one] of result.outcomes.entries()) {
          if (SANDBOX_KINDS.has(item.checks[index].kind)) {
            assert.equal(one.ok, false,
              `${entry.where}: a crashed run must score zero on ${item.checks[index].kind}`);
          }
        }
        continue;
      }
      assert.equal(result.ok, true, `${entry.where}: the harness ran this reference cleanly`);
      assert.equal(result.stdout, harness.stdout, `${entry.where}: stdout differs from the harness`);
      for (const [index, one] of result.outcomes.entries()) {
        const kind = item.checks[index].kind;
        if (!SHARED_KINDS.has(kind)) continue;
        assert.equal(one.ok, harness.verdicts[index] === true,
          `${entry.where}: worker and harness disagree on check ${index} (${kind})`);
        compared += 1;
      }
    }
    assert.ok(compared >= 27, `expected a meaningful comparison, made ${compared}`);
    console.log(`       (${items.length} references, ${compared} verdicts compared with the harness)`);
  }],

  ['the facade posts the protocol the worker answers', async () => {
    const box = createSandbox();
    const sandbox = box.api.create({});
    const request = {
      code: 'print("hi")\n',
      checks: [{ kind: 'stdout_contains', value: 'hi', weight: 1 }],
      answer: ['A'],
    };
    const settled = sandbox.run(request);
    await settle();
    const { data, worker: posted } = box.take();
    assert.equal(data.type, 'run');
    assert.equal(data.code, request.code);
    assert.deepEqual(data.checks, request.checks);
    assert.deepEqual(data.answer, ['A']);
    assert.equal(data.timeoutMs, box.api.DEFAULT_TIMEOUT);
    assert.match(data.nonce, /^[0-9a-f]{32}$/, 'every run must carry a fresh random nonce');

    // Straight through the real worker, then back into the facade.
    const reply = await host.run(data);
    assert.equal(reply.nonce, data.nonce, 'the worker must echo the nonce it was given');
    posted.emit('message', { data: reply });
    const result = await settled;
    assert.equal(result.ok, true);
    assert.equal(result.stdout, 'hi\n');
    assert.deepEqual(result.outcomes, reply.outcomes);
    assert.equal(result.reason, undefined);
  }],

  ['two runs never share a nonce', async () => {
    // A constant or a counter would let learner code predict it and forge a
    // result that passes. Sampled from real runs, they must differ.
    const seen = new Set();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const box = createSandbox();
      const sandbox = box.api.create({});
      const settled = sandbox.run({ code: 'pass\n', checks: [] });
      await settle();
      const { data, worker: posted } = box.take();
      seen.add(data.nonce);
      posted.emit('message', { data: { type: 'loading', nonce: data.nonce } });
      posted.emit('message', { data: { type: 'result', nonce: data.nonce, ok: true, outcomes: [], ms: 1 } });
      await settled;
    }
    assert.equal(seen.size, 3, 'each run must mint its own nonce');
  }],

  ['a forged result with the wrong nonce is discarded', async () => {
    // The escape the nonce exists to stop: learner code that reaches
    // postMessage can shape any message it likes, but it cannot know this
    // run's nonce, so the facade must not believe what it sends.
    const box = createSandbox();
    const sandbox = box.api.create({});
    const checks = [
      { kind: 'assert_python', code: 'assert False', weight: 1 },
      { kind: 'stdout_contains', value: 'nope', weight: 1 },
    ];
    const settled = sandbox.run({ code: 'pass\n', checks });
    await settle();
    const { data, worker: posted } = box.take();
    posted.emit('message', { data: { type: 'loading', nonce: data.nonce } });
    posted.emit('message', {
      data: {
        type: 'result', nonce: 'not-the-right-nonce', ok: true, stdout: '',
        outcomes: checks.map(() => ({ ok: true, detail: '' })),
      },
    });
    posted.emit('message', {
      data: {
        type: 'result', nonce: data.nonce, ok: true, stdout: 'real\n',
        outcomes: checks.map(() => ({ ok: false, detail: 'code did not run' })),
      },
    });
    const result = await settled;
    assert.equal(result.stdout, 'real\n', 'the forged message must not have been believed');
    assert.deepEqual(result.outcomes.map(one => one.ok), [false, false]);
  }],

  ['the facade reports a timeout with one outcome per check', async () => {
    const box = createSandbox();
    const sandbox = box.api.create({});
    const checks = [
      { kind: 'assert_python', code: 'assert True', weight: 1 },
      { kind: 'stdout_contains', value: 'never', weight: 1 },
    ];
    const settled = sandbox.run({ code: 'while True:\n    pass\n', checks, timeoutMs: 20 });
    await settle();
    const { data, worker: posted } = box.take();
    // The runtime is up: the worker said so, so the LEARNER's clock is running.
    posted.emit('message', { data: { type: 'loading', nonce: data.nonce } });
    const result = await settled;
    assert.equal(result.ok, false);
    assert.equal(result.reason, box.api.SandboxOutcome.TIMEOUT);
    assert.match(result.error, /运行超时/);
    assert.ok(!/下载/.test(result.error),
      'a learner told to check for dead loops must not also be told it was a download');
    assert.equal(result.outcomes.length, checks.length, 'a timeout must not truncate outcomes');
    assert.deepEqual(result.outcomes.map(one => one.ok), [false, false]);
    assert.equal(box.spawned[0].terminated, true, 'a hung worker must be terminated');
  }],

  ['a runtime that never answers reports a DOWNLOAD timeout, not a dead loop', async () => {
    // The 13 MB download must not be charged to the 15-second execution
    // budget: on a slow connection the learner had not started running, and
    // telling them to look for an infinite loop sent them the wrong way.
    const box = createSandbox();
    const phases = [];
    const sandbox = box.api.create({
      loadTimeoutMs: 25,
      timeoutMs: 20,
      onPhase: event => phases.push(event.phase),
    });
    const checks = [{ kind: 'assert_python', code: 'assert True', weight: 1 }];
    const settled = sandbox.run({ code: 'pass\n', checks });
    await settle();
    box.take();  // never answers
    const result = await settled;
    assert.equal(result.ok, false);
    assert.equal(result.reason, box.api.SandboxOutcome.LOAD_TIMEOUT);
    assert.match(result.error, /运行环境下载超时/);
    assert.ok(!/死循环/.test(result.error), 'the download failure must not blame the learner code');
    assert.equal(result.outcomes.length, checks.length);
    assert.equal(box.spawned[0].terminated, true);
    assert.deepEqual(phases, ['load_timeout'], 'the UI hook must learn why the run ended');
  }],

  ['the download timeout is not charged to the execution budget', async () => {
    // The two clocks must not share a deadline. With a 500 ms load budget and a
    // 120 ms run budget, a runtime that announces itself after 200 ms has to be
    // believed -- under a single shared clock that run would already be dead --
    // and the run budget must then start from the announcement.
    const box = createSandbox();
    const sandbox = box.api.create({ loadTimeoutMs: 500, timeoutMs: 120 });
    const settled = sandbox.run({ code: 'pass\n', checks: [] });
    await settle();
    const { data, worker: posted } = box.take();
    await new Promise(resolve => setTimeout(resolve, 200));
    posted.emit('message', { data: { type: 'loading', nonce: data.nonce } });
    await new Promise(resolve => setTimeout(resolve, 40));
    posted.emit('message', {
      data: { type: 'result', nonce: data.nonce, ok: true, stdout: 'done\n', outcomes: [], ms: 1 },
    });
    const result = await settled;
    assert.equal(result.ok, true, 'the run must complete inside the execution budget');
    assert.equal(result.stdout, 'done\n');
  }],

  ['the facade reports a crash with one outcome per check', async () => {
    const box = createSandbox();
    const sandbox = box.api.create({});
    const checks = [{ kind: 'var_equals', name: 'x', value: 1, weight: 1 }];
    const settled = sandbox.run({ code: 'x = 1\n', checks });
    await settle();
    box.take().worker.emit('error', { message: 'worker exploded' });
    const result = await settled;
    assert.equal(result.ok, false);
    assert.equal(result.reason, box.api.SandboxOutcome.CRASH);
    assert.equal(result.error, 'worker exploded');
    assert.equal(result.outcomes.length, checks.length);
    assert.equal(box.spawned[0].terminated, true);
    assert.equal(sandbox.busy, false, 'a crashed worker must not stay busy');
  }],

  ['overlapping runs queue instead of sharing one Python session', async () => {
    const box = createSandbox();
    const sandbox = box.api.create({});
    const first = sandbox.run({ code: 'print("first")\n', checks: [] });
    const second = sandbox.run({ code: 'print("second")\n', checks: [] });
    await settle();
    assert.equal(box.peek(), 1, 'the second run must wait for the first to finish');
    const one = box.take();
    one.worker.emit('message', { data: { type: 'result', nonce: one.data.nonce, ok: true, stdout: 'first\n', outcomes: [], ms: 1 } });
    assert.equal((await first).stdout, 'first\n');
    await settle();
    assert.equal(box.peek(), 1, 'the queued run must start once the first finished');
    const two = box.take();
    assert.equal(two.data.code, 'print("second")\n');
    two.worker.emit('message', { data: { type: 'result', nonce: two.data.nonce, ok: true, stdout: 'second\n', outcomes: [], ms: 1 } });
    assert.equal((await second).stdout, 'second\n');
  }],

  ['preload spawns a worker without running code, destroy releases it', async () => {
    const box = createSandbox();
    const sandbox = box.api.create({ workerUrl: 'assets/exercise-worker.js' });
    assert.equal(sandbox.busy, false);
    await sandbox.preload();
    assert.equal(box.spawned.length, 1);
    assert.equal(box.spawned[0].url, 'assets/exercise-worker.js');
    assert.equal(box.peek(), 0, 'preload must not execute anything');
    assert.equal(sandbox.busy, true);
    sandbox.destroy();
    assert.equal(box.spawned[0].terminated, true);
    assert.equal(sandbox.busy, false);
  }],
  ['the facade exports the outcome constants its callers branch on', async () => {
    const box = createSandbox();
    const { SandboxOutcome, DEFAULT_TIMEOUT, DEFAULT_LOAD_TIMEOUT } = box.api;
    assert.equal(SandboxOutcome.TIMEOUT, 'timeout');
    assert.equal(SandboxOutcome.LOAD_TIMEOUT, 'load_timeout');
    assert.equal(SandboxOutcome.CRASH, 'crash');
    assert.equal(SandboxOutcome.WORKER_ERROR, 'worker_error');
    assert.ok(Object.isFrozen(SandboxOutcome), 'callers must not be able to rewrite the contract');
    assert.equal(DEFAULT_TIMEOUT, 15000);
    // The download budget has to be meaningfully larger than the run budget,
    // or splitting the two clocks achieves nothing.
    assert.ok(DEFAULT_LOAD_TIMEOUT > DEFAULT_TIMEOUT * 2,
      `load budget ${DEFAULT_LOAD_TIMEOUT} must dwarf the run budget ${DEFAULT_TIMEOUT}`);
  }],
];

async function main() {
  let failures = 0;
  console.log('ExerciseWorker');
  for (const [name, fn] of CASES) {
    try {
      await fn();
      console.log(`  ok  ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`  FAIL ${name}\n       ${error.message}`);
    }
  }
  // The shared interpreter is a real child process; without this the run would
  // print PASS and then hang forever.
  host.close();
  if (failures) {
    console.error(`\n${failures} failing`);
    process.exit(1);
  }
  console.log('\nPASS: exercise worker agrees with the corpus harness');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
