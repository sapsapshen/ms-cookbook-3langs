/* The only motion layer in this site.

   Deliberately small: it owns the reduced-motion decision (CSS cannot make the
   IntersectionObserver and View Transition go away), it owns the reveal scan,
   and it owns the one place that knows how to swap a view. Everything else
   reads the tokens. */
(() => {
  'use strict';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const REVEAL_SELECTORS = ['#articleBody h2', '#homePaths article', '#sceneGrid .scene', '[data-reveal]'];
  let observer = null;
  let running = null;

  function token(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function ensureObserver() {
    if (observer || reduce.matches || !('IntersectionObserver' in window)) return observer;
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-revealed');
        observer.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.01 });
    return observer;
  }

  function revealables(root) {
    const scope = root || document;
    const found = new Set();
    for (const selector of REVEAL_SELECTORS) {
      scope.querySelectorAll(selector).forEach(node => found.add(node));
      if (scope !== document && scope.matches(selector)) found.add(scope);
    }
    return [...found];
  }

  function scan(root) {
    if (reduce.matches || !('IntersectionObserver' in window)) return;
    const watch = ensureObserver();
    const pending = [];
    for (const node of revealables(root)) {
      if (node.dataset.revealBound === '1' || node.classList.contains('is-revealed')) continue;
      pending.push(node);
    }
    // Every geometry read happens before any write: one node's box cannot depend
    // on another node's opacity or transform, so batching the reads keeps this
    // pass out of the read-write interleave that forces a layout per element.
    const boxes = pending.map(node => node.getBoundingClientRect());
    pending.forEach((node, index) => {
      node.dataset.revealBound = '1';
      // The CSS gate keys off [data-reveal]; a node selected by #articleBody h2
      // is invisible until it is revealed only once it carries that hook.
      node.setAttribute('data-reveal', '');
      const box = boxes[index];
      if (box.top < window.innerHeight && box.bottom > 0) { node.classList.add('is-revealed'); return; }
      watch.observe(node);
    });
  }

  /* A reader who turns the preference on mid-visit must see everything, not a
     page of invisible blocks. Revealing in place beats reloading the document. */
  function revealEverything() {
    if (observer) { observer.disconnect(); observer = null; }
    revealables().forEach(node => node.classList.add('is-revealed'));
  }

  function fallbackSwap() {
    // The reader view is a bare <div class="site-shell">, so a `main[data-page]`
    // selector fell through to <body> and faded the header along with the page.
    const page = document.querySelector('[data-page]:not([hidden])') || document.body;
    page.animate(
      [{ opacity: 0, transform: 'translateY(' + token('--motion-rise', '10px') + ')' }, { opacity: 1, transform: 'none' }],
      { duration: parseInt(token('--motion-base', '220ms'), 10), easing: token('--ease-out', 'ease-out'), fill: 'none' }
    );
  }

  /* Returns the ViewTransition when there is one to await, undefined when the
     mutation already happened synchronously. Callers that must sequence after
     the DOM change use `ready`. */
  function transition(mutate) {
    if (reduce.matches || !document.startViewTransition) {
      mutate();
      if (!reduce.matches) fallbackSwap();
      return undefined;
    }
    if (running && running.skipTransition) { try { running.skipTransition(); } catch { /* already finished */ } }
    running = document.startViewTransition(() => mutate());
    return running;
  }

  document.documentElement.classList.add('motion-ready');
  window.Motion = {
    reduce: () => reduce.matches,
    transition,
    scan,
    revealEverything,
  };
  // Every view swap and every lazy render gets one scan; the scan is idempotent.
  window.addEventListener('purplebook:route', () => requestAnimationFrame(() => scan()));
  reduce.addEventListener('change', () => { if (reduce.matches) revealEverything(); });
})();
