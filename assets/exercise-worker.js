/* Pyodide sandbox worker. Runs learner code and evaluates checks inside one
   Python session so a check can see variables the learner's code defined.

   WHAT THE BOUNDARY ACTUALLY IS
   =============================
   Learner code runs in the learner's own browser, on their own machine. There
   is no server-side execution of exercise code anywhere in this product. What
   follows is what this worker adds on top of that, written as facts rather than
   as reassurance:

   * Pyodide runs Python inside WebAssembly. The standard library it ships has
     no real sockets, no subprocess spawning and no ctypes FFI, so
     `subprocess.run` and `ctypes.CDLL` cannot reach the host even though the
     module may be importable.

   * The `js` module is the bridge from Python to JavaScript globals, and it IS
     reachable by default: an unhardened Pyodide lets `import js; js.eval(...)`
     and `js.fetch(...)` run. So it is sealed off explicitly -- `js` and
     `pyodide_js` are removed and a meta_path finder makes `import js` raise
     ImportError. Without this the sandbox was fully escapable.

   * After Pyodide has loaded, this worker's globals lose `fetch`,
     `XMLHttpRequest`, `WebSocket` and `importScripts`, so even a Python-side
     path that reached JavaScript would find no network primitive to call.

   * MEMFS is writable: `open('/tmp/x', 'w')` works. The filesystem is in
     memory inside the worker and is destroyed with the worker, so nothing
     reaches the learner's real disk or the host. There is no NODEFS mount, so
     `/etc/passwd` and the rest of the host filesystem are not there.

   Learner code still reaches: the full CPU-bound Python standard library it
   shipped with, the clock, and unbounded memory and CPU (which is why the
   main thread enforces a wall-clock timeout and terminates the worker). */
'use strict';

let runtime = null;
let loading = null;

/* Worker globals Pyodide still needs while it boots, and that must not survive
   the boot. Sealing importScripts before loadPyodide would stop Pyodide from
   ever loading its own wasm glue module. */
const NETWORK_GLOBALS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'importScripts'];

function reply(message) { self.postMessage(message); }

/* A poison pill rather than `undefined`: whatever reaches it gets a function
   that throws, not a silent no-op that looks like it worked. */
function sealNetwork() {
  const denied = name => function () {
    throw new Error(`${name} is disabled inside the exercise sandbox: exercises run offline`);
  };
  for (const name of NETWORK_GLOBALS) {
    try { self[name] = denied(name); } catch (failure) { /* frozen global: leave it */ }
  }
}

async function ensureRuntime() {
  if (runtime) return runtime;
  if (!loading) {
    loading = (async () => {
      importScripts('./vendor/pyodide/pyodide.js');
      return loadPyodide({ indexURL: './vendor/pyodide/' });
    })().then(instance => {
      // Only now. loadPyodide needs importScripts to load pyodide.asm.js, and
      // fetch to read pyodide.asm.wasm, so sealing has to come after the boot.
      sealNetwork();
      return instance;
    }).catch(failure => {
      // Drop the cached rejection: a learner's first run must not be the one
      // that pays for a flaky download, and every later run retries.
      loading = null;
      throw failure;
    });
  }
  runtime = await loading;
  return runtime;
}

/* Removes the JavaScript bridge from the running interpreter.

   Python lets any code assign sys.meta_path, clear it, or remove entries, so a
   plain finder is not a boundary — `sys.meta_path.clear()` walks straight past
   it. Two defences: the meta_path is a list subclass that puts the guard back
   before every import and refuses removal, and the seal is re-applied before
   every run, so a learner who disarms it cannot disarm the NEXT one either.

   The guard lives in its OWN globals dict, never in the namespace learner code
   runs in. An earlier draft installed it into globals() behind a `_sils_`
   prefix, which learner code can overwrite: `_sils_seal = 1` would shadow the
   real function and the next run would call a number. Names in a private dict
   are unreachable from the learner's exec.

   Class bodies mangle __double__ leading names into _ClassName__double__, so
   the helpers here use a single leading underscore. */
function sealBridge() {
  return `
import sys as _sils_sys
import json as _sils_json

_sils_BLOCKED = frozenset(('js', 'pyodide_js'))
# The interpreter's own import finders, captured once. Every rebuild restores
# from this list, so a learner cannot make the import system unusable by
# clearing it -- they can only ever end up back here.
_sils_ORIGINAL = tuple(getattr(_sils_sys, 'meta_path', ()))

class _sils_SealedImport:
    """Refuses to resolve the JS bridge: \`import js\` raises ImportError."""
    def find_spec(self, name, target=None, path=None):
        if name.split('.')[0] in _sils_BLOCKED:
            raise ImportError(
                "No module named %r: the JavaScript bridge is sealed off inside "
                "the exercise sandbox." % name)
        return None
    def find_module(self, name, path=None):
        return None
    def invalidate_caches(self):
        return None

class _sils_SealedMetaPath(list):
    """A sys.meta_path that survives being emptied, cleared or replaced.

    The mutators are where this earns its keep. sys.meta_path is an ordinary
    list that any code can clear, and a list that has been cleared no longer
    holds the path finders -- so simply refusing clear() would leave a learner
    who assigned sys.meta_path = [] permanently unable to import anything.
    Instead every mutator restores the pristine finders and puts the guard on
    top, so the only two states reachable from outside are "sealed" and
    "unsealed but intact", never "gutted".
    """
    def _restore(self):
        # list.clear + list.extend, bypassing this class's own mutators.
        list.clear(self)
        for _item in _sils_ORIGINAL:
            list.append(self, _item)
        list.insert(self, 0, _sils_SealedImport())
        return list.__iter__(self)

    def _kept(self):
        for _item in list.__iter__(self):
            if isinstance(_item, _sils_SealedImport):
                break
        else:
            return self._restore()
        # A finders-only list means something removed them without going
        # through a mutator; put the originals back.
        if len(list(list.__iter__(self))) < len(_sils_ORIGINAL) + 1:
            return self._restore()
        return list.__iter__(self)

    def __iter__(self):
        return self._kept()
    def __len__(self):
        return sum(1 for _ in self._kept())
    def __getitem__(self, index):
        return list(self._kept())[index]
    def __repr__(self):
        return list.__repr__(self)
    def remove(self, item):
        list.remove(self, item)
        self._restore()
    def pop(self, *args):
        value = list.pop(self, *args)
        self._restore()
        return value
    def clear(self):
        self._restore()
    def append(self, item):
        list.append(self, item)
    def insert(self, index, item):
        list.insert(self, index, item)
    def extend(self, items):
        list.extend(self, items)
    def __setitem__(self, index, value):
        list.__setitem__(self, index, value)
        self._restore()
    def __delitem__(self, index):
        list.__delitem__(self, index)
        self._restore()
    def __iadd__(self, other):
        list.extend(self, other)
        return self

def _sils_seal():
    """Idempotent. Runs once after boot and again before every learner run.

    Rebuilding from _sils_ORIGINAL rather than from whatever sys.meta_path
    happens to hold is the whole trick. Learner code can assign
    sys.meta_path = []; a seal that re-wrapped THAT would end up guarding an
    empty list, and from then on every pure-Python stdlib import would fail
    for the rest of the session with no way for the learner to tell why.
    """
    _sils_sys.meta_path = _sils_SealedMetaPath(_sils_ORIGINAL)
    for name in [n for n in list(_sils_sys.modules) if n.split('.')[0] in _sils_BLOCKED]:
        del _sils_sys.modules[name]
    try:
        import pyodide.code as bridge
        if hasattr(bridge, 'eval_js'):
            del bridge.eval_js
    except BaseException:
        pass

def _sils_capture(target):
    """Snapshot the learner's globals for the result's \`values\` field.

    Anything that cannot cross into JSON is reported by type name, so the
    caller can tell "this is text, not a number" from "this was never set"
    instead of both arriving as null.
    """
    out = {}
    for key, value in list(target.items()):
        if key.startswith('__sils_') or key.startswith('_sils_'):
            continue
        if value is None or isinstance(value, (bool, int, float, str)):
            out[key] = value
        elif isinstance(value, (list, tuple, dict)):
            try:
                _sils_json.dumps(value)
                out[key] = list(value) if isinstance(value, tuple) else value
            except (TypeError, ValueError):
                out[key] = {'__type__': type(value).__name__}
        else:
            out[key] = {'__type__': type(value).__name__}
    return out

_sils_seal()
`;
}

/* Installs the guard into a private namespace the learner cannot see. Returns
   that namespace so later calls can re-arm the seal without re-defining it.
   The namespace must be a Python dict, not a JS object: runPython resolves
   `globals` by looking it up in Python, and a JS object arrives as undefined. */
function ensureSealed(pyodide) {
  if (pyodide.silsGuard) return pyodide.silsGuard;
  const namespace = pyodide.globals.get('dict')();
  pyodide.runPython(sealBridge(), { globals: namespace });
  pyodide.silsGuard = namespace;
  return namespace;
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
# first. This runs BEFORE the imports below, which it would otherwise delete
# along with them, and it deletes EVERY name except this worker's own __sils_*
# slots -- an earlier version kept anything starting with '_', so a learner who
# wrote _total = 5 still had it on the next run and could pass a check they had
# stopped satisfying.
_sils_drop = [k for k in list(globals()) if not k.startswith('__sils_')]
for _sils_key in _sils_drop:
    del globals()[_sils_key]
# pop, not del: the comprehension above also captured these two names, so a
# plain del would raise NameError on a run that found nothing to clean.
globals().pop('_sils_drop', None)
globals().pop('_sils_key', None)
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
  // Echoed verbatim in the reply. The main thread drops any result whose nonce
  // is not the one it minted for this run, so learner code that somehow reaches
  // postMessage cannot forge a passing result.
  const nonce = request.nonce || null;
  try {
    // Started before the await so the main thread learns the download is under
    // way. Without it the facade cannot tell a slow first run from an infinite
    // loop, and charges the 13 MB to the learner's execution budget.
    const ready = runtime ? Promise.resolve(runtime) : ensureRuntime();
    reply({ type: 'loading', nonce });
    const pyodide = await ready;
    const guard = ensureSealed(pyodide);
    // Re-arm before every run: learner code can strip sys.meta_path, and the
    // NEXT run has to still be sealed. `globals` is the private guard
    // namespace, which learner code cannot reach or shadow.
    pyodide.runPython('_sils_seal()', { globals: guard });
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
      type: 'result', nonce, ok, stdout, error, outcomes, ms: Date.now() - started,
    });
  } catch (failure) {
    // Still one slot per check: the grader reads outcomes by index, so a short
    // array would mislabel every check after the real fault.
    reply({
      type: 'result', nonce, ok: false, stdout: '', error: String(failure && failure.message || failure),
      outcomes: checks.map(() => ({ ok: false, detail: 'the sandbox runtime failed' })),
      ms: Date.now() - started,
    });
  }
});
