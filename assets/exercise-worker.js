/* Pyodide sandbox worker. Runs learner code and evaluates checks inside one
   Python session so a check can see variables the learner's code defined.
   Pyodide ships without network, filesystem writes and subprocesses, which is
   exactly the boundary we want. */
'use strict';

let runtime = null;
let loading = null;

function reply(message) { self.postMessage(message); }

async function ensureRuntime() {
  if (runtime) return runtime;
  if (!loading) {
    loading = (async () => {
      importScripts('./vendor/pyodide/pyodide.js');
      return loadPyodide({ indexURL: './vendor/pyodide/' });
    })().catch(failure => {
      // Drop the cached rejection: a learner's first run must not be the one
      // that pays for a flaky download, and every later run retries.
      loading = null;
      throw failure;
    });
  }
  runtime = await loading;
  return runtime;
}

/* Last non-empty line of a traceback — the assertion message a learner sees. */
function lastLine(value) {
  const lines = String(value || '').trim().split('\n');
  return lines[lines.length - 1] || '';
}

function runUserCode(code) {
  return `
# One worker keeps ONE interpreter for many runs, so anything the previous run
# left in globals() would still be visible here and a stale variable could pass
# a check the learner never satisfied this time. Clear the learner's names
# first: underscored names are the interpreter's and ours (__sils_*). This runs
# BEFORE the imports below, which it would otherwise delete along with them.
for _sils_key in [_sils_k for _sils_k in list(globals()) if not _sils_k.startswith('_')]:
    del globals()[_sils_key]
import io, contextlib, traceback
_out = io.StringIO()
_err = None
_ok = True
try:
    with contextlib.redirect_stdout(_out), contextlib.redirect_stderr(_out):
        exec(compile(${JSON.stringify(code)}, '<exercise>', 'exec'), globals())
except BaseException:
    _ok = False
    _err = traceback.format_exc(limit=8)
__sils_stdout = _out.getvalue()
__sils_error = _err
__sils_ok = _ok
`;
}

function runAssert(statement) {
  return `
import traceback
__sils_assert_ok = True
__sils_assert_detail = ''
try:
    exec(compile(${JSON.stringify(statement)}, '<check>', 'exec'), globals())
except BaseException:
    __sils_assert_ok = False
    __sils_assert_detail = traceback.format_exc(limit=3)
`;
}

function readVariable(name) {
  // The name is a Python string LITERAL, not a bare identifier: `name in
  // globals()` would raise NameError on every var_equals / var_in_range check
  // and take the whole run down with it.
  return `
__sils_found = ${JSON.stringify(name)} in globals()
__sils_value = globals().get(${JSON.stringify(name)})
`;
}

function evaluateSandboxChecks(pyodide, checks) {
  return checks.map(check => {
    if (check.kind === 'assert_python') {
      pyodide.runPython(runAssert(check.code));
      const ok = pyodide.globals.get('__sils_assert_ok') === true;
      const detail = ok ? '' : lastLine(pyodide.globals.get('__sils_assert_detail'));
      return { ok, detail };
    }
    if (check.kind === 'var_equals') {
      pyodide.runPython(readVariable(check.name));
      const found = pyodide.globals.get('__sils_found') === true;
      const value = found ? pyodide.globals.get('__sils_value') : undefined;
      return { ok: found && value === check.value, detail: found ? `got ${JSON.stringify(value)}` : `${check.name} was never assigned` };
    }
    if (check.kind === 'var_in_range') {
      pyodide.runPython(readVariable(check.name));
      const found = pyodide.globals.get('__sils_found') === true;
      const value = found ? Number(pyodide.globals.get('__sils_value')) : NaN;
      const ok = found && Number.isFinite(value) && value >= check.min && value <= check.max;
      return { ok, detail: found ? `got ${value}` : `${check.name} was never assigned` };
    }
    return null;
  });
}

function evaluateHostChecks(checks, stdout, answer) {
  return checks.map(check => {
    if (check.kind === 'stdout_contains') {
      const ok = stdout.includes(check.value);
      return { ok, detail: ok ? '' : `output does not contain ${JSON.stringify(check.value)}` };
    }
    if (check.kind === 'stdout_equals') {
      const actual = stdout.trim();
      const ok = actual === String(check.value).trim();
      return { ok, detail: ok ? '' : `output was ${JSON.stringify(actual)}` };
    }
    if (check.kind === 'stdout_matches') {
      const ok = new RegExp(check.pattern).test(stdout);
      return { ok, detail: ok ? '' : 'output did not match the expected shape' };
    }
    if (check.kind === 'output_choice') {
      const chosen = Array.isArray(answer) ? answer.slice().sort() : [];
      const expected = check.correct.slice().sort();
      const ok = chosen.length === expected.length && chosen.every((value, index) => value === expected[index]);
      return { ok, detail: `selected ${JSON.stringify(chosen)}` };
    }
    return null;
  });
}

const SANDBOX_KINDS = ['assert_python', 'var_equals', 'var_in_range'];

self.addEventListener('message', async event => {
  const request = event.data || {};
  if (request.type !== 'run') return;
  const started = Date.now();
  const checks = Array.isArray(request.checks) ? request.checks : [];
  try {
    const pyodide = await ensureRuntime();
    pyodide.runPython(runUserCode(request.code || ''));
    const ok = pyodide.globals.get('__sils_ok') !== false;
    const stdout = String(pyodide.globals.get('__sils_stdout') || '');
    const error = pyodide.globals.get('__sils_error') ? String(pyodide.globals.get('__sils_error')) : '';
    // Both evaluators return one slot per check so the two arrays stay aligned
    // by index; a mismatch here would silently mislabel which assertion failed.
    const sandboxOutcomes = ok ? evaluateSandboxChecks(pyodide, checks) : checks.map(() => null);
    const hostOutcomes = evaluateHostChecks(checks, stdout, request.answer);
    const outcomes = checks.map((check, index) => {
      const own = SANDBOX_KINDS.includes(check.kind) ? sandboxOutcomes[index] : hostOutcomes[index];
      return own || { ok: false, detail: ok ? 'not evaluated' : 'code did not run' };
    });
    reply({
      type: 'result', ok, stdout, error, outcomes, ms: Date.now() - started,
    });
  } catch (failure) {
    // Still one slot per check: the grader reads outcomes by index, so a short
    // array would mislabel every check after the real fault.
    reply({
      type: 'result', ok: false, stdout: '', error: String(failure && failure.message || failure),
      outcomes: checks.map(() => ({ ok: false, detail: 'the sandbox runtime failed' })),
      ms: Date.now() - started,
    });
  }
});
