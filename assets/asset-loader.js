/* Injects one script on demand and remembers the attempt.

   Dynamically added <script> tags are async by default, which would silently
   reorder the exercise bundle (exercises.js must precede exercise-map.js). So
   the only public helper that takes a list awaits each tag before adding the
   next, and the whole site shares one map keyed by src -- a route entered twice
   must not pay for the bundle twice. */
(() => {
  'use strict';
  const pending = new Map();

  function loadScript(src) {
    if (!pending.has(src)) {
      pending.set(src, new Promise((resolvePromise, rejectPromise) => {
        const tag = document.createElement('script');
        tag.src = src;
        tag.onload = () => resolvePromise(src);
        tag.onerror = () => {
          pending.delete(src);
          tag.remove();
          rejectPromise(new Error('无法加载 ' + src));
        };
        document.head.append(tag);
      }));
    }
    return pending.get(src);
  }

  async function loadSequence(srcs) {
    for (const src of srcs) await loadScript(src);
    return srcs;
  }

  window.AssetLoader = { loadScript, loadSequence };
})();
