/* The injection primitive every lazy bundle in this site rides on, and the async
   half of assets/i18n.js that rides on it: which files a language switch fetches,
   when the page is allowed to repaint, and what happens to a pack that lands late
   or only halfway.
   Run with: node scripts/test-asset-loading.cjs */
'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createHash } = require('node:crypto');
const vm = require('node:vm');

const ROOT = resolve(__dirname, '..');
const SOURCE = readFileSync(resolve(ROOT, 'assets/asset-loader.js'), 'utf8');
const I18N = readFileSync(resolve(ROOT, 'assets/i18n.js'), 'utf8');

let passed = 0;
const failures = [];
async function check(name, body) {
  try { await body(); passed += 1; console.log('ok  ' + name); }
  catch (error) { failures.push([name, error]); console.log('FAIL ' + name + ': ' + error.message); }
}

/* A DOM small enough to watch what the loader does, and nothing more. */
function makeDom() {
  const nodes = [];
  const head = { append(node) { nodes.push(node); return node; } };
  return {
    nodes,
    window: {},
    document: {
      head,
      createElement: tag => ({
        tag, src: '',
        remove() { const at = nodes.indexOf(this); if (at >= 0) nodes.splice(at, 1); },
        set onload(fn) { this._load = fn; }, get onload() { return this._load; },
        set onerror(fn) { this._error = fn; }, get onerror() { return this._error; },
      }),
    },
    settle(index, ok) {
      const node = nodes[index];
      if (ok) node.onload(); else node.onerror(new Error('network'));
      return node;
    },
  };
}

function boot() {
  const dom = makeDom();
  vm.runInNewContext(SOURCE, { window: dom.window, document: dom.document });
  return { dom, loader: dom.window.AssetLoader };
}

/* ---- assets/i18n.js against a fake AssetLoader and a fake document ----------
   Both defects the cases below cover are timing, and neither is visible in the
   source: a pack that lands after the reader picked another language, and a
   sequence that dies between its two files -- the locale file registers, the
   content file never arrives. So the real file runs in a vm and the test settles
   the loader by hand. The fake keeps the real AssetLoader's two rules -- a
   resolved src is never requested again, a rejected one is forgotten so the next
   attempt really refetches it -- because the second defect lives in the
   difference. */
function bootI18n(options) {
  const opts = options || {};
  const storage = new Map(Object.entries(opts.storage || {}));
  const page = { storage, writes: 0, injected: [], pending: new Map() };
  const document = {
    readyState: 'complete',
    title: '',
    documentElement: { lang: '', getAttribute: () => null },
    addEventListener() {},
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const cache = new Map();
  function loadScript(src) {
    if (!cache.has(src)) {
      page.injected.push(src);
      cache.set(src, new Promise((resolvePromise, rejectPromise) => {
        page.pending.set(src, {
          land() {
            page.pending.delete(src);
            /* What a loaded pack does before its onload fires: register itself
               under the language its path names. Found through extraPaths rather
               than hard-coded, so re-stamping the pins cannot rot this file. */
            const paths = page.window.MSI18N.extraPaths;
            const code = Object.keys(paths).find(name => paths[name].includes(src));
            if (code) page.window.MSI18N.register(code, { sample: src });
            resolvePromise(src);
          },
          fail() {
            page.pending.delete(src);
            cache.delete(src);
            rejectPromise(new Error('network: ' + src));
          },
        });
      }));
    }
    return cache.get(src);
  }
  async function loadSequence(srcs) {
    for (const src of srcs) await loadScript(src);
    return srcs;
  }
  page.window = { AssetLoader: { loadScript, loadSequence } };
  if (opts.noLoader) delete page.window.AssetLoader;
  page.document = document;
  vm.runInNewContext(I18N, {
    window: page.window,
    document,
    localStorage: {
      getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { page.writes += 1; storage.set(key, String(value)); },
    },
    console,
  });
  page.land = src => {
    const slot = page.pending.get(src);
    assert.ok(slot, 'nothing is waiting on ' + src);
    slot.land();
  };
  page.fail = src => {
    const slot = page.pending.get(src);
    assert.ok(slot, 'nothing is waiting on ' + src);
    slot.fail();
  };
  return page;
}

/* Everything i18n.js awaits is a microtask, so one macrotask boundary drains
   whatever the last settle set in motion. */
const drain = () => new Promise(resolve => setImmediate(resolve));

async function main() {
  await check('asset-loader.js is syntactically valid and exports AssetLoader', () => {
    assert.ok(boot().loader.loadScript, 'loadScript missing');
    assert.ok(boot().loader.loadSequence, 'loadSequence missing');
  });

  await check('one src is injected exactly once, even when requested twice', () => {
    const { dom, loader } = boot();
    const first = loader.loadScript('assets/a.js');
    const second = loader.loadScript('assets/a.js');
    assert.equal(dom.nodes.length, 1, 'a second tag was injected for the same src');
    assert.equal(first, second, 'the promise was not reused');
  });

  await check('loadSequence injects in order and resolves only after each lands', async () => {
    const { dom, loader } = boot();
    const done = [];
    const running = loader.loadSequence(['assets/a.js', 'assets/b.js']).then(list => done.push(list));
    await Promise.resolve();
    assert.equal(dom.nodes.length, 1, 'the second script started before the first finished');
    dom.settle(0, true);
    await Promise.resolve();
    assert.equal(dom.nodes.length, 2);
    assert.equal(dom.nodes[1].src, 'assets/b.js');
    dom.settle(1, true);
    await running;
    assert.deepEqual(done, [['assets/a.js', 'assets/b.js']]);
  });

  await check('a failed injection rejects and is retryable', async () => {
    const { dom, loader } = boot();
    const failed = loader.loadScript('assets/a.js');
    dom.settle(0, false);
    await assert.rejects(failed);
    assert.equal(dom.nodes.length, 0, 'the failed tag was left in the document');
    const again = loader.loadScript('assets/a.js');
    assert.equal(dom.nodes.length, 1, 'a retry must be allowed after failure');
    dom.settle(0, true);
    assert.equal(await again, 'assets/a.js');
  });

  await check('i18n.js declares the lazy paths for en and es, each versioned', () => {
    const source = readFileSync(resolve(ROOT, 'assets/i18n.js'), 'utf8');
    /* The fingerprints are compared against the files they name rather than
       written as literals here: this same change edits both locale files, so a
       hard-coded hash would be stale by the time the commit lands -- and a stale
       one is exactly the bug the assertion exists to catch, not an exception to
       it. */
    const sha = path => createHash('sha256').update(readFileSync(resolve(ROOT, path))).digest('hex').slice(0, 12);
    for (const code of ['en', 'es']) {
      const pattern = new RegExp(`\\b${code}:\\s*\\[\\s*'assets/locale/${code}\\.js\\?v=([0-9a-f]{12})',\\s*'assets/content-i18n/${code}\\.js\\?v=([0-9a-f]{12})'`);
      const match = pattern.exec(source);
      assert.ok(match, `${code} lazy paths missing or unversioned`);
      assert.equal(match[1], sha(`assets/locale/${code}.js`), `assets/locale/${code}.js is pinned to a stale ?v=`);
      assert.equal(match[2], sha(`assets/content-i18n/${code}.js`), `assets/content-i18n/${code}.js is pinned to a stale ?v=`);
    }
  });

  await check('i18n.set waits for the pack before it notifies', () => {
    const source = readFileSync(resolve(ROOT, 'assets/i18n.js'), 'utf8');
    assert.match(source, /async function set\(code, options\)/, 'set must be async');
    assert.match(source, /await load\(code\)/, 'set must await the pack');
  });

  await check('paper.js lists the exercise bundle in load order', () => {
    const source = readFileSync(resolve(ROOT, 'assets/paper.js'), 'utf8');
    const list = /const EXERCISE_BUNDLE = \[([\s\S]*?)\]/.exec(source);
    assert.ok(list, 'EXERCISE_BUNDLE is not declared in paper.js');
    const modules = [...list[1].matchAll(/'assets\/([^'?]+)\.js/g)].map(m => m[1] + '.js');
    assert.deepEqual(modules, [
      'exercises.js', 'exercise-grader.js', 'exercise-store.js',
      'exercise-sandbox.js', 'exercise-map.js', 'exercise-ui.js',
    ], 'exercises.js must stay first: exercise-map.js reads window.EXERCISE_DATA at load');
  });

  await check('index.html no longer ships the lazy bundles', () => {
    const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
    for (const name of ['exercises.js', 'exercise-ui.js', 'locale/en.js', 'content-i18n/es.js']) {
      assert.ok(!html.includes('assets/' + name), `index.html still loads ${name}`);
    }
  });

  await check('i18n notifies once, and only after the whole pack has landed', async () => {
    const page = bootI18n();
    const seen = [];
    page.window.MSI18N.on(code => seen.push(code));
    const switching = page.window.MSI18N.set('en');
    const [locale, content] = page.window.MSI18N.extraPaths.en;
    assert.deepEqual(page.injected, [locale], 'set must request the locale pack first');
    await drain();
    assert.deepEqual(seen, [], 'a listener fired before the pack had registered');
    page.land(locale);
    await drain();
    assert.deepEqual(page.injected, [locale, content], 'the content pack must follow the locale pack');
    assert.deepEqual(seen, [], 'a listener fired while only half the pack had landed');
    page.land(content);
    await switching;
    assert.deepEqual(seen, ['en'], 'the switch must notify exactly once, after the pack');
    assert.equal(page.window.MSI18N.lang, 'en');
    assert.equal(page.storage.get('ms-cookbook.language'), 'en', 'the pick was not persisted');
  });

  await check('a rejected i18n load leaves the language and the storage alone', async () => {
    const page = bootI18n();
    const seen = [];
    page.window.MSI18N.on(code => seen.push(code));
    const rejected = assert.rejects(page.window.MSI18N.set('es'));
    page.fail(page.window.MSI18N.extraPaths.es[0]);
    await rejected;
    await drain();
    assert.equal(page.window.MSI18N.lang, 'zh', 'a failed pack must not change the language');
    assert.equal(page.writes, 0, 'a failed pack must not persist a language');
    assert.deepEqual(seen, [], 'a failed pack must not repaint the page');
  });

  /* analytics.html ships the packs eagerly and has no AssetLoader at all. That
     page must still be able to switch between the packs it already has, and a
     pack it does NOT have must be an error rather than a silent success --
     `load()` now runs the sequence even for a registered language, so this is
     the branch that has to stay honest about what a missing loader means. */
  await check('a page without a loader still switches between the packs it ships', async () => {
    const page = bootI18n({ noLoader: true });
    page.window.MSI18N.register('en', { sample: 'eager' });
    await page.window.MSI18N.set('en');
    assert.equal(page.window.MSI18N.lang, 'en', 'an eagerly shipped pack must not need a loader');
    await assert.rejects(page.window.MSI18N.set('es'), /asset loader is unavailable/);
    assert.equal(page.window.MSI18N.lang, 'en', 'a pack that is not there must not become the language');
  });

  /* The reviewer's reproduction: a returning es reader picks 中文 while the 3.4 MB
     pack is still in flight. `set('zh')` changes nothing visible -- current is
     already zh -- so nothing except an explicit intent token records that the
     reader spoke after init() started. The stale pack must lose. */
  await check('a language picked while init loads the stored pack wins over it', async () => {
    const page = bootI18n({ storage: { 'ms-cookbook.language': 'es' } });
    const [locale, content] = page.window.MSI18N.extraPaths.es;
    assert.deepEqual(page.injected, [locale], 'init must start loading the stored es pack');
    const seen = [];
    page.window.MSI18N.on(code => seen.push(code));
    await page.window.MSI18N.set('zh');
    page.land(locale);
    await drain();
    page.land(content);
    await drain();
    assert.equal(page.window.MSI18N.lang, 'zh', "the stored pack overwrote the reader's pick");
    assert.ok(!seen.includes('es'), 'the stale pack repainted the page in es');
  });

  /* The other half of the same fix: intent must only count a pick that actually
     happened, or a failed attempt to switch would lock the reader out of the
     preference they already had. */
  await check('a failed pick still lets the stored preference land', async () => {
    const page = bootI18n({ storage: { 'ms-cookbook.language': 'es' } });
    const [localeEs, contentEs] = page.window.MSI18N.extraPaths.es;
    const [localeEn] = page.window.MSI18N.extraPaths.en;
    const rejected = assert.rejects(page.window.MSI18N.set('en'));
    assert.deepEqual(page.injected, [localeEs, localeEn], 'init and the pick must each request their own pack');
    page.fail(localeEn);
    await rejected;
    page.land(localeEs);
    await drain();
    page.land(contentEs);
    await drain();
    assert.equal(page.window.MSI18N.lang, 'es', 'a failed pick blocked the stored preference from landing');
  });

  /* A dictionary that exists is not a pack that arrived: locale/en.js registers
     first, so a content-i18n/en.js that fails leaves a page whose en dictionary
     exists and whose en prose does not. The retry has to ask again for the file
     that failed -- and only that file, because AssetLoader remembers the one
     that succeeded. */
  await check('a pack that failed its second file is retried, not remembered', async () => {
    const page = bootI18n();
    const [locale, content] = page.window.MSI18N.extraPaths.en;
    const rejected = assert.rejects(page.window.MSI18N.set('en'));
    page.land(locale);
    await drain();
    page.fail(content);
    await rejected;
    assert.equal(page.window.MSI18N.lang, 'zh', 'a half-loaded pack must not switch the page');
    const retry = page.window.MSI18N.set('en');
    await drain();
    assert.deepEqual(page.injected, [locale, content, content],
      'the retry must re-request the file that failed, and only that file');
    page.land(content);
    await retry;
    assert.equal(page.window.MSI18N.lang, 'en', 'the retry did not complete the pack');
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}
main();
