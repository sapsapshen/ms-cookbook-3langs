/* Unit checks for assets/exercise-map.js.

   The learning map is two halves with very different risk. aggregate() decides
   which cell shows which of three states, and it is the half that has already
   been wrong once in this feature: Task 4 found a caller reading per-exercise
   state out of chapterSummary(), which returns COUNTS only, so every exercise
   rendered as "not done" no matter what the learner had earned. The tests below
   are built around that failure mode rather than around the happy path.

   What is NOT faked: assets/exercises.js, assets/content.js and
   assets/exercise-store.js are loaded from source and run for real. The map's
   whole job is to pair the corpus with the progress store, so a pair of stubs
   would agree on anything -- including the bug.
*/
'use strict';
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const vm = require('node:vm');
const {Node, parseSelector} = require('./test-exercise-ui-harness.cjs');

const ROOT = resolve(__dirname, '..');
const MAP = readFileSync(resolve(ROOT, 'assets/exercise-map.js'), 'utf8');
const {aggregate, render, GLYPH} = require('../assets/exercise-map.js');

/* A floor on the number of cases. Deleting every `check(...)` below leaves
 * `failures` at 0 and exits 0, so an emptied suite would ship as a green CI run
 * proving nothing. The floor sits below the current count on purpose: adding
 * cases on purpose must never trip it, only losing them should. */
const MIN_CASES = 40;

let failures = 0;
let cases = 0;
function check(name, fn) {
  cases += 1;
  try { fn(); console.log(`  ok  ${name}`); }
  catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); }
}

/* ------------------------------------------------------------------ fixtures */

const DATA = {
  chapters: {
    'chapter-1': { chapter: 'chapter-1', number: 1, partIndex: 0, count: 2, exercises: { zh: [{ id: 'ch01-ex01' }, { id: 'ch01-ex02' }] } },
    'chapter-7': { chapter: 'chapter-7', number: 7, partIndex: 2, count: 1, exercises: { zh: [{ id: 'ch07-ex01' }] } },
  },
};
const PARTS = [{ title: '第一篇' }, { title: '第二篇' }, { title: '第三篇' }];
const BOOK = new Map([['chapter-1', { title: '认识模型' }], ['chapter-7', { title: '第一个结果' }]]);

/* A store over a fixed set of records. `chapterSummary` is deliberately
   available but WRONG on purpose: it reports counts, so any caller that reads
   per-exercise state out of it sees nothing. Tests assert against `read`. */
function fakeStore(records, summaryOverride) {
  return {
    read: (chapterId, id) => records[`${chapterId}/${id}`] || null,
    chapterSummary: (chapterId, ids) => {
      if (summaryOverride) return summaryOverride;
      let passed = 0; let selfAssessed = 0;
      for (const id of ids) {
        const record = records[`${chapterId}/${id}`];
        if (!record) continue;
        if (record.passed) passed += 1;
        else if (record.selfAssessed && record.selfAssessed !== 'fail') selfAssessed += 1;
      }
      return { total: ids.length, passed, selfAssessed };
    },
  };
}

/* The real store, over a Map-backed localStorage. */
function realStore(seed) {
  const storage = new Map(Object.entries(seed || {}));
  const context = vm.createContext({
    console, JSON, Object, Array, Math, String, Number, Date,
    localStorage: {
      getItem: key => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: key => storage.delete(key),
    },
  });
  vm.runInContext(readFileSync(resolve(ROOT, 'assets/exercise-store.js'), 'utf8'), context);
  const store = context.ExerciseStore.create({});
  return {store, storage, raw: JSON.stringify(seed || {})};
}

/* A document just big enough for the map: createElement, getElementById, and
   the query surface the assertions below use. The map never touches anything
   else, so a full DOM implementation would be a dependency with no payoff. */
function fakeDocument(host) {
  const byId = new Map();
  if (host) byId.set(host.id || 'exerciseMap', host);
  return {
    createElement: tag => new Node(tag),
    getElementById: id => byId.get(id) || null,
    querySelector: selector => host.querySelector(selector),
    querySelectorAll: selector => host.querySelectorAll(selector),
  };
}

/* Installs the globals render() resolves at call time, and hands back a
   restore so one test's fake window cannot leak into the next. */
function withPage(settings, fn) {
  const saved = {window: global.window, document: global.document};
  const host = new Node('div');
  host.id = 'exerciseMap';
  global.window = settings.window;
  global.document = fakeDocument(host);
  try { return fn({host}); }
  finally { global.window = saved.window; global.document = saved.document; }
}

function chapterCells(host) { return host.querySelectorAll('.exercise-map-cell'); }
function dotsOf(cell) { return cell.querySelector('.exercise-map-dots').textContent; }

/* --------------------------------------------------------- the shipped corpus */

const corpus = vm.createContext({window: {}, console});
vm.runInContext(readFileSync(resolve(ROOT, 'assets/content.js'), 'utf8'), corpus);
vm.runInContext(readFileSync(resolve(ROOT, 'assets/exercises.js'), 'utf8'), corpus);
const BOOK_DATA = corpus.window.BOOK_DATA;
const EXERCISE_DATA = corpus.window.EXERCISE_DATA;
const bookChapters = new Map(BOOK_DATA.chapters.map(chapter => [chapter.id, chapter]));

console.log('ExerciseMap.aggregate');

check('groups chapters under their part in book order', () => {
  // Two rows, not three: the middle part has no exercises, and a row of empty
  // cells is not a map of anything. (The task brief's own first test expected
  // three rows AND expected the empty part to be omitted one test later -- the
  // two cannot both hold. The reference implementation the brief ships omits
  // it, so that is what is asserted here.)
  const rows = aggregate(DATA, fakeStore({}), PARTS, BOOK);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].partTitle, '第一篇');
  assert.equal(rows[1].partTitle, '第三篇');
  assert.equal(rows[1].chapters.length, 1);
  assert.deepEqual(rows.map(row => row.partIndex), [0, 2]);
});

check('a corpus whose keys run backwards still comes out in book order', () => {
  // The chapter map is an object, so its key order is whatever build-exercises
  // wrote -- not the book's. Grouping by insertion order here would put part 3
  // above part 1 and read as a broken table of contents.
  const shuffled = {chapters: {
    'chapter-7': {chapter: 'chapter-7', number: 7, partIndex: 2, exercises: {zh: [{id: 'ch07-ex01'}]}},
    'chapter-1': {chapter: 'chapter-1', number: 1, partIndex: 0, exercises: {zh: [{id: 'ch01-ex01'}, {id: 'ch01-ex02'}]}},
  }};
  const rows = aggregate(shuffled, fakeStore({}), PARTS, BOOK);
  assert.deepEqual(rows.map(row => row.partTitle), ['第一篇', '第三篇']);
  assert.deepEqual(rows[0].chapters.map(chapter => chapter.number), [1]);
});

check('a graded pass is read as a pass, whatever else the record holds', () => {
  const rows = aggregate(DATA, fakeStore({ 'chapter-1/ch01-ex01': {passed: true, attempts: 3, score: 1} }), PARTS, BOOK);
  assert.equal(rows[0].chapters[0].states[0], 'passed');
  assert.equal(GLYPH[rows[0].chapters[0].states[0]], '✓');
});

check('omits parts that have no exercises', () => {
  const rows = aggregate(DATA, fakeStore({}), PARTS, BOOK);
  assert.equal(rows.find(row => row.partTitle === '第二篇'), undefined);
});

check('counts total exercises across the book', () => {
  const rows = aggregate(DATA, fakeStore({}), PARTS, BOOK);
  assert.equal(rows.reduce((sum, row) => sum + row.total, 0), 3);
});

check('marks a passed exercise', () => {
  const rows = aggregate(DATA, fakeStore({ 'chapter-1/ch01-ex01': { passed: true } }), PARTS, BOOK);
  assert.equal(rows[0].chapters[0].states[0], 'passed');
});

check('marks a self-assessed exercise distinctly from a pass', () => {
  const rows = aggregate(DATA, fakeStore({ 'chapter-1/ch01-ex01': { selfAssessed: 'partial' } }), PARTS, BOOK);
  assert.equal(rows[0].chapters[0].states[0], 'self');
});

check('marks an untouched exercise as todo', () => {
  const rows = aggregate(DATA, fakeStore({}), PARTS, BOOK);
  assert.deepEqual(rows[0].chapters[0].states, ['todo', 'todo']);
});

check('tolerates a chapter missing from the book index', () => {
  const rows = aggregate(DATA, fakeStore({}), PARTS, new Map());
  assert.equal(rows[0].chapters[0].title, 'chapter-1');
});

console.log('ExerciseMap.aggregate · the Task 4 regression');

check('reads per-exercise state from read(), never from chapterSummary()', () => {
  // The bug this feature already shipped once: chapterSummary() hands back
  // counts, so a caller that looked there for a per-exercise state found
  // nothing and every cell read "todo". A summary that claims three passes for
  // a chapter whose exercises are all untouched must not move the states.
  const lying = fakeStore({}, {total: 2, passed: 2, selfAssessed: 0});
  const rows = aggregate(DATA, lying, PARTS, BOOK);
  assert.deepEqual(rows[0].chapters[0].states, ['todo', 'todo']);
  assert.equal(rows[0].chapters[0].passed, 0);
});

check('counts passes from the states it actually rendered', () => {
  const rows = aggregate(DATA, fakeStore({
    'chapter-1/ch01-ex01': { passed: true },
    'chapter-1/ch01-ex02': { selfAssessed: 'pass' },
  }), PARTS, BOOK);
  assert.equal(rows[0].chapters[0].passed, 1);
  assert.equal(rows[0].chapters[0].self, 1);
  assert.equal(rows[0].passed, 1);
  assert.equal(rows[0].self, 1);
  assert.equal(rows[0].total, 2);
});

console.log('ExerciseMap.aggregate · three states');

check("a self-assessment of 'fail' is not a pass", () => {
  const rows = aggregate(DATA, fakeStore({ 'chapter-1/ch01-ex01': { selfAssessed: 'fail' } }), PARTS, BOOK);
  assert.equal(rows[0].chapters[0].states[0], 'todo');
  assert.equal(rows[0].chapters[0].self, 0);
});

check("a self-assessment of 'hint' still counts as a self claim", () => {
  const rows = aggregate(DATA, fakeStore({ 'chapter-1/ch01-ex01': { selfAssessed: 'hint' } }), PARTS, BOOK);
  assert.equal(rows[0].chapters[0].states[0], 'self');
});

check('a graded pass outranks a self-assessment on the same record', () => {
  const rows = aggregate(DATA, fakeStore({
    'chapter-1/ch01-ex01': { passed: true, selfAssessed: 'partial' },
  }), PARTS, BOOK);
  assert.equal(rows[0].chapters[0].states[0], 'passed');
  assert.equal(rows[0].chapters[0].self, 0);
});

check('survives a store that is missing, or missing read()', () => {
  assert.deepEqual(aggregate(DATA, null, PARTS, BOOK)[0].chapters[0].states, ['todo', 'todo']);
  assert.deepEqual(aggregate(DATA, {}, PARTS, BOOK)[0].chapters[0].states, ['todo', 'todo']);
});

console.log('ExerciseMap.aggregate · empty and malformed input');

check('a chapter with no exercises is left out of the grid', () => {
  const empty = {chapters: {'chapter-1': {chapter: 'chapter-1', number: 1, partIndex: 0, count: 0, exercises: {zh: []}}}};
  const rows = aggregate(empty, fakeStore({}), [{title: '第一篇'}], BOOK);
  assert.deepEqual(rows, []);
});

check('a chapter whose localized list is missing contributes nothing and throws nothing', () => {
  const broken = {chapters: {'chapter-1': {chapter: 'chapter-1', number: 1, partIndex: 0, exercises: {}}}};
  assert.deepEqual(aggregate(broken, fakeStore({}), PARTS, BOOK), []);
});

check('an exercise entry with no id is dropped rather than read as a blank cell', () => {
  const partial = {chapters: {'chapter-1': {chapter: 'chapter-1', number: 1, partIndex: 0, exercises: {zh: [{id: 'ch01-ex01'}, null, {nope: true}]}}}};
  const rows = aggregate(partial, fakeStore({}), PARTS, BOOK);
  assert.deepEqual(rows[0].chapters[0].states, ['todo']);
  assert.equal(rows[0].total, 1);
});

check('a chapter with no partIndex groups under the first part', () => {
  const loose = {chapters: {'chapter-1': {chapter: 'chapter-1', number: 1, exercises: {zh: [{id: 'a'}]}}}};
  const rows = aggregate(loose, fakeStore({}), PARTS, BOOK);
  assert.equal(rows[0].partTitle, '第一篇');
});

check('an unknown partIndex still produces a row rather than dropping a chapter', () => {
  const ahead = {chapters: {'chapter-9': {chapter: 'chapter-9', number: 9, partIndex: 4, exercises: {zh: [{id: 'a'}]}}}};
  const rows = aggregate(ahead, fakeStore({}), PARTS, BOOK);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].partTitle, 'Part 5');
});

check('empty data is empty output', () => {
  assert.deepEqual(aggregate(null, fakeStore({}), PARTS, BOOK), []);
  assert.deepEqual(aggregate({}, fakeStore({}), PARTS, BOOK), []);
});

console.log('ExerciseMap.aggregate · purity');

check('aggregate() is pure: it mutates none of its arguments', () => {
  const data = JSON.parse(JSON.stringify(DATA));
  const parts = JSON.parse(JSON.stringify(PARTS));
  const book = new Map(BOOK);
  const store = fakeStore({ 'chapter-1/ch01-ex01': { passed: true } });
  const before = JSON.stringify(data);
  aggregate(data, store, parts, book);
  assert.equal(JSON.stringify(data), before);
  assert.equal(parts.length, 3);
  assert.equal(book.size, 2);
});

check('aggregate() is pure: the same input gives the same output', () => {
  const store = fakeStore({ 'chapter-7/ch07-ex01': { selfAssessed: 'partial' } });
  assert.deepEqual(aggregate(DATA, store, PARTS, BOOK), aggregate(DATA, store, PARTS, BOOK));
});

check('aggregate() is pure: it reads the store and never writes to it', () => {
  const calls = [];
  const store = {
    read: (chapterId, id) => { calls.push(['read', chapterId, id]); return null; },
    write: () => { throw new Error('aggregate must not write progress'); },
  };
  aggregate(DATA, store, PARTS, BOOK);
  assert.ok(calls.length > 0);
});

console.log('ExerciseMap.aggregate · the shipped corpus');

check('follows BOOK_DATA.parts order and the book chapter order', () => {
  const rows = aggregate(EXERCISE_DATA, fakeStore({}), BOOK_DATA.parts, bookChapters);
  assert.ok(rows.length > 0);
  // Matched against the SAME expression the map uses, so this stays a real
  // ordering assertion: comparing against `part.title` would leave findIndex
  // returning -1 for every row, and [-1,-1,-1] is trivially sorted.
  const partIndexes = rows.map(row => BOOK_DATA.parts.findIndex(part => (part.shortTitle || part.title) === row.partTitle));
  assert.deepEqual(partIndexes, [...partIndexes].sort((a, b) => a - b));
  for (const row of rows) {
    const numbers = row.chapters.map(chapter => chapter.number);
    assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
  }
});

check('every shipped chapter lands under the part the book files it in', () => {
  const rows = aggregate(EXERCISE_DATA, fakeStore({}), BOOK_DATA.parts, bookChapters);
  const grouped = new Map();
  for (const row of rows) for (const chapter of row.chapters) grouped.set(chapter.chapter, row.partIndex);
  for (const [id, chapter] of Object.entries(EXERCISE_DATA.chapters)) {
    assert.equal(grouped.get(id), chapter.partIndex, `${id} is grouped under the wrong part`);
  }
});

check('titles come from the book, not from the exercise ids', () => {
  const rows = aggregate(EXERCISE_DATA, fakeStore({}), BOOK_DATA.parts, bookChapters);
  const titles = rows.flatMap(row => row.chapters).map(chapter => chapter.title);
  for (const title of titles) assert.ok(!/^chapter-\d+$/.test(title), title);
});

check('the shipped corpus accounts for every exercise it declares', () => {
  const rows = aggregate(EXERCISE_DATA, fakeStore({}), BOOK_DATA.parts, bookChapters);
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  const declared = Object.values(EXERCISE_DATA.chapters)
    .reduce((sum, chapter) => sum + (chapter.exercises.zh || []).length, 0);
  assert.equal(total, declared);
});

console.log('ExerciseMap.render');

const LANG_WINDOW = data => ({
  EXERCISE_DATA: data,
  BOOK_DATA,
  MSI18N: {t: key => key, has: () => false},
  // A real store over empty storage: the map refuses to paint without one, so a
  // page that is only missing progress storage still has to be exercised.
  ExerciseStore: {create: () => realStore().store},
});

check('renders one cell per chapter, in part order', () => {
  withPage({window: LANG_WINDOW(EXERCISE_DATA)}, ({host}) => {
    render(host);
    const rows = aggregate(EXERCISE_DATA, fakeStore({}), BOOK_DATA.parts, bookChapters);
    assert.equal(chapterCells(host).length, rows.reduce((sum, row) => sum + row.chapters.length, 0));
    assert.equal(host.querySelectorAll('.exercise-map-part').length, rows.length);
  });
});

check('every cell links to its own chapter', () => {
  withPage({window: LANG_WINDOW(EXERCISE_DATA)}, ({host}) => {
    render(host);
    const cells = chapterCells(host);
    assert.ok(cells.length > 0);
    for (const cell of cells) {
      const href = cell.getAttribute('href');
      assert.match(href, /^#chapter-\d+$/, href);
      assert.equal(href, '#' + cell.dataset.chapter);
      assert.ok(bookChapters.has(cell.dataset.chapter), cell.dataset.chapter);
    }
  });
});

check('the three states render as three different glyphs', () => {
  const {store} = realStore();
  store.write('chapter-7', 'ch07-ex01', {passed: true, score: 1});
  store.write('chapter-7', 'ch07-ex02', {selfAssessed: 'partial'});
  store.write('chapter-7', 'ch07-ex03', {selfAssessed: 'fail'});
  withPage({window: Object.assign(LANG_WINDOW(EXERCISE_DATA), {ExerciseStore: {create: () => store}})}, ({host}) => {
    render(host);
    const cell = chapterCells(host).find(node => node.dataset.chapter === 'chapter-7');
    assert.ok(cell, 'chapter-7 cell missing');
    assert.equal(dotsOf(cell), GLYPH.passed + GLYPH.self + GLYPH.todo);
    assert.equal(GLYPH.passed, '✓');
    assert.equal(GLYPH.self, '~');
    assert.equal(GLYPH.todo, '○');
  });
});

check("a self-assessment of 'fail' renders as not done", () => {
  const {store} = realStore();
  store.write('chapter-13', 'ch13-ex01', {selfAssessed: 'fail'});
  withPage({window: Object.assign(LANG_WINDOW(EXERCISE_DATA), {ExerciseStore: {create: () => store}})}, ({host}) => {
    render(host);
    const cell = chapterCells(host).find(node => node.dataset.chapter === 'chapter-13');
    assert.equal(dotsOf(cell), GLYPH.todo.repeat(3));
    assert.ok(!dotsOf(cell).includes(GLYPH.self));
  });
});

check('progress written through the store reaches the grid', () => {
  // The end-to-end version of the Task 4 regression: a real record, written
  // through the real store, has to show up as a pass on the grid.
  const {store} = realStore();
  store.write('chapter-7', 'ch07-ex01', {passed: true, score: 1});
  withPage({window: Object.assign(LANG_WINDOW(EXERCISE_DATA), {ExerciseStore: {create: () => store}})}, ({host}) => {
    render(host);
    const cell = chapterCells(host).find(node => node.dataset.chapter === 'chapter-7');
    assert.equal(dotsOf(cell).slice(0, 1), GLYPH.passed);
    assert.equal(host.querySelector('.exercise-map-total').textContent, 'exercise.mapTotal');
  });
});

check('the map re-reads storage on every paint instead of trusting an old copy', () => {
  // ExerciseStore.create() snapshots localStorage once. A store cached at page
  // load still believes in the progress the learner had NOT earned yet: the
  // pass they earn later is written through the panel's own store instance, and
  // only reaches this one through storage. Painting twice around the write is
  // the end-to-end form of that rule.
  const {store, storage} = realStore();
  const created = [];
  const window = Object.assign(LANG_WINDOW(EXERCISE_DATA), {ExerciseStore: {
    create() { created.push(true); return store; },
  }});
  withPage({window}, ({host}) => {
    render(host);
    const cell = () => chapterCells(host).find(node => node.dataset.chapter === 'chapter-7');
    assert.equal(dotsOf(cell()), GLYPH.todo.repeat(3));
    store.write('chapter-7', 'ch07-ex01', {passed: true, score: 1});
    render(host);
    assert.equal(dotsOf(cell()).slice(0, 1), GLYPH.passed);
    // One store per paint, not one per page: a cached store is exactly the bug.
    assert.equal(created.length, 2);
    assert.ok(storage.size > 0, 'the pass never reached storage');
  });
});

check('rendering twice replaces the grid instead of stacking a second one', () => {
  withPage({window: LANG_WINDOW(EXERCISE_DATA)}, ({host}) => {
    render(host);
    render(host);
    assert.equal(host.querySelectorAll('.exercise-map').length, 1);
    assert.equal(host.querySelectorAll('.exercise-map-head').length, 1);
  });
});

check('a chapter with no exercises renders nothing and throws nothing', () => {
  const empty = {chapters: {'chapter-1': {chapter: 'chapter-1', number: 1, partIndex: 0, exercises: {zh: []}}}};
  const {store} = realStore();
  withPage({window: Object.assign({EXERCISE_DATA: empty, BOOK_DATA, MSI18N: {t: key => key}}, {ExerciseStore: {create: () => store}})}, ({host}) => {
    render(host);
    assert.equal(host.querySelectorAll('.exercise-map-cell').length, 0);
    assert.equal(host.querySelectorAll('.exercise-map').length, 0);
  });
});

check('no container, no data or no store leaves the view alone', () => {
  const saved = {window: global.window, document: global.document};
  try {
    // No #exerciseMap in the document at all.
    global.window = LANG_WINDOW(EXERCISE_DATA);
    global.document = fakeDocument(null);
    render();

    // A container, but a page that never loaded the corpus.
    global.window = {BOOK_DATA, MSI18N: {t: key => key}};
    global.document = fakeDocument(new Node('div'));
    render();

    // A container and a corpus, but no store (storage module missing).
    global.window = LANG_WINDOW(EXERCISE_DATA);
    global.document = fakeDocument(new Node('div'));
    render();
  } finally { global.window = saved.window; global.document = saved.document; }
});

check('a missing translation falls back to the key without throwing', () => {
  const {store} = realStore();
  const noI18n = {EXERCISE_DATA: EXERCISE_DATA, BOOK_DATA, ExerciseStore: {create: () => store}};
  withPage({window: noI18n}, ({host}) => {
    render(host);
    assert.ok(chapterCells(host).length > 0);
    assert.equal(host.querySelector('.exercise-map-head').textContent.includes('undefined'), false);
  });
});

check('the map survives a corpus entry with no matching book chapter', () => {
  const orphan = {
    title: 'x', version: 1, languages: ['zh'], exerciseCount: 1,
    chapters: {'chapter-99': {chapter: 'chapter-99', number: 99, partIndex: 0, exercises: {zh: [{id: 'ch99-ex01'}]}}},
  };
  const {store} = realStore();
  withPage({window: Object.assign({EXERCISE_DATA: orphan, BOOK_DATA, MSI18N: {t: key => key}}, {ExerciseStore: {create: () => store}})}, ({host}) => {
    render(host);
    const cell = chapterCells(host)[0];
    assert.equal(cell.getAttribute('href'), '#chapter-99');
    assert.ok(cell.textContent.includes('chapter-99'));
  });
});

console.log('ExerciseMap · page wiring');

const INDEX = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
const PAPER = readFileSync(resolve(ROOT, 'assets/paper.js'), 'utf8');

check('the practice view keeps its scene cards and gains a map slot before them', () => {
  const practice = /<main data-page="practice"[^>]*>([\s\S]*?)<\/main>/.exec(INDEX);
  assert.ok(practice, 'practice view not found');
  const body = practice[1];
  assert.ok(body.includes('id="sceneGrid"'), 'the scene cards are gone');
  assert.ok(body.includes('id="exerciseMap"'), 'the map has no slot in the practice view');
  assert.ok(body.indexOf('id="exerciseMap"') < body.indexOf('id="sceneGrid"'), 'the map must come before the scene cards');
});

check('paper.js paints the map wherever it paints the scenes', () => {
  assert.equal(PAPER.split('renderScenes();').length - 1, 2, 'renderScenes() call sites changed');
  assert.equal(PAPER.split('renderScenes();renderExerciseMap()').length - 1, 1);
  assert.equal(PAPER.split('renderScenes(); renderExerciseMap()').length - 1, 1);
  assert.match(PAPER, /function renderExerciseMap\(\)/);
});

check('renderExerciseMap is defined after renderScenes and before it is called', () => {
  assert.ok(PAPER.indexOf('function renderScenes()') < PAPER.indexOf('function renderExerciseMap()'));
  assert.ok(PAPER.indexOf('function renderExerciseMap()') < PAPER.indexOf('renderScenes(); renderExerciseMap()'));
});

check('the map is repainted when the reader arrives at the practice view', () => {
  // Paint-on-load alone would show the reader the progress they had when the
  // page loaded, not the progress they have now: doing the exercises and then
  // opening this view has to repaint, or the map contradicts the panel.
  assert.match(PAPER, /if\(view==='practice'\)renderExerciseMap\(\);/);
  assert.equal(PAPER.split('renderExerciseMap()').length - 1, 4);
});

check('the map is wired into the page after the corpus and store it reads', () => {
  // Task 10 owns the <script> tags. It listed them, so this assertion is now
  // the positive form of the placeholder it replaced: the map has to come
  // after the corpus and the store it reads, and before paper.js, which paints
  // the grid on startup. Listed too early, render() finds no data and no store
  // and paints nothing -- the state the checks above were written against.
  const order = [...INDEX.matchAll(/<script\b[^>]*\ssrc="assets\/([^"?]+\.js)/g)].map(m => m[1]);
  const at = name => {
    const index = order.indexOf(name);
    assert.notEqual(index, -1, `${name} is not loaded by index.html`);
    return index;
  };
  assert.ok(at('exercises.js') < at('exercise-map.js'), 'the map loads before the corpus it reads');
  assert.ok(at('exercise-store.js') < at('exercise-map.js'), 'the map loads before the store it reads');
  assert.ok(at('exercise-map.js') < at('paper.js'), 'the map must load before the router that paints it');
});

console.log('ExerciseMap · part names agree with paper.js');

/* The bug these lock. Every locale carries partName.01-partName.08 today, so
   the fallback never fires and the map looked fine -- while disagreeing with
   the rest of the site on the one input that reaches it. assets/paper.js:43
   falls back to `shortTitle || title`; the map reached for `title` alone, so a
   language missing one part name would have shown
   「第三篇　跑得起：让第一个开源模型工作起来」 next to a sidebar reading
   「让模型工作起来」. One book, two names. */
const NO_PART_NAMES = {
  // A language whose dictionary has chapter names but no part names -- the
  // exact state of a locale Task 11 has not filled in yet.
  MSI18N: {t: (key) => key, has: key => !key.startsWith('partName.')},
};

check('a language missing partName.NN falls back to the same string paper.js would use', () => {
  const {store} = realStore();
  const window = Object.assign({EXERCISE_DATA, BOOK_DATA, ExerciseStore: {create: () => store}}, NO_PART_NAMES);
  withPage({window}, ({host}) => {
    render(host);
    const headings = host.querySelectorAll('.exercise-map-part h3');
    assert.ok(headings.length > 0, 'no part heading was rendered');
    // paper.js:43 -- `(data.parts[index].shortTitle || data.parts[index].title)`.
    const expected = BOOK_DATA.parts.map(part => part.shortTitle || part.title);
    for (const heading of headings) {
      const printed = heading.children[0].textContent;
      assert.ok(expected.includes(printed), `map printed a part name paper.js never produces: ${printed}`);
      // And it must NOT be the long form, which is the whole point.
      assert.ok(!BOOK_DATA.parts.some(part => part.title === printed),
        `map fell back to the full part title: ${printed}`);
    }
  });
});

check('aggregate() resolves the same part name paper.js resolves', () => {
  // The same rule one layer down, on the shipped book data: shortTitle wins,
  // title is only there for a part that has none.
  const rows = aggregate(EXERCISE_DATA, fakeStore({}), BOOK_DATA.parts, bookChapters);
  for (const row of rows) {
    const part = BOOK_DATA.parts[row.partIndex];
    assert.ok(part, `part ${row.partIndex} is not in the book`);
    assert.equal(row.partTitle, part.shortTitle || part.title);
  }
});

check('a part with no shortTitle still names itself, and an unknown part is not dropped', () => {
  const parts = [{title: '第一篇　认识开源模型', shortTitle: '认识开源模型'}];
  const rows = aggregate(DATA, fakeStore({}), parts, BOOK);
  assert.equal(rows[0].partTitle, '认识开源模型');
  // No shortTitle at all: paper.js falls back to title, so the map does too --
  // not to `Part 1`, which is a name the rest of the site never shows.
  const bare = aggregate(DATA, fakeStore({}), [{title: '第一篇　认识开源模型'}], BOOK);
  assert.equal(bare[0].partTitle, '第一篇　认识开源模型');
  // Neither field: still a row.
  assert.equal(aggregate(DATA, fakeStore({}), [{}], BOOK)[0].partTitle, 'Part 1');
});

check('the fallback lives in the map and paper.js still uses the same expression', () => {
  // Both sides are asserted, not just the map's: if paper.js drops `shortTitle`
  // the site halves again, and the fix belongs at both ends, not one.
  assert.match(MAP, /part\.shortTitle \|\| part\.title \|\| `Part /);
  assert.match(PAPER, /data\.parts\[index\]\.shortTitle \|\| data\.parts\[index\]\.title/);
});

console.log('ExerciseMap · focus styling');

const EXERCISE_CSS = readFileSync(resolve(ROOT, 'assets/exercise.css'), 'utf8');

check('a map cell declares its own :focus-visible, without taking over the outline', () => {
  // The cell is a real <a href>, so it is in the tab order. assets/reading.css:83
  // draws the ring; this rule is what balances it against `:hover` instead of
  // leaving focus as the one pointer-free state with no fill of its own.
  assert.match(EXERCISE_CSS, /\.exercise-map-cell:focus-visible\s*\{[^}]*\}/);
  // The load-bearing half. Restating outline/outline-offset here at a higher
  // specificity would be the one way to break keyboard focus site-wide, so the
  // rule has to stay out of the global rule's properties.
  const rule = /\.exercise-map-cell:focus-visible\s*\{([^}]*)\}/.exec(EXERCISE_CSS)[1];
  assert.ok(!/\boutline\b/.test(rule), `the cell rule overrides the global outline: ${rule}`);
  // Balanced with :hover, not a second accent competing with it.
  assert.match(rule, /background:\s*var\(--selected\)/);
});

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
// Asserted, not just printed: a suite emptied of cases still exits 0.
if (cases < MIN_CASES) {
  console.error(`\nFAIL: only ${cases} cases ran, the floor is ${MIN_CASES} — cases were lost, not fixed`);
  process.exit(1);
}
console.log(`\nPASS: exercise map aggregation (${cases} cases)`);
