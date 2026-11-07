/* Lightweight runtime for the Chinese / English / Spanish editions of the site.
   Dictionaries register themselves through MSI18N.register(); markup opts in with
   data-i18n (text), data-i18n-html (inline markup) and data-i18n-attr ("attr:key|…").
*/
(() => {
  'use strict';
  const STORAGE_KEY = 'ms-cookbook.language';
  const DEFAULT = 'zh';
  const dictionaries = Object.create(null);
  const listeners = new Set();
  const htmlLang = {zh: 'zh-CN', en: 'en-US', es: 'es-ES'};
  let current = DEFAULT;
  /* Bumped by every set() that succeeds -- including one that picks the language
     already on screen. That is the case the naive `next === current` return misses:
     a reader who stored es and picks 中文 during init()'s 3.4 MB fetch changes
     nothing visible, so nothing else records that they spoke after init() started,
     and the pack that lands later would take the page back to es. init() reads
     this before it loads and drops its own result if the value moved.
     A failed set() does not bump it: that pick never happened, and the reader's
     stored preference is still the best answer the page has. */
  let intent = 0;

  function register(code, entries) {
    if (!code || !entries || typeof entries !== 'object') return;
    dictionaries[code] = Object.assign(dictionaries[code] || Object.create(null), entries);
  }
  function normalize(code) {
    const value = String(code || '').trim().toLowerCase();
    if (value.startsWith('zh')) return 'zh';
    if (value.startsWith('es')) return 'es';
    if (value.startsWith('en')) return 'en';
    return '';
  }
  function stored() {
    try { return normalize(localStorage.getItem(STORAGE_KEY)); } catch { return ''; }
  }
  function t(key, vars) {
    const fallback = dictionaries[DEFAULT] || {};
    let value = (dictionaries[current] || {})[key];
    if (typeof value !== 'string') value = fallback[key];
    if (typeof value !== 'string') return String(key);
    if (!vars) return value;
    for (const name of Object.keys(vars)) value = value.split('{' + name + '}').join(String(vars[name]));
    return value;
  }
  function has(key) {
    if (typeof (dictionaries[current] || {})[key] === 'string') return true;
    return typeof (dictionaries[DEFAULT] || {})[key] === 'string';
  }
  function variables(node) {
    const raw = node.getAttribute('data-i18n-vars');
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }
  function apply(root) {
    const scope = root || document;
    scope.querySelectorAll('[data-i18n]').forEach(node => {
      const value = t(node.getAttribute('data-i18n'), variables(node));
      if (node.textContent !== value) node.textContent = value;
    });
    scope.querySelectorAll('[data-i18n-html]').forEach(node => {
      const value = t(node.getAttribute('data-i18n-html'), variables(node));
      if (node.dataset.i18nMarkup !== value) { node.innerHTML = value; node.dataset.i18nMarkup = value; }
    });
    scope.querySelectorAll('[data-i18n-attr]').forEach(node => {
      const vars = variables(node);
      node.getAttribute('data-i18n-attr').split('|').forEach(pair => {
        const [attribute, key] = pair.split(':').map(part => part && part.trim());
        if (!attribute || !key) return;
        const value = t(key, vars);
        if (node.getAttribute(attribute) !== value) node.setAttribute(attribute, value);
      });
    });
    document.documentElement.lang = htmlLang[current] || current;
    const titleKey = document.documentElement.getAttribute('data-i18n-title');
    if (titleKey) document.title = t(titleKey);
    const descriptionKey = document.documentElement.getAttribute('data-i18n-description');
    const meta = document.querySelector('meta[name="description"]');
    if (descriptionKey && meta) meta.setAttribute('content', t(descriptionKey));
  }
  function notify() {
    apply();
    listeners.forEach(listener => {
      try { listener(current); } catch (error) { console.error(error); }
    });
  }
  /* en/es dictionaries and translated prose are 3.4 MB of literals that a Chinese
     reader never needs. They are injected on demand, so `set` has to wait for
     them: notifying first would paint half-translated chrome over Chinese prose. */
  const extraPaths = {
    en: ['assets/locale/en.js?v=b3a66096b1cc', 'assets/content-i18n/en.js?v=8f8eddd20782'],
    es: ['assets/locale/es.js?v=956ea855f2c4', 'assets/content-i18n/es.js?v=5b84a5c8eb29']
  };
  async function load(code) {
    const next = normalize(code);
    if (!next || next === DEFAULT) return next;
    /* A registered dictionary is not proof the pack is complete: the sequence
       loads the locale file first and the prose file second, so a failure between
       them leaves a dictionary that a short-circuit here would accept forever --
       English chrome over Chinese prose, no error shown, and the missing 2.2 MB
       never asked for again. So the sequence always runs; AssetLoader remembers
       every file that succeeded, which makes a complete pack free and re-requests
       only the one that failed. A page that ships the packs eagerly and has no
       loader at all (analytics.html) is the one case where the dictionary is the
       whole story. */
    if (window.AssetLoader) await window.AssetLoader.loadSequence(extraPaths[next]);
    else if (!dictionaries[next]) throw new Error('asset loader is unavailable');
    if (!dictionaries[next]) throw new Error('language pack registered nothing');
    return next;
  }
  async function set(code, options) {
    const next = await load(code);
    if (!next) return;
    intent += 1;
    if (next === current) return;
    current = next;
    if (!options || options.persist !== false) {
      try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Storage can be disabled in embedded readers. */ }
    }
    notify();
  }
  function init() {
    const initial = stored();
    // A returning English reader gets Chinese chrome until the pack lands; that
    // is the trade for not shipping 3.4 MB to everyone. notify() runs once, after.
    if (initial && initial !== DEFAULT) {
      const mark = intent;
      load(initial).then(code => {
        // The reader may have spent this wait picking a language, including the
        // one already on screen (see `intent`). Their pick wins; a pack that
        // lands late is dropped rather than painted over it.
        if (mark !== intent) return;
        current = code;
        notify();
      }, notify);
    } else notify();
  }

  window.MSI18N = {
    register, t, has, apply, set, load, init, codes: Object.freeze(['zh', 'en', 'es']),
    get lang() { return current; },
    get extraPaths() { return extraPaths; },
    locale() { return htmlLang[current] || current; },
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();