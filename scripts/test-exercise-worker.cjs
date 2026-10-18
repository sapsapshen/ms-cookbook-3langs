'use strict';
/* Parity harness for assets/exercise-worker.js.

   The worker cannot run in node (importScripts, Worker), but its Python half is
   what decides a learner's grade, so this file loads the REAL worker source into
   a vm context with a fake `self` and a fake Pyodide, and drives real CPython
   behind that fake. Nothing is copied out of the worker: a bug in the shipped
   file fails here.

   The fake Pyodide is faithful on the one point that matters — `runPython` is
   SYNCHRONOUS and `globals.get()` sees what it just wrote, exactly like the real
   one. That is achieved by replaying the request's Python snippets from a clean
   interpreter on every read: the worker only reads globals right after a
   runPython, so replaying the accumulated snippets in order reproduces the
   state a persistent session would hold, with no cross-request leakage.

   Verdicts are then compared against scripts/check_exercise_references.py, the
   harness the corpus is proved against, so "the worker and the harness agree" is
   measured rather than asserted.

   Usage:  node scripts/test-exercise-worker.cjs
*/
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WORKER = path.join(ROOT, 'assets/exercise-worker.js');
const VENV_PYTHON = path.join(ROOT, '.venv/Scripts/python.exe');
const PYTHON = process.env.PYTHON || (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python');

// Executes a request's snippets in one throwaway interpreter and reports the
// seven __sils_* globals plus any exception that escaped a snippet.
const DRIVER = `
import json, sys, traceback

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

request = json.loads(sys.stdin.read())
session, error = {}, None
try:
    for code in request['codes']:
        exec(compile(code, '<exercise>', 'exec'), session)
except BaseException:
    error = traceback.format_exc(limit=8)
print(json.dumps({'error': error,
                  'values': {name: encode(session.get(name)) for name in NAMES}}))
`;

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

function createWorkerHost(override) {
  const source = override || fs.readFileSync(WORKER, 'utf8');
  let handler = null;
  let codes = [];
  let snapshot = {};
  const replies = [];
  const imported = [];

  function flush() {
    const result = python(DRIVER, { codes: codes.slice() });
    if (result.error) {
      const lines = String(result.error).trim().split('\n');
      throw new Error(lines[lines.length - 1] || 'python snippet failed');
    }
    snapshot = result.values;
  }

  function makeRuntime() {
    return {
      globals: {
        get(name) {
          return Object.prototype.hasOwnProperty.call(snapshot, name) ? snapshot[name] : undefined;
        },
      },
      runPython(code) { codes.push(code); flush(); },
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
    async run(request) {
      codes = [];
      snapshot = {};
      replies.length = 0;
      await handler({ data: Object.assign({ type: 'run' }, request) });
      assert.equal(replies.length, 1, 'the worker must post exactly one reply per run');
      return replies[0];
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
  const context = { module, exports: module.exports, Worker: FakeWorker, setTimeout, clearTimeout };
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
    const broken = fs.readFileSync(WORKER, 'utf8').replace(
      'const pyodide = await ensureRuntime();',
      'throw new Error("runtime exploded");');
    assert.notEqual(broken, fs.readFileSync(WORKER, 'utf8'), 'the mutation must apply');
    const crashed = createWorkerHost(broken);
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

    // Straight through the real worker, then back into the facade.
    const reply = await host.run(data);
    posted.emit('message', { data: reply });
    const result = await settled;
    assert.equal(result.ok, true);
    assert.equal(result.stdout, 'hi\n');
    assert.deepEqual(result.outcomes, reply.outcomes);
    assert.equal(result.reason, undefined);
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
    box.take();
    const result = await settled;
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'timeout');
    assert.match(result.error, /运行超时/);
    assert.equal(result.outcomes.length, checks.length, 'a timeout must not truncate outcomes');
    assert.deepEqual(result.outcomes.map(one => one.ok), [false, false]);
    assert.equal(box.spawned[0].terminated, true, 'a hung worker must be terminated');
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
    assert.equal(result.reason, 'crash');
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
    one.worker.emit('message', { data: { type: 'result', ok: true, stdout: 'first\n', outcomes: [], ms: 1 } });
    assert.equal((await first).stdout, 'first\n');
    await settle();
    assert.equal(box.peek(), 1, 'the queued run must start once the first finished');
    const two = box.take();
    assert.equal(two.data.code, 'print("second")\n');
    two.worker.emit('message', { data: { type: 'result', ok: true, stdout: 'second\n', outcomes: [], ms: 1 } });
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
