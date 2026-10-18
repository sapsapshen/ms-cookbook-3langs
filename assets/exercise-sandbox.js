/* Main-thread facade over the Pyodide worker.
   Nothing here touches the DOM beyond reporting state, so the same file can be
   reasoned about without a browser. The runtime is loaded lazily on first run
   (G9): Pyodide never lands in the initial page payload.

   Two clocks, not one. The first run has to download ~13 MB and compile a WASM
   module before a single line of learner code executes, which on a slow
   connection takes far longer than any exercise is allowed to run. Folding that
   into the 15-second budget produced "运行超时（15秒），请检查是否有死循环" for a
   learner whose code had not started yet. So the worker announces `loading` as
   soon as it starts booting, and the execution clock starts from THAT message:
   the download gets its own, much longer budget, and the timeout a learner sees
   always describes their code.

   Timers live here, not in the worker, because a worker being terminate()d
   cannot be relied on to run a pending timeout callback. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ExerciseSandbox = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DEFAULT_TIMEOUT = 15000;
  /* Downloading and compiling Pyodide is a one-off, so it gets its own budget
     rather than borrowing from the learner's execution allowance. */
  const DEFAULT_LOAD_TIMEOUT = 120000;

  /* The `reason` values a caller may see on a failed result, exported so
     callers branch on a constant rather than on a bare string. Frozen because
     this is the contract between the sandbox and its callers: a page that
     rewrote it could make its own error handling unreachable. */
  const SandboxOutcome = Object.freeze({
    TIMEOUT: 'timeout',
    LOAD_TIMEOUT: 'load_timeout',
    CRASH: 'crash',
    WORKER_ERROR: 'worker_error',
  });

  /* A per-run token. Learner code that reaches postMessage can shape any
     message it likes, so the facade only believes a reply carrying the nonce it
     minted for THIS run. crypto.getRandomValues, never a counter: a guessable
     nonce is not a nonce, and a fixed constant would be known to anyone who
     read this file. */
  function randomNonce() {
    const bytes = new Uint8Array(16);
    const source = (typeof globalThis !== 'undefined' && globalThis.crypto)
      || (typeof self !== 'undefined' && self.crypto);
    if (!source || typeof source.getRandomValues !== 'function') {
      throw new Error('a secure random source is required to start the sandbox');
    }
    source.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function create(options) {
    const settings = options || {};
    const workerUrl = settings.workerUrl || 'assets/exercise-worker.js';
    const defaultTimeout = settings.timeoutMs || DEFAULT_TIMEOUT;
    const loadTimeout = settings.loadTimeoutMs || DEFAULT_LOAD_TIMEOUT;
    // Optional hook for Task 8's UI, called as the runtime starts and as the
    // download gives out, so the panel can say so instead of looking hung.
    const onPhase = typeof settings.onPhase === 'function' ? settings.onPhase : null;
    let worker = null;
    let queue = Promise.resolve();

    function ensureWorker() {
      if (worker) return worker;
      const created = new Worker(workerUrl);
      // A worker whose script fails to load reports `error` and then sits there
      // doing nothing; drop AND terminate it so the next run starts clean. This
      // listener is registered first, so it also runs before the per-run one
      // and guarantees terminate() happens exactly once per crash.
      created.addEventListener('error', () => {
        if (worker === created) worker = null;
        created.terminate();
      });
      worker = created;
      return created;
    }

    function destroy() {
      if (worker) { worker.terminate(); worker = null; }
    }

    function preload() {
      if (worker) return Promise.resolve();
      try { ensureWorker(); return Promise.resolve(); }
      catch (error) { return Promise.reject(error); }
    }

    /* Every exit path returns one outcome per check. The grader reads outcomes
       by index into exercise.checks, so a short array would shift which check
       each verdict belongs to — the defect class this contract exists to stop. */
    function failed(error, checks, extra) {
      return {
        ok: false,
        stdout: '',
        error,
        // Every exit path returns the same shape, so a caller never has to
        // ask whether `values` exists before reading it.
        values: {},
        outcomes: (Array.isArray(checks) ? checks : []).map(() => ({ ok: false, detail: '' })),
        ms: 0,
        ...extra,
      };
    }

    function runOnce(request) {
      return new Promise((resolve, reject) => {
        let instance;
        try { instance = ensureWorker(); }
        catch (error) { reject({ reason: SandboxOutcome.WORKER_ERROR, message: String(error.message || error) }); return; }
        const limit = request.timeoutMs || defaultTimeout;
        const nonce = randomNonce();
        let settled = false;
        // Only one timer is ever armed, and which one depends on whether the
        // runtime has announced itself yet.
        let timer = null;
        const finish = value => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          instance.removeEventListener('message', onMessage);
          instance.removeEventListener('error', onError);
          resolve(value);
        };
        const armLoadTimeout = () => {
          if (timer) return;
          timer = setTimeout(() => {
            destroy();
            if (onPhase) onPhase({ phase: 'load_timeout' });
            finish(failed(
              `运行环境下载超时（${Math.round(loadTimeout / 1000)}秒），请检查网络后重试`,
              request.checks,
              { ms: loadTimeout, reason: SandboxOutcome.LOAD_TIMEOUT }));
          }, loadTimeout);
        };
        const armRunTimeout = () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            destroy();
            finish(failed(`运行超时（${Math.round(limit / 1000)}秒），请检查是否有死循环`, request.checks, { ms: limit, reason: SandboxOutcome.TIMEOUT }));
          }, limit);
        };
        const onMessage = event => {
          const data = event.data || {};
          // Not ours: a message from a previous run, or something the learner
          // code posted itself. Either way it is not this run's answer.
          if (data.nonce !== nonce) return;
          if (data.type === 'loading') {
            if (onPhase) onPhase({ phase: 'loading' });
            // The download is over the moment the worker can talk to us; from
            // here on the learner's clock is what matters.
            armRunTimeout();
            return;
          }
          if (data.type !== 'result') return;
          finish({
            ok: data.ok === true,
            stdout: data.stdout || '',
            error: data.error || '',
            values: data.values || {},
            outcomes: data.outcomes || [],
            ms: data.ms || 0,
          });
        };
        const onError = event => {
          destroy();
          finish(failed((event && event.message) || '运行环境异常', request.checks, { reason: SandboxOutcome.CRASH }));
        };
        instance.addEventListener('message', onMessage);
        instance.addEventListener('error', onError);
        // Armed before the postMessage: a worker that never answers at all
        // still has to time out somewhere.
        armLoadTimeout();
        instance.postMessage({
          type: 'run',
          nonce,
          code: request.code || '',
          checks: Array.isArray(request.checks) ? request.checks : [],
          answer: request.answer || null,
          timeoutMs: limit,
        });
      });
    }

    async function run(request) {
      // One worker, one Python namespace: two overlapping runs would interleave
      // in the same globals and each caller could resolve with the other's
      // result. Queue them instead — a second click waits for the first.
      const started = queue.then(() => runOnce(request));
      queue = started.then(() => undefined, () => undefined);
      try {
        return await started;
      } catch (thrown) {
        if (thrown && thrown.reason) {
          return failed(String(thrown.message || ''), request.checks, { reason: thrown.reason });
        }
        return failed(String(thrown && thrown.message || thrown), request.checks, { reason: SandboxOutcome.WORKER_ERROR });
      }
    }

    return { preload, run, destroy, get busy() { return worker !== null; } };
  }

  return { DEFAULT_TIMEOUT, DEFAULT_LOAD_TIMEOUT, SandboxOutcome, create };
});
