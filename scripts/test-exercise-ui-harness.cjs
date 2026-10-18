/* UI logic checks for assets/exercise-ui.js.

   The panel is DOM plus four collaborators (grader, store, sandbox, i18n), so
   a small hand-written DOM is enough to drive it and assert on what a reader
   would actually see.

   What is NOT faked: assets/exercise-grader.js and assets/exercise-store.js are
   loaded from source and run for real. The index-alignment contract this file
   exists to protect is a contract BETWEEN those two modules, so a pair of stubs
   would agree on anything, including the bug.

   The sandbox IS faked, on purpose: its real implementation is a Pyodide worker
   (covered by test-exercise-sandbox-real.cjs), and the failure modes the panel
   has to survive -- load failure, timeout, crash, a truncated outcome array --
   are not reachable from a real worker in a unit test. */
'use strict';
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const vm = require('node:vm');

const ROOT = resolve(__dirname, '..');
const UI = readFileSync(resolve(ROOT, 'assets/exercise-ui.js'), 'utf8');
const GRADER = readFileSync(resolve(ROOT, 'assets/exercise-grader.js'), 'utf8');
const STORE = readFileSync(resolve(ROOT, 'assets/exercise-store.js'), 'utf8');

let failures = 0;
let passed = 0;
function check(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(
        () => { passed += 1; console.log(`  ok  ${name}`); },
        error => { failures += 1; console.error(`  FAIL ${name}\n       ${error && error.message}`); },
      );
    }
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${error && error.message}`);
  }
  return Promise.resolve();
}

/* ------------------------------------------------------------------ mini DOM */

class Text {
  constructor(text) { this.textContent = String(text); }
}

class Node {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    // A real dataset reflects BOTH ways: writing `dataset.ok` sets the
    // `data-ok` attribute and reading `getAttribute('data-ok')` sees it. The
    // panel mixes the two freely (`card.dataset.exercise = id`, then queries
    // `[data-exercise="id"]`), so a one-way stub would silently break every
    // assertion that goes through an attribute selector.
    const backing = Object.create(null);
    const self = this;
    this.dataset = new Proxy(backing, {
      get: (target, key) => (typeof key === 'string' ? target[key] : target[key]),
      set(target, key, value) {
        target[key] = value;
        if (typeof key === 'string') self.attributes.set(`data-${camel(String(key))}`, String(value));
        return true;
      },
      deleteProperty(target, key) {
        delete target[key];
        if (typeof key === 'string') self.attributes.delete(`data-${camel(String(key))}`);
        return true;
      },
      has: (target, key) => key in target,
    });
    this._listeners = new Map();
    this._text = '';
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.value = '';
    this.type = '';
    this.spellcheck = true;
    this.placeholder = '';
  }
  get className() { return this.attributes.get('class') || ''; }
  set className(value) { this.attributes.set('class', String(value)); }
  get id() { return this.attributes.get('id') || ''; }
  set id(value) { this.attributes.set('id', String(value)); }
  /* `<label for>` and `label.htmlFor` are the same attribute in a real
     document, and assets/discussion.js writes the property form while any test
     asserting on the association has to read the attribute. Same two-way
     mirroring dataset/className already get above, for the same reason. */
  get htmlFor() { return this.attributes.get('for') || ''; }
  set htmlFor(value) { this.attributes.set('for', String(value)); }
  get textContent() {
    return this._text + this.children.map(child => child.textContent).join('');
  }
  set textContent(value) {
    this.children.length = 0;
    this._text = value === undefined || value === null ? '' : String(value);
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name.startsWith('data-')) this.dataset[camel(name.slice(5))] = String(value);
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); }
  append(...nodes) {
    for (const node of nodes) {
      const child = typeof node === 'string' ? new Text(node) : node;
      child.parentNode = this;
      this.children.push(child);
    }
  }
  replaceChildren(...nodes) {
    this.children.length = 0;
    this._text = '';
    this.append(...nodes);
  }
  after(node) {
    const parent = this.parentNode;
    if (!parent) return;
    node.parentNode = parent;
    parent.children.splice(parent.children.indexOf(this) + 1, 0, node);
  }
  remove() {
    const parent = this.parentNode;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    if (index >= 0) parent.children.splice(index, 1);
    this.parentNode = null;
  }
  addEventListener(type, handler) {
    if (!this._listeners.has(type)) this._listeners.set(type, []);
    this._listeners.get(type).push(handler);
  }
  removeEventListener(type, handler) {
    const list = this._listeners.get(type) || [];
    const index = list.indexOf(handler);
    if (index >= 0) list.splice(index, 1);
  }
  /* Sequential and awaited: the panel's run handler is async, and a test that
     fires it without waiting would assert against a half-built panel. */
  async fire(type) {
    for (const handler of [...(this._listeners.get(type) || [])]) await handler({type, target: this});
  }
  elements() {
    const out = [];
    const walk = node => {
      for (const child of node.children) {
        if (child instanceof Text) continue;
        out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  querySelectorAll(selector) {
    return this.elements().filter(node => selectorMatches(node, this, parseSelector(selector)));
  }
}

/* The selectors the panel actually uses: `#id`, `tag`, `.class`, `[attr]`,
   `[attr="v"]`, compound forms like `.card[data-x="v"]`, and descendant
   combinations of those. */
function matches(node, part) {
  if (part.kind === 'id') return node.getAttribute('id') === part.value;
  if (part.kind === 'attr') return node.getAttribute(part.name) === part.value;
  if (part.kind === 'class') return node.className.split(/\s+/).includes(part.value);
  return node.tagName === part.value;
}

/* Whitespace separates DESCENDANTS. Each whitespace-separated group is a
   compound selector (every simple part inside it must match the same node);
   a selector with N groups must match a node whose ancestor chain matches the
   N-1 groups before it, in order. */
function selectorMatches(node, root, groups) {
  const last = groups[groups.length - 1];
  if (!last.every(part => matches(node, part))) return false;
  let ancestor = node.parentNode;
  for (let index = groups.length - 2; index >= 0; index -= 1) {
    const group = groups[index];
    let found = false;
    while (ancestor && ancestor !== root.parentNode) {
      if (group.every(part => matches(ancestor, part))) { found = true; ancestor = ancestor.parentNode; break; }
      ancestor = ancestor.parentNode;
    }
    if (!found) return false;
  }
  return true;
}

function parseSelector(selector) {
  return selector.trim().split(/\s+/).map(group => {
    const parts = [];
    const pattern = /\[([a-zA-Z-]+)(?:="([^"]*)")?\]|#([\w-]+)|\.([\w-]+)|([\w-]+)/g;
    let match;
    while ((match = pattern.exec(group)) !== null) {
      if (match[1] !== undefined) parts.push({kind: 'attr', name: match[1], value: match[2]});
      else if (match[3] !== undefined) parts.push({kind: 'id', value: match[3]});
      else if (match[4] !== undefined) parts.push({kind: 'class', value: match[4]});
      else parts.push({kind: 'tag', value: match[5].toUpperCase()});
    }
    return parts;
  });
}

function camel(name) { return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }

/* ------------------------------------------------------------------ fixtures */

function exercise(overrides) {
  return Object.assign({
    id: 'ch07-ex01',
    chapter: 'chapter-7',
    type: 'code',
    difficulty: 1,
    minutes: 5,
    objective: '用变量拼接自我介绍',
    prompt: '打印一句话',
    starter: 'name = ""\n',
    checks: [{kind: 'stdout_contains', value: 'hello', weight: 1}],
    llm_rubric: {enabled: false, criteria: ''},
    reference: 'print("hello")',
    explanation: '用 print 输出。',
  }, overrides);
}

function exerciseData(items, extraChapters) {
  const chapters = {
    'chapter-7': {
      chapter: 'chapter-7', number: 7, partIndex: 2,
      count: items.length, minutes: 10,
      exercises: {zh: items, en: items, es: items},
    },
  };
  for (const [id, list] of Object.entries(extraChapters || {})) {
    const number = Number(id.split('-')[1]);
    chapters[id] = {
      chapter: id, number, partIndex: number, count: list.length, minutes: 10,
      exercises: {zh: list, en: list, es: list},
    };
  }
  return {title: 'test', version: 1, languages: ['zh', 'en', 'es'], exerciseCount: items.length, chapters};
}

/* Boots the real grader and store against a fake document. `options.sandbox`
   and `options.fetch` are the seams; everything else is the real thing. */
function boot(options) {
  const settings = options || {};
  const root = new Node('body');
  const pager = new Node('nav');
  pager.className = 'chapter-pager';
  root.append(pager);

  const calls = {run: [], fetch: [], grade: [], sandboxInit: null, langListener: null};
  /* One recording facade for every exercise on the page, so a test can tell
     "never called" from "called by a different question". */
  const impl = settings.sandbox === undefined
    ? {run: () => Promise.resolve({ok: true, outcomes: [], ms: 1}), destroy() {}}
    : settings.sandbox;
  const sandbox = {
    run(request) { calls.run.push(request); return impl.run(request); },
    destroy() { return impl.destroy ? impl.destroy() : undefined; },
  };
  const fetchImpl = settings.fetch || (() => Promise.resolve({ok: false, json: () => Promise.resolve({})}));

  const listeners = new Map();
  const storage = new Map();
  const localStorage = {
    getItem: key => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: key => storage.delete(key),
  };
  const document = {
    createElement: tag => new Node(tag),
    querySelector: selector => root.querySelector(selector),
    querySelectorAll: selector => root.querySelectorAll(selector),
  };
  const location = {hash: settings.hash === undefined ? '#chapter-7' : settings.hash};
  const window = {
    location,
    document,
    EXERCISE_DATA: settings.data === undefined ? exerciseData([exercise()]) : settings.data,
    ExerciseSandbox: settings.noSandbox ? null : {
      create(init) { calls.sandboxInit = init; return sandbox; },
    },
    MSI18N: {
      lang: settings.lang || 'zh',
      t: key => key,
      on(handler) { calls.langListener = handler; return () => { calls.langListener = null; }; },
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    removeEventListener(type, handler) {
      const list = listeners.get(type) || [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    fetch(url, init) { calls.fetch.push({url: String(url), init}); return fetchImpl(url, init); },
  };
  window.window = window;

  const context = vm.createContext({
    window, document, location, localStorage, console,
    Promise, Object, Array, JSON, Math, String, Number, Boolean, Error, Set, Map, Date, RegExp,
    fetch: window.fetch, setTimeout, clearTimeout,
  });
  vm.runInContext(GRADER, context);
  vm.runInContext(STORE, context);
  // Grade through the real implementation, but record what the panel handed it.
  const realGrade = context.ExerciseGrader.grade;
  const graderFacade = {
    PASS_THRESHOLD: context.ExerciseGrader.PASS_THRESHOLD,
    LLM_WEIGHT: context.ExerciseGrader.LLM_WEIGHT,
    grade(input, gradeOptions) {
      calls.grade.push({exercise: input, options: gradeOptions});
      return realGrade(input, gradeOptions);
    },
  };
  // Keep a handle on the store instance the panel itself built. A test must
  // assert against THAT one: create() snapshots localStorage at construction,
  // so a second instance created later would see a stale in-memory copy and a
  // write through it would never reach the panel.
  const realCreate = context.ExerciseStore.create;
  let liveStore = null;
  const storeFacade = Object.assign(Object.create(null), context.ExerciseStore, {
    create(options) {
      const store = realCreate.call(context.ExerciseStore, options);
      if (!liveStore) liveStore = store;
      return store;
    },
  });
  window.ExerciseGraderReal = context.ExerciseGrader;
  window.ExerciseGrader = graderFacade;
  window.ExerciseStore = storeFacade;
  vm.runInContext(UI, context);

  const panel = () => document.querySelector('#exercisePanel');
  return {
    window, document, root, pager, panel, calls, sandbox, listeners, storage,
    store: () => liveStore,
  };
}

/* Sync is deliberately fire-and-forget, so a test that clicks Run has to let
   the promise chain drain before it can assert on what was posted. */
function flush() { return new Promise(resolve => setTimeout(resolve, 0)); }

function cardFor(h, id) { return h.panel().querySelector(`.exercise-card[data-exercise="${id}"]`); }

async function expand(h, id) {
  await cardFor(h, id).querySelector('.exercise-toggle').fire('click');
  return cardFor(h, id).querySelector('.exercise-body');
}

function buttonsIn(root, role) {
  return root.querySelectorAll('button').filter(node => role === undefined || node.dataset.role === role);
}

function rowsIn(root) {
  const list = root.querySelector('.exercise-checks');
  return list ? list.querySelectorAll('li') : [];
}
module.exports = {Node, boot, exercise, exerciseData, cardFor, expand, buttonsIn, rowsIn, flush, parseSelector};
