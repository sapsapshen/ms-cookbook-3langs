'use strict';
const assert = require('node:assert/strict');
const { create } = require('../assets/exercise-store.js');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); }
}

function memoryStorage(initial) {
  const data = Object.assign(Object.create(null), initial || {});
  return {
    getItem: key => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: key => { delete data[key]; },
    _data: data,
  };
}

console.log('ExerciseStore');

check('an unknown exercise reads as null', () => {
  const store = create({ storage: memoryStorage() });
  assert.equal(store.read('chapter-1', 'ch01-ex01'), null);
});

check('write stores a record and read returns it', () => {
  const store = create({ storage: memoryStorage() });
  const written = store.write('chapter-1', 'ch01-ex01', { passed: true, score: 1 });
  assert.equal(written.passed, true);
  assert.equal(store.read('chapter-1', 'ch01-ex01').passed, true);
});

check('attempts increment on every write', () => {
  const store = create({ storage: memoryStorage() });
  store.write('chapter-1', 'ch01-ex01', { code: 'a' });
  store.write('chapter-1', 'ch01-ex01', { code: 'b' });
  assert.equal(store.read('chapter-1', 'ch01-ex01').attempts, 2);
});

check('a second write keeps the best score instead of degrading it', () => {
  const store = create({ storage: memoryStorage() });
  store.write('chapter-1', 'ch01-ex01', { passed: true, score: 1 });
  store.write('chapter-1', 'ch01-ex01', { passed: true, score: 0.8 });
  assert.equal(store.read('chapter-1', 'ch01-ex01').score, 1);
});

check('a later failure never clears an earlier pass', () => {
  const store = create({ storage: memoryStorage() });
  store.write('chapter-1', 'ch01-ex01', { passed: true });
  store.write('chapter-1', 'ch01-ex01', { passed: false });
  assert.equal(store.read('chapter-1', 'ch01-ex01').passed, true);
});

check('write always refreshes the updated stamp', () => {
  let clock = 1000;
  const store = create({ storage: memoryStorage(), now: () => (clock += 1) });
  const first = store.write('chapter-1', 'ch01-ex01', {});
  const second = store.write('chapter-1', 'ch01-ex01', {});
  assert.equal(second.updated > first.updated, true);
});

check('snapshot flattens every chapter into rows', () => {
  const store = create({ storage: memoryStorage() });
  store.write('chapter-1', 'ch01-ex01', { passed: true });
  store.write('chapter-2', 'ch02-ex01', { score: 0.5 });
  const rows = store.snapshot();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].chapter, 'chapter-1');
  assert.equal(rows[0].exercise, 'ch01-ex01');
});

check('merge adopts server rows the client has never seen', () => {
  const store = create({ storage: memoryStorage(), now: () => 500 });
  const result = store.merge([{ chapter: 'chapter-1', exercise: 'ch01-ex01', passed: 1, score: 1, updated: 400 }]);
  assert.equal(result.changed, 0);
  assert.equal(store.read('chapter-1', 'ch01-ex01').passed, true);
});

check('merge lets a newer local record win', () => {
  const store = create({ storage: memoryStorage(), now: () => 900 });
  store.write('chapter-1', 'ch01-ex01', { passed: true, score: 1 });
  const result = store.merge([{ chapter: 'chapter-1', exercise: 'ch01-ex01', passed: 0, score: 0, updated: 400 }]);
  assert.equal(result.changed, 1);
  assert.equal(store.read('chapter-1', 'ch01-ex01').passed, true);
});

check('merge lets a newer server record win', () => {
  const store = create({ storage: memoryStorage(), now: () => 300 });
  store.write('chapter-1', 'ch01-ex01', { passed: false, score: 0 });
  store.merge([{ chapter: 'chapter-1', exercise: 'ch01-ex01', passed: 1, score: 1, updated: 800 }]);
  assert.equal(store.read('chapter-1', 'ch01-ex01').passed, true);
});

check('an equal stamp resolves in favour of passing', () => {
  const store = create({ storage: memoryStorage(), now: () => 600 });
  store.write('chapter-1', 'ch01-ex01', { passed: false });
  store.merge([{ chapter: 'chapter-1', exercise: 'ch01-ex01', passed: 1, updated: 600 }]);
  assert.equal(store.read('chapter-1', 'ch01-ex01').passed, true);
});

check('merge ignores malformed rows without throwing', () => {
  const store = create({ storage: memoryStorage() });
  const result = store.merge([null, { chapter: 'chapter-1' }, { exercise: 'ch01-ex01' }, 42]);
  assert.equal(Array.isArray(result.records), true);
});

check('chapter summary counts only the given exercise ids', () => {
  const store = create({ storage: memoryStorage() });
  store.write('chapter-1', 'ch01-ex01', { passed: true, score: 1 });
  store.write('chapter-1', 'ch01-ex02', { selfAssessed: 'pass' });
  const summary = store.chapterSummary('chapter-1', ['ch01-ex01', 'ch01-ex02', 'ch01-ex03']);
  assert.equal(summary.total, 3);
  assert.equal(summary.passed, 1);
  assert.equal(summary.selfAssessed, 1);
});

check('summary aggregates across chapters', () => {
  const store = create({ storage: memoryStorage() });
  store.write('chapter-1', 'ch01-ex01', { passed: true });
  store.write('chapter-2', 'ch02-ex01', { passed: true });
  const summary = store.summary({ 'chapter-1': ['ch01-ex01'], 'chapter-2': ['ch02-ex01'] });
  assert.equal(summary.total, 2);
  assert.equal(summary.passed, 2);
});

check('an unavailable storage degrades to memory without throwing', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const store = create({ storage: broken });
  assert.equal(store.available, false);
  store.write('chapter-1', 'ch01-ex01', { passed: true });
  assert.equal(store.read('chapter-1', 'ch01-ex01').passed, true);
});

check('corrupted stored JSON is discarded rather than fatal', () => {
  const storage = memoryStorage({ 'ms-cookbook.exercise.v1': '{not json' });
  const store = create({ storage });
  assert.deepEqual(store.snapshot(), []);
});

check('a code payload beyond the cap is trimmed before storing', () => {
  const store = create({ storage: memoryStorage() });
  store.write('chapter-1', 'ch01-ex01', { code: 'x'.repeat(25000) });
  assert.equal(store.read('chapter-1', 'ch01-ex01').code.length, 20000);
});

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log('\nPASS: exercise store');
