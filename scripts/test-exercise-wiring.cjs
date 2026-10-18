/* Wiring checks for index.html.

   Every other exercise suite loads the modules directly from source, so none of
   them can catch the failure mode this file exists for: a page that loads all
   the right code in the wrong ORDER, or not at all. Task 8 shipped that bug --
   assets/exercise-ui.js read its collaborators at module scope, so listing it
   before exercise-store.js left `store` null, `init()` took its early return,
   and the panel vanished from every chapter with nothing in the console. The
   code was correct and the tests were green; the page was broken.

   So this suite treats index.html as the thing under test:

     1. the six exercise modules are all listed, and all before paper.js
     2. Pyodide is nowhere in index.html (G9)
     3. every assets/ reference resolves to a file that exists
     4. assets/exercise.css is in check-site.mjs's url() validation list
     5. the scripts actually EXECUTE in index.html's order against a fake DOM,
        and leave window.ExerciseGrader / Store / Sandbox / Map / UI in place

   Point 5 is the one that cannot be argued with: it runs the real files in the
   real order, so a reordering that breaks initialisation fails here rather than
   in a browser. */
'use strict';
const assert = require('node:assert/strict');
const {readFileSync, existsSync} = require('node:fs');
const {resolve, dirname} = require('node:path');
const vm = require('node:vm');

const ROOT = resolve(__dirname, '..');
const read = path => readFileSync(resolve(ROOT, path), 'utf8');
const INDEX = read('index.html');

/* A floor on the number of cases. Deleting every `check(...)` below leaves
 * `passed` and `failures` both at 0 and exits 0 — `PASS: 0 passed, 0 failed` —
 * so an emptied suite would ship as a green CI run proving nothing. The floor
 * sits below the current count on purpose: adding cases on purpose must never
 * trip it, only losing them should. */
const MIN_CASES = 15;

let failures = 0;
let passed = 0;
let cases = 0;
async function check(name, fn) {
  cases += 1;
  try {
    const result = fn();
    if (result && typeof result.then === 'function') await result;
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${error && error.message}`);
  }
}

/* The order index.html declares. `src` only -- an inline <script> has no src
   and cannot affect load order, and every script in this page is external. */
function scriptOrder(html) {
  return [...html.matchAll(/<script\b[^>]*\ssrc="assets\/([^"?]+\.js)/g)].map(match => match[1]);
}

const EXERCISE_MODULES = [
  'exercises.js',
  'exercise-grader.js',
  'exercise-store.js',
  'exercise-sandbox.js',
  'exercise-map.js',
  'exercise-ui.js',
];

/* ------------------------------------------------- 1. declared script order */

const ORDER = scriptOrder(INDEX);

async function main() {
await check('index.html lists every exercise module exactly once', () => {
  for (const module of EXERCISE_MODULES) {
    const hits = ORDER.filter(name => name === module);
    assert.equal(hits.length, 1, `${module} appears ${hits.length} times, expected once`);
  }
});

await check('every exercise module is loaded before paper.js', () => {
  const paperAt = ORDER.indexOf('paper.js');
  assert.notEqual(paperAt, -1, 'index.html no longer loads assets/paper.js');
  for (const module of EXERCISE_MODULES) {
    const at = ORDER.indexOf(module);
    assert.ok(at < paperAt, `${module} sits at ${at}, after paper.js at ${paperAt}`);
  }
});

/* The circular dependency the brief warns about, checked and found NOT to
   exist -- so this ordering is a plain precedence rule, not a deadlock.

   paper.js needs the map: it calls renderExerciseMap() during its own startup
   (paper.js:121, :418, :435). The map needs nothing from paper.js at load.

   The panel's half is the one that looked circular. It does not listen for
   `purplebook:route` (the event paper.js dispatches at paper.js:423) -- it
   listens for `hashchange` and `purplebook:session`, both dispatched by the
   BROWSER and by assets/discussion.js respectively. Two modules listening on
   the same event is not a cycle. So exercise-ui.js may load before paper.js:
   it binds its listener during its own IIFE, and paper.js's route() runs later
   in the same task. Asserted here so a future edit that DOES add a
   `purplebook:route` listener trips this instead of a blank panel. */
await check('the panel never waits on an event only paper.js can fire', () => {
  const ui = read('assets/exercise-ui.js');
  assert.ok(
    !/purplebook:route/.test(ui),
    'exercise-ui.js listens for purplebook:route, which only paper.js dispatches -- that is the cycle',
  );
  assert.match(ui, /addEventListener\('hashchange'/);
});

/* Relative order INSIDE the exercise block. exercise-map.js reads
   window.ExerciseStore at paint time and assets/exercise-ui.js resolves its
   collaborators inside init(), so a swap between those two is survivable; a
   swap that puts exercise-grader.js last is not, because the panel grades
   against it. Asserting the documented order keeps the next edit honest. */
await check('the exercise modules keep their documented relative order', () => {
  const actual = ORDER.filter(name => EXERCISE_MODULES.includes(name));
  assert.deepEqual(actual, EXERCISE_MODULES);
});

await check('exercise-ui.js precedes the reader scripts it attaches to', () => {
  // The panel mounts after .chapter-pager and repaints on hashchange. It does
  // not read paper.js at load time, so this is a readability contract rather
  // than a hard one -- but keeping the exercise block together is what makes
  // the order above reviewable at all.
  const ui = ORDER.indexOf('exercise-ui.js');
  for (const later of ['reading.js', 'discussion.js', 'wishes.js']) {
    const at = ORDER.indexOf(later);
    if (at === -1) continue;
    assert.ok(ui < at, `exercise-ui.js at ${ui} is after ${later} at ${at}`);
  }
});

await check('assets/exercise.css is linked from index.html', () => {
  assert.match(INDEX, /<link[^>]*href="assets\/exercise\.css(?:\?[^"]*)?"/);
});

/* ----------------------------------------------------------- 2. Pyodide/G9 */

await check('index.html never mentions pyodide (G9)', () => {
  assert.ok(!/pyodide/i.test(INDEX), 'index.html contains "pyodide"');
  assert.ok(!/<script[^>]*pyodide/i.test(INDEX), 'index.html has a pyodide script tag');
});

await check('Pyodide is loaded on demand by the worker, not by the page', () => {
  const worker = read('assets/exercise-worker.js');
  assert.ok(
    worker.includes("importScripts('./vendor/pyodide/pyodide.js')"),
    'exercise-worker.js no longer importScripts the vendored Pyodide',
  );
  const sandbox = read('assets/exercise-sandbox.js');
  assert.ok(
    sandbox.includes('assets/exercise-worker.js'),
    'exercise-sandbox.js no longer defaults to the bundled worker',
  );
});

/* ------------------------------------------------------- 3. local file refs */

await check('every assets/ reference in index.html exists on disk', () => {
  const refs = [...INDEX.matchAll(/(?:src|href)="(assets\/[^"?]+)(?:\?[^"]*)?"/g)].map(m => m[1]);
  assert.ok(refs.length > 0, 'no assets/ references found -- the regex is wrong');
  for (const ref of new Set(refs)) {
    assert.ok(existsSync(resolve(ROOT, ref)), `missing local file ${ref}`);
  }
});

await check('every cached ?v= fingerprint matches the file it points at', () => {
  const {createHash} = require('node:crypto');
  let seen = 0;
  for (const match of INDEX.matchAll(/(?:src|href)="(assets\/[^"?]+\.(?:js|css))\?v=([0-9a-f]+)"/g)) {
    seen += 1;
    const [, path, version] = match;
    const actual = createHash('sha256').update(readFileSync(resolve(ROOT, path))).digest('hex').slice(0, 12);
    assert.equal(version, actual, `${path} is pinned to ?v=${version} but hashes to ${actual}`);
  }
  assert.ok(seen > 0, 'no fingerprinted assets/ references found');
  // Every exercise module and the stylesheet must be fingerprinted, or a browser
  // that cached the page keeps serving the pre-Task-10 build.
  for (const path of EXERCISE_MODULES.map(m => `assets/${m}`).concat('assets/exercise.css')) {
    assert.ok(
      INDEX.includes(`"${path}?v=`),
      `${path} is loaded without a ?v= fingerprint; run node scripts/version-assets.mjs`,
    );
  }
});

/* ------------------------------------------------- 4. check-site.mjs coverage */

await check("check-site.mjs validates assets/exercise.css's url() references", () => {
  const source = read('scripts/check-site.mjs');
  const match = source.match(/for\(const css of \[([^\]]+)\]\)/);
  assert.ok(match, 'the CSS validation loop was renamed or removed');
  const listed = [...match[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  assert.ok(listed.includes('assets/exercise.css'), `assets/exercise.css is not in ${JSON.stringify(listed)}`);
});

await check('check-site.mjs asserts the exercise load order too', () => {
  const source = read('scripts/check-site.mjs');
  assert.match(source, /must be loaded before paper\.js/, 'check-site.mjs lost its load-order assertion');
});

/* ------------------------------------------ 5. execute the real page order */

/* A permissive DOM. It is not a renderer: it exists so the real scripts can
   run top to bottom and a load-order mistake surfaces as a thrown error here
   instead of a blank panel in a browser.

   /* Two rules make it permissive rather than accurate:
     - querySelector/getElementById MEMOISE a stub per selector, so paper.js's
       ~60 `$('#id')` lookups all resolve instead of returning null
     - a memoised stub is parented to the root, so `pager.after(panel)` inserts
       into a real tree and a later lookup finds the panel for real

   The two slots the exercise feature actually needs are NOT left to that
   fallback: `#exerciseMap` and `.chapter-pager` are real markup in index.html,
   so they are seeded as real nodes here. Memoising them would make every
   "is the panel there?" assertion unfalsifiable -- the lookup would hand back
   the stub it just invented and the assertion would pass against a page that
   rendered nothing. */
class StubNode {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    const backing = Object.create(null);
    const self = this;
    this.dataset = new Proxy(backing, {
      get: (target, key) => (typeof key === 'string' ? target[key] : target[key]),
      set(target, key, value) {
        target[key] = value;
        if (typeof key === 'string') self.attributes.set(`data-${camel(key)}`, String(value));
        return true;
      },
    });
    this._listeners = new Map();
    this._text = '';
    this.style = {width: '', setProperty() {}};
    this.classList = {
      add: () => {}, remove: () => {},
      toggle: () => {}, contains: () => false,
    };
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.href = '';
    this.tabIndex = 0;
    this.spellcheck = false;
    this.placeholder = '';
    this.open = false;
    this.scrollTop = 0;
    this.clientHeight = 0;
    this.offsetHeight = 0;
  }
  get className() { return this.attributes.get('class') || ''; }
  set className(value) { this.attributes.set('class', String(value)); }
  get id() { return this.attributes.get('id') || ''; }
  set id(value) { this.attributes.set('id', String(value)); }
  get innerHTML() { return this._html || ''; }
  set innerHTML(value) {
    this._html = String(value);
    this.children.length = 0;
    this._text = '';
  }
  get textContent() { return this._text + this.children.map(child => child.textContent || '').join(''); }
  set textContent(value) {
    this.children.length = 0;
    this._html = '';
    this._text = value === undefined || value === null ? '' : String(value);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  /* A real append() coerces a string argument into a text node. Without that,
     assets/paper.js's `.append(partName(i), meta)` throws on the first string
     and the whole page aborts halfway through startup -- which would make this
     stub report an ordering bug that is not one. */
  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === 'string' ? Object.assign(new StubNode('#text'), {nodeType: 3, _text: node}) : node;
      child.parentNode = this;
      this.children.push(child);
    }
  }
  replaceChildren(...nodes) { this.children.length = 0; this._text = ''; this.append(...nodes); }
  insertAdjacentHTML(_where, markup) { this._html = (this._html || '') + markup; }
  after(node) {
    const parent = this.parentNode;
    if (!parent) return;
    node.parentNode = parent;
    const at = parent.children.indexOf(this);
    parent.children.splice(at < 0 ? parent.children.length : at + 1, 0, node);
  }
  remove() {
    const parent = this.parentNode;
    if (!parent) return;
    const at = parent.children.indexOf(this);
    if (at >= 0) parent.children.splice(at, 1);
    this.parentNode = null;
  }
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }
  removeEventListener() {}
  /* Focus/click/scroll are entry points paper.js calls at bind time; the stub
     answers so the binding succeeds without doing anything. */
  focus() {} click() {} blur() {} select() {} scrollIntoView() {} close() {} showModal() {}
  getBoundingClientRect() { return {top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0}; }
  descendants() {
    const out = [];
    const walk = node => { for (const child of node.children) { out.push(child); walk(child); } };
    walk(this);
    return out;
  }
  matches(selector) {
    return parseSelector(selector).every(part =>
      part.kind === 'id' ? this.getAttribute('id') === part.value
        : part.kind === 'class' ? this.className.split(/\s+/).includes(part.value)
          : part.kind === 'attr' ? this.getAttribute(part.name) === part.value
            : this.tagName === part.value);
  }
  querySelectorAll(selector) {
    return this.descendants().filter(node => node.matches(selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function parseSelector(selector) {
  const parts = [];
  const pattern = /\[([a-zA-Z-]+)(?:="([^"]*)")?\]|#([\w-]+)|\.([\w-]+)|([\w-]+)/g;
  let match;
  while ((match = pattern.exec(selector.trim())) !== null) {
    if (match[1] !== undefined) parts.push({kind: 'attr', name: match[1], value: match[2]});
    else if (match[3] !== undefined) parts.push({kind: 'id', value: match[3]});
    else if (match[4] !== undefined) parts.push({kind: 'class', value: match[4]});
    else parts.push({kind: 'tag', value: match[5].toUpperCase()});
  }
  return parts;
}

function camel(name) { return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }

/* The scripts index.html loads, in its own order, minus the ones that cannot
   execute outside a browser for reasons unrelated to load order (analytics is a
   beacon stub; the two content-i18n bundles are 1.1 MB of dictionary literals
   that only call MSI18N.register and touch nothing the exercise modules read).
   Everything that DEFINES or CONSUMES a global the page needs is here. */
const SKIPPED = new Set(['analytics.js', 'content-i18n/en.js', 'content-i18n/es.js']);
const RUNNABLE = ORDER.filter(name => !SKIPPED.has(name));

/* Boots the page the way a browser would: run each script in declaration order
   against one shared context, and report which file threw. `hash` picks the
   route the page starts on -- '' is the home page, '#chapter-7' is a reader
   who deep-linked into a chapter (the case where the panel must exist). */
function bootPage(hash) {
  const root = new StubNode('body');
  /* The slots index.html actually ships, as real nodes. See the class comment:
     anything left to the memo fallback cannot be asserted on. */
  const mapSlot = new StubNode('div');
  mapSlot.id = 'exerciseMap';
  const pager = new StubNode('nav');
  pager.className = 'chapter-pager';
  const articleBody = new StubNode('div');
  articleBody.id = 'articleBody';
  root.append(mapSlot, pager, articleBody);
  const memo = new Map();
  const memoFor = (selector, id) => {
    if (!memo.has(selector)) {
      const stub = new StubNode('div');
      if (id) stub.id = id;
      /* Parented to the root so `pager.after(panel)` lands in a real tree and a
         later querySelector finds what the panel built. */
      root.append(stub);
      memo.set(selector, stub);
    }
    return memo.get(selector);
  };

  const document = {
    readyState: 'complete',
    documentElement: new StubNode('html'),
    body: root,
    title: '',
    createElement: tag => new StubNode(tag),
    createTreeWalker: () => ({nextNode: () => null}),
    querySelector: selector => root.querySelector(selector) || memoFor(selector, selector.startsWith('#') ? selector.slice(1) : ''),
    querySelectorAll: selector => root.querySelectorAll(selector),
    getElementById: id => root.querySelector(`#${id}`) || memoFor(`#${id}`, id),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  document.documentElement.setAttribute('lang', 'zh-CN');

  const listeners = new Map();
  const storage = new Map();
  const localStorage = {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  };

  /* The sandbox IS the window. A vm context does not link `window` to its own
     global object the way a browser does, and the page's scripts rely on that
     link in two ways that are not negotiable: assets/locale/*.js call a bare
     `MSI18N` after assets/i18n.js assigned `window.MSI18N`, and the UMD
     wrappers take their `typeof window !== 'undefined'` branch. Making the
     context object its own `window` restores both. */
  const sandbox = {
    document, localStorage, console,
    location: {hash},
    history: {replaceState() {}},
    navigator: {platform: 'Win32', clipboard: {writeText: () => Promise.resolve()}},
    fetch: () => Promise.resolve({ok: false, json: () => Promise.resolve({})}),
    innerHeight: 800,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener() {},
    dispatchEvent: () => true,
    scrollTo() {}, scrollBy() {},
    URLSearchParams,
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    IntersectionObserver: class { observe() {} disconnect() {} unobserve() {} },
    requestAnimationFrame: fn => { fn(); return 0; },
    NodeFilter: {SHOW_ELEMENT: 1, SHOW_TEXT: 4},
    Node: {ELEMENT_NODE: 1, TEXT_NODE: 3},
    setTimeout, clearTimeout, setInterval, clearInterval,
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const context = vm.createContext(sandbox);
  /* The page's scripts run in index.html's order. `module` stays undefined so
     each UMD wrapper takes its browser branch and assigns onto window -- the
     same branch a <script> tag takes and the one the ordering is about. */
  const errors = [];
  for (const name of RUNNABLE) {
    try {
      vm.runInContext(read(`assets/${name}`), context, {filename: `assets/${name}`});
    } catch (error) {
      errors.push(`${name}: ${error && error.message}`);
    }
  }
  return {window: sandbox, document, root, context, errors, listeners, mapSlot, pager, articleBody};
}

const GLOBALS = ['ExerciseGrader', 'ExerciseStore', 'ExerciseSandbox', 'ExerciseMap', 'ExerciseUI'];

const home = bootPage('');

await check('every index.html script executes without throwing', () => {
  assert.deepEqual(home.errors, []);
});

await check('the five exercise globals are on window after load', () => {
  for (const name of GLOBALS) {
    assert.ok(home.window[name], `window.${name} is missing after loading index.html's scripts`);
  }
  assert.ok(typeof home.window.ExerciseGrader.grade === 'function', 'ExerciseGrader.grade is missing');
  assert.ok(typeof home.window.ExerciseStore.create === 'function', 'ExerciseStore.create is missing');
  assert.ok(typeof home.window.ExerciseSandbox.create === 'function', 'ExerciseSandbox.create is missing');
  assert.ok(typeof home.window.ExerciseMap.render === 'function', 'ExerciseMap.render is missing');
  assert.ok(typeof home.window.ExerciseUI.init === 'function', 'ExerciseUI.init is missing');
});

/* The Task 8 failure, reproduced. exercise-ui.js calls init() at the end of its
   IIFE; init() returns early unless EXERCISE_DATA, ExerciseGrader and
   ExerciseStore are all present. Running the real page in the real order and
   then asking the panel whether it bound its listeners is the direct check --
   and it reads the seeded `#exercisePanel` lookup off the TREE, not off
   document.querySelector, which would hand back a memo stub and always pass. */
await check('ExerciseUI actually bound its listeners (no silent early return)', () => {
  assert.ok(home.window.ExerciseUI, 'window.ExerciseUI is missing');
  const hashchange = home.listeners.get('hashchange') || [];
  assert.ok(hashchange.length > 0, 'nothing bound a hashchange listener');
  // The page booted on the home page, where a panel is correct to be absent:
  // exercise-ui.js onRoute() returns early when the hash names no chapter. The
  // navigation is what has to mount it, so the hash moves first.
  home.window.location.hash = '#chapter-7';
  for (const handler of hashchange) handler({type: 'hashchange'});
  assert.ok(
    home.root.querySelector('#exercisePanel'),
    'no hashchange handler mounted #exercisePanel -- ExerciseUI.init() took its early return',
  );
});

await check('the practice map renders into the #exerciseMap slot', () => {
  assert.ok(INDEX.includes('id="exerciseMap"'), 'index.html has no #exerciseMap slot');
  home.window.ExerciseMap.render();
  assert.ok(
    home.mapSlot.querySelector('.exercise-map'),
    'ExerciseMap.render() painted nothing into #exerciseMap',
  );
});

/* The deep-link case, and the one that matters most: a reader who opens the
   book straight into #chapter-7 must find the panel already there, mounted by
   the page's own startup rather than by a later click. */
const chapter = bootPage('#chapter-7');

await check('a deep link into #chapter-7 mounts the panel on load', () => {
  assert.deepEqual(chapter.errors, []);
  const panel = chapter.root.querySelector('#exercisePanel');
  assert.ok(panel, 'no #exercisePanel after booting at #chapter-7');
  assert.ok(
    panel.querySelector('.exercise-summary'),
    'the panel mounted but has no summary heading',
  );
  assert.ok(
    panel.querySelectorAll('.exercise-card').length > 0,
    'the panel mounted but painted no exercise cards',
  );
});

await check('the panel lands after the pager, not inside the article', () => {
  const panel = chapter.root.querySelector('#exercisePanel');
  assert.equal(panel.parentNode, chapter.root, 'the panel was not inserted into the document tree');
  /* Mounted AFTER .chapter-pager (exercise-ui.js:858). Not "immediately after":
     assets/paper.js also inserts #chapterDiscussion there, and whichever ran
     second ends up closer to the pager. Both placements are below the article
     body in the reader view, which is what the assertion is protecting. */
  assert.ok(
    chapter.root.children.indexOf(panel) > chapter.root.children.indexOf(chapter.pager),
    'the panel was not mounted after the chapter pager',
  );
  assert.equal(
    chapter.articleBody.querySelectorAll('.exercise-panel').length,
    0,
    'the panel leaked into the chapter article body',
  );
});

await check('no Pyodide was fetched while the page loaded (G9)', () => {
  // The sandbox facade spawns its worker on the first run(), not at load. If
  // loading the page had touched it, this list would not be empty.
  assert.deepEqual(chapter.errors, []);
  assert.ok(!chapter.window.location.hash.includes('pyodide'));
});

// Asserted, not just printed: an emptied suite would otherwise report
  // `PASS: 0 passed, 0 failed` and exit 0.
  if (cases < MIN_CASES) {
    console.error(`\nFAIL: only ${cases} cases ran, the floor is ${MIN_CASES} — cases were lost, not fixed`);
    process.exit(1);
  }
  console.log(`\n${failures ? 'FAILED' : 'PASS'}: ${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});