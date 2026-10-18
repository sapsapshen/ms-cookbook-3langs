/* Main-thread facade over the Pyodide worker.
   Nothing here touches the DOM beyond reporting state, so the same file can be
   reasoned about without a browser. The runtime is loaded lazily on first run
   (G9): Pyodide never lands in the initial page payload. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ExerciseSandbox = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DEFAULT_TIMEOUT = 15000;

  function create(options) {
    const settings = options || {};
    const workerUrl = settings.workerUrl || 'assets/exercise-worker.js';
    const defaultTimeout = settings.timeoutMs || DEFAULT_TIMEOUT;
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
        outcomes: (Array.isArray(checks) ? checks : []).map(() => ({ ok: false, detail: '' })),
        ms: 0,
        ...extra,
      };
    }

    function runOnce(request) {
      return new Promise((resolve, reject) => {
        let instance;
        try { instance = ensureWorker(); }
        catch (error) { reject({ reason: 'worker_error', message: String(error.message || error) }); return; }
        const limit = request.timeoutMs || defaultTimeout;
        let settled = false;
        const finish = value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          instance.removeEventListener('message', onMessage);
          instance.removeEventListener('error', onError);
          resolve(value);
        };
        const timer = setTimeout(() => {
          destroy();
          finish(failed(`运行超时（${Math.round(limit / 1000)}秒），请检查是否有死循环`, request.checks, { ms: limit, reason: 'timeout' }));
        }, limit);
        const onMessage = event => {
          const data = event.data || {};
          if (data.type !== 'result') return;
          finish({ ok: data.ok === true, stdout: data.stdout || '', error: data.error || '', outcomes: data.outcomes || [], ms: data.ms || 0 });
        };
        const onError = event => {
          destroy();
          finish(failed((event && event.message) || '运行环境异常', request.checks, { reason: 'crash' }));
        };
        instance.addEventListener('message', onMessage);
        instance.addEventListener('error', onError);
        instance.postMessage({
          type: 'run',
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
        return failed(String(thrown && thrown.message || thrown), request.checks, { reason: 'worker_error' });
      }
    }

    return { preload, run, destroy, get busy() { return worker !== null; } };
  }

  return { DEFAULT_TIMEOUT, create };
});
