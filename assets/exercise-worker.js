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
     module may be importable. `socket.getaddrinfo` DOES still resolve names
     (Pyodide proxies it to WASI); connecting does not work. There is no
     syscall isolation here beyond that -- WebAssembly has no user/kernel split
     to hide behind, and the guarantee rests on Pyodide's own shims, not on a
     boundary this worker builds.

   * There are TWO independent doors to JavaScript, and both are sealed:

       (a) THE IMPORT PATH. `js` is the bridge to the JavaScript globals and it
           IS reachable by default: an unhardened Pyodide lets
           `import js; js.eval(...)` and `js.fetch(...)` run.

       (b) THE PROXY FACTORY. Sealing `js` alone is not enough, because
           `pyodide.ffi.create_proxy` hands out a Python proxy that wraps a live
           JavaScript object, and `.constructor.constructor` is JS's `Function`:

               import pyodide.ffi as f
               f.create_proxy(1).constructor.constructor("return 6*7")()   # -> 42

           That path touches neither `js` nor sys.meta_path, so (a) does
           nothing for it. `pyodide.ffi` is removed along with every other route
           to the same functions (`_pyodide_core`, `_pyodide._core_docs`,
           `pyodide.code`), and a re-import fails too.

     In a real browser Worker `self` IS the WorkerGlobalScope, so (a) would also
     hand over `postMessage` -- enough to forge a perfect result. The nonce in
     the message protocol is the second line of defence against exactly that.

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

   WHAT THE SEAL ACTUALLY COVERS, AND WHY IT IS BUILT IN LAYERS
   ==============================================================
   There are two INDEPENDENT ways out of this sandbox, and they need different
   fixes. Confusing them is how the previous rounds of comments went wrong, so
   they are named separately here:

     (1) THE IMPORT PATH. `import js` hands learner code the WorkerGlobalScope.
         Sealed by removing every finder that can resolve a bridge name from the
         baseline that sys.meta_path is rebuilt from, plus a finder that refuses
         the sealed names outright.

     (2) THE PROXY FACTORY. Even with the import path sealed, Pyodide ships a
         second, completely independent door:

             import pyodide.ffi as f
             f.create_proxy(1).constructor.constructor("return 6*7")()   # -> 42

         create_proxy returns a PyProxy; `.constructor` is JS's Function
         constructor; `.constructor.constructor` is Function again. That reaches
         arbitrary JavaScript WITHOUT touching `js` and WITHOUT touching
         sys.meta_path, so fix (1) does nothing for it. Verified against the
         vendored Pyodide 0.26.4 -- it runs today, on the shipped worker.

         Every route into that factory is sealed below. `pyodide.ffi` is only the
         public face of it; the same functions are reachable as
         `_pyodide_core.create_proxy` (the native module), as
         `_pyodide._core_docs.create_proxy`, and via `pyodide.code.eval_js`.

   THE TWO LAYERS OF THE IMPORT-PATH SEAL, AND WHICH ONE CARRIES THE LOAD
   ====================================================================
   Both layers are kept because each one closes a route the other does not, and
   each is locked by its own mutation test. Measured, not assumed:

     LAYER A -- the baseline filter. _sils_ORIGINAL is captured with every
     bridge-serving finder already removed, so sys.meta_path is rebuilt from a
     list that cannot resolve `js` at all. What it stops on its own:

         st.jsfinder.jsproxies['js'] = ...          # refill the live table
         sys.meta_path = [f for f in sys.meta_path
                          if type(f).__name__ != '_sils_SealedImport']
         import js                                  # -> ESCAPES without layer A

     The guard list is not what stops that. `sys.meta_path = ...` reassigns an
     attribute of the `sys` module and so reaches NO list mutator at all: a
     guard list subclass can only intercept clear() / remove() / pop() /
     __setitem__ / __delitem__ on ITSELF. An earlier version kept Pyodide's own
     JS finder in sys.meta_path and relied on the guard; that does not hold.

     LAYER B -- pinning the bridge table. The live singleton at
     pyodide._state.jsfinder is reachable as an ordinary Python attribute, and
     its `jsproxies` dict is an ordinary mutable dict. Dropping the finder from
     the list HIDES it; it does not remove it. So the table is emptied, the
     emptied dict is hardened against refilling, and the pin is put on the
     JsFinder CLASS, so a freshly constructed JsFinder is pinned too.

     What layer B stops on its own (measured on the previous implementation,
     where layer B only emptied finders visible on sys.meta_path):

         run 1:  st.jsfinder.jsproxies['js'] = 'anything'
         run 2:  import sys, pyodide._state as st
                 sys.meta_path = [st.jsfinder]
                 import js                          # -> ESCAPED without layer B

     Learner code runs BETWEEN runs, so the object it dirtied in run 1 was
     still live in run 2. That is the bug layer B exists to close, and it is why
     the pin is re-applied before every run rather than only at boot.

   The guard class stays as defence in depth -- it still catches clear() and
   friends -- and the seal is re-applied before every run, so a learner who
   disarms one run cannot disarm the NEXT one either.

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

# THE BRIDGE NAMES: what a meta_path finder could be asked to resolve. This set
# is deliberately narrow. It is fed to _sils_serves_bridge, which asks EVERY
# finder whether it can serve the name, and a wider set would delete ordinary
# finders from the baseline. Measured: PathFinder answers "yes, I can find
# pyodide.code" (it is a file in the zip), so putting pyodide.code in HERE would
# drop PathFinder and break every pure-Python stdlib import for the session.
_sils_BRIDGE = frozenset(('js', 'pyodide_js'))

# THE SEALED NAMES: everything the import seal must refuse. This is the union of
# the bridge and every route to the proxy factory that was measured reachable.
#   js / pyodide_js      the bridge itself
#   pyodide.ffi          the documented, public face of create_proxy
#   _pyodide_core        the NATIVE module; create_proxy lives here, and it is
#                        importable on its own with no pyodide.* involved
#   _pyodide._core_docs  create_proxy / to_js / JsProxy, reachable directly and
#                        not merely through pyodide.ffi
#   pyodide.code         eval_js / run_js
#   pyodide.webloop      the WebLoop, which is built out of JS callbacks
_sils_BLOCKED = _sils_BRIDGE | frozenset((
    'pyodide.ffi', '_pyodide_core', '_pyodide._core_docs',
    'pyodide.code', 'pyodide.webloop',
))

def _sils_sealed(_sils_name):
    """True when this module name, or anything under it, must not import.

    Matched on dotted PREFIX, not on the first component: sealing pyodide.ffi
    has to seal pyodide.ffi.JsProxy too, and the first component of both is
    'pyodide' -- which must stay importable, or Pyodide's own internals break.
    """
    for _sils_entry in _sils_BLOCKED:
        if _sils_name == _sils_entry or _sils_name.startswith(_sils_entry + '.'):
            return True
    return False

def _sils_serves_bridge(_sils_finder):
    """True when this meta_path entry can resolve one of the bridge modules.

    ASKED OF THE FINDER rather than read off its class name. Pyodide could
    rename the class, wrap it, or hand the bridge to a different finder, and a
    name-based filter would then quietly stop matching while still reporting
    a sealed import path. The probe is literally the call the import system
    makes, so it keeps working when the name does not.

    The class-name check is the fallback for a finder that cannot answer the
    probe. Erring towards "drop it" is the safe direction: the guard class is
    inserted on top of whatever survives, and the standard-library finders all
    answer the probe cleanly, so the fallback never has to fire for them.

    Note this probes _sils_BRIDGE, not _sils_BLOCKED -- see the comment on
    _sils_BRIDGE for why widening it would be a self-inflicted outage.
    """
    for _sils_name in _sils_BRIDGE:
        try:
            if _sils_finder.find_spec(_sils_name, None) is not None:
                return True
        except BaseException:
            if type(_sils_finder).__name__ == 'JsFinder':
                return True
    return False

class _sils_SealedBridgeTable(dict):
    """The bridge table, permanently empty, refusing to be refilled.

    A dict subclass rather than a plain dict because \`table['js'] = x\`,
    \`table.update(...)\`, \`table.setdefault(...)\` and \`|= \` are all separate
    routes in, and overriding only __setitem__ would leave the other three open.

    Deletions are deliberately ALLOWED. \`del table[k]\`, pop() and clear() can
    only ever empty it further, and Pyodide's own unregister_js_module() is a
    deletion -- refusing it would make the seal's own best-effort cleanup throw
    on every run.
    """
    def _sils_deny(self, *_sils_args, **_sils_kwargs):
        raise ImportError(
            "the JavaScript bridge is sealed off inside the exercise sandbox")
    __setitem__ = _sils_deny
    update = _sils_deny
    setdefault = _sils_deny
    def __ior__(self, _sils_other):
        return self._sils_deny()

_sils_TABLE = _sils_SealedBridgeTable()

def _sils_empty_bridge(_sils_finder):
    """Take the bridge away from one finder, for good.

    Dropping the finder out of sys.meta_path is necessary but NOT sufficient,
    and the reason is worth writing down because it is easy to get wrong:

        import sys, pyodide._state as st
        sys.meta_path.append(st.jsfinder)   # the live finder, still holding js
        import js                            # -> works again

    Pyodide keeps a module-level singleton at pyodide._state.jsfinder with 'js'
    and 'pyodide_js' in its 'jsproxies' table. It is an ordinary Python
    attribute, reachable from learner code, so removing the finder from the
    list only hides it.

    So this does two things, in this order, and the order is load-bearing:

      1. unregister_js_module() empties the ORIGINAL dict;
      2. the instance attribute is dropped and the pin moves onto the JsFinder
         CLASS, so the finder resolves through an empty table no matter who
         holds it, including a JsFinder() the learner constructs themselves.

    Step 2 is not cosmetic. A bare class-level swap still leaves the pre-seal
    table sitting in the instance __dict__ under the same name:

        st.jsfinder.__dict__['jsproxies']   # -> {'js': [object global], ...}

    which hands the live global straight back. Measured, not hypothetical.

    Note what is NOT here: hardening the emptied dict in place. It was tried,
    and a mutation test showed the suite stayed green without it -- the pop plus
    the class pin already leave nothing reachable -- so it was removed rather
    than kept as decoration. See the report.

    Best effort by design: a future Pyodide may rename the singleton or the
    method, and failing to pin must not stop the rest of the seal from applying.
    """
    try:
        _sils_live = _sils_finder.__dict__.get('jsproxies')
    except BaseException:
        _sils_live = None
    if isinstance(_sils_live, dict):
        for _sils_name in tuple(_sils_live):
            if _sils_name.split('.')[0] in _sils_BRIDGE:
                try:
                    del _sils_live[_sils_name]
                except BaseException:
                    pass
    # The instance attribute goes: the CLASS pin below is what the finder reads
    # now, and leaving the old dict reachable through __dict__ would hand the
    # pre-seal contents to anyone who looks.
    try:
        _sils_finder.__dict__.pop('jsproxies', None)
    except BaseException:
        pass
    for _sils_name in tuple(_sils_BRIDGE):
        try:
            _sils_finder.unregister_js_module(_sils_name)
        except BaseException:
            pass
    try:
        _sils_finder.invalidate_caches()
    except BaseException:
        pass

def _sils_pin_bridge():
    """Empty and pin the LIVE singleton, plus every JsFinder class Pyodide has.

    Separate from _sils_empty_bridge because the singleton is reachable as an
    ordinary attribute and may never appear on sys.meta_path at all -- which is
    exactly the gap that let the two-run escape through: the old seal only
    emptied finders it could see on the list, and by run 2 the list no longer
    held the object the learner had dirtied in run 1.

    The pin goes on the CLASS so that \`JsFinder()\`, which a learner can
    construct and append, is born sealed. Its own __init__ assigns
    self.jsproxies = {}, but a data descriptor on the class takes precedence
    over the instance dict, so the assignment is simply shadowed.
    """
    try:
        import pyodide._state as _sils_state
        _sils_empty_bridge(_sils_state.jsfinder)
    except BaseException:
        pass
    try:
        from _pyodide._importhook import JsFinder as _sils_JsFinder
        _sils_JsFinder.jsproxies = property(
            lambda _sils_self: _sils_TABLE,
            lambda _sils_self, _sils_value: _sils_TABLE._sils_deny(_sils_self),
        )
    except BaseException:
        pass

# LAYER A: the baseline itself. Captured once, with every bridge-serving finder
# ALREADY GONE -- this tuple is what every rebuild restores from, so what is
# missing here is missing for good. A learner can assign sys.meta_path to
# anything they like; whatever they build it out of, there is no longer an entry
# in it that can resolve 'js'.
#
# Membership is decided by what a finder COULD do, so the probe runs before
# anything is emptied. Judging afterwards would empty the table, make the probe
# answer "no", and quietly readmit the finder that had the bridge.
_sils_KEPT = []
for _sils_f in tuple(getattr(_sils_sys, 'meta_path', ())):
    if _sils_serves_bridge(_sils_f):
        _sils_empty_bridge(_sils_f)
    else:
        _sils_KEPT.append(_sils_f)
_sils_ORIGINAL = tuple(_sils_KEPT)

class _sils_SealedImport:
    """Refuses to resolve a sealed name: \`import js\` raises ImportError."""
    def find_spec(self, name, target=None, path=None):
        if _sils_sealed(name):
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

    It also re-pins the bridge table (LAYER B). Learner code runs BETWEEN runs,
    so an object a run managed to dirty is still live for the next one, and
    re-pinning here is what makes "there is no live JavaScript object anywhere a
    learner can reach" true at every moment their own import statement can
    observe, not just after a boot.
    """
    for _sils_f in tuple(getattr(_sils_sys, 'meta_path', ())):
        if not isinstance(_sils_f, _sils_SealedImport):
            _sils_empty_bridge(_sils_f)
    _sils_pin_bridge()
    _sils_sys.meta_path = _sils_SealedMetaPath(_sils_ORIGINAL)
    # sys.modules is dropped by PREFIX, not by first component: pyodide.ffi and
    # pyodide.code both have to go while \`import pyodide\` itself keeps working,
    # because Pyodide's own internals live under that package.
    for name in [n for n in list(_sils_sys.modules) if _sils_sealed(n)]:
        del _sils_sys.modules[name]
    # And off the package objects, or \`import pyodide; pyodide.ffi\` reads the
    # attribute straight off the module without ever consulting sys.meta_path.
    for _sils_pkg, _sils_attrs in (
            ('pyodide', ('ffi', 'code', 'webloop')),
            ('_pyodide', ('_core_docs',)),
    ):
        try:
            _sils_mod = _sils_sys.modules.get(_sils_pkg)
            for _sils_attr in _sils_attrs:
                if _sils_mod is not None and hasattr(_sils_mod, _sils_attr):
                    delattr(_sils_mod, _sils_attr)
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
# Imported under the __sils_ prefix so they are not mistaken for learner names.
# Bare \`import io\` left io / contextlib / traceback in globals(), and they then
# turned up in the result's values as three modules the learner never wrote.
import io as __sils_io, contextlib as __sils_contextlib, traceback as __sils_traceback
__sils_stdout_parts = __sils_io.StringIO()
__sils_error = None
__sils_ok = True
try:
    with __sils_contextlib.redirect_stdout(__sils_stdout_parts), __sils_contextlib.redirect_stderr(__sils_stdout_parts):
        exec(compile(${JSON.stringify(code)}, '<exercise>', 'exec'), globals())
except BaseException:
    __sils_ok = False
    __sils_error = __sils_traceback.format_exc(limit=8)
__sils_stdout = __sils_stdout_parts.getvalue()
del __sils_stdout_parts
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
      const raw = found ? pyodide.globals.get('__sils_value') : undefined;
      // `Number('abc')` is NaN, and the old detail printed "got NaN", which
      // tells a learner nothing about what they actually assigned. Name the
      // type instead, so the message is actionable.
      if (!found) return { ok: false, detail: `${check.name} was never assigned` };
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        const described = typeof raw === 'string' ? `the text ${JSON.stringify(raw)}`
          : raw === null ? 'null'
            : Array.isArray(raw) ? 'a list'
              : `a ${typeof raw}`;
        return { ok: false, detail: `${check.name} is ${described}, not a number` };
      }
      const ok = value >= check.min && value <= check.max;
      return { ok, detail: `got ${value}` };
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
    // The capture function lives in the guard namespace but has to READ the
    // learner's namespace, so it is bridged across for the length of one call.
    const captured = pyodide.runPython('_sils_capture', { globals: guard });
    pyodide.globals.set('__sils_capture_fn', captured);
    let values = {};
    try {
      const snapshot = pyodide.runPython('__sils_capture_fn(globals())');
      values = snapshot && typeof snapshot.toJs === 'function'
        ? snapshot.toJs({ dict_converter: Object.fromEntries })
        : {};
    } finally {
      pyodide.globals.delete('__sils_capture_fn');
    }
    // Both evaluators return one slot per check so the two arrays stay aligned
    // by index; a mismatch here would silently mislabel which assertion failed.
    const sandboxOutcomes = ok ? evaluateSandboxChecks(pyodide, checks) : checks.map(() => null);
    const hostOutcomes = evaluateHostChecks(checks, stdout, request.answer);
    const outcomes = checks.map((check, index) => {
      const own = SANDBOX_KINDS.includes(check.kind) ? sandboxOutcomes[index] : hostOutcomes[index];
      return own || { ok: false, detail: ok ? 'not evaluated' : 'code did not run' };
    });
    reply({
      type: 'result', nonce, ok, stdout, error, values, outcomes, ms: Date.now() - started,
    });
  } catch (failure) {
    // Still one slot per check: the grader reads outcomes by index, so a short
    // array would mislabel every check after the real fault.
    reply({
      type: 'result', nonce, ok: false, stdout: '', error: String(failure && failure.message || failure),
      values: {},
      outcomes: checks.map(() => ({ ok: false, detail: 'the sandbox runtime failed' })),
      ms: Date.now() - started,
    });
  }
});
