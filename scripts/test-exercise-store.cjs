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

/* --- Review round: guards, monotonicity and wire format ------------------ */

check('an array chapter slot does not swallow the new record', () => {
  /* An array passes `typeof === 'object'`, so a record written into it lands on
     a non-index property that JSON.stringify drops: read-back is fine until the
     page is reloaded, then the progress is gone. Rebuilding the slot is what
     keeps the flush lossless. */
  const storage = memoryStorage({ 'ms-cookbook.exercise.v1': JSON.stringify({ 'chapter-1': [{ passed: true, score: 0.5 }] }) });
  const store = create({ storage });
  const written = store.write('chapter-1', 'ch01-ex01', { passed: true, score: 0.9 });
  assert.equal(written.passed, true);
  /* Reload the same storage to stand in for a fresh page view. */
  const reloaded = create({ storage });
  const record = reloaded.read('chapter-1', 'ch01-ex01');
  assert.notEqual(record, null);
  assert.equal(record.passed, true);
  assert.equal(record.score, 0.9);
});

check('snapshot skips an array chapter instead of inventing index rows', () => {
  const storage = memoryStorage({ 'ms-cookbook.exercise.v1': JSON.stringify({ 'chapter-1': [{ passed: true }, { passed: false }] }) });
  const rows = create({ storage }).snapshot();
  assert.deepEqual(rows.map(row => row.exercise), []);
});

check('snapshot reports passed as the number 0 or 1, never a boolean', () => {
  /* These rows are POSTed to the sync endpoint, whose `passed` column is an
     Integer — a boolean here is dirty data on the wire. */
  const store = create({ storage: memoryStorage() });
  store.write('chapter-1', 'ch01-ex01', { passed: true });
  store.write('chapter-1', 'ch01-ex02', { passed: false });
  const rows = store.snapshot();
  assert.deepEqual(rows.map(row => row.passed).sort(), [0, 1]);
  for (const row of rows) {
    assert.equal(typeof row.passed, 'number');
    assert.equal(row.passed === 0 || row.passed === 1, true);
  }
});

check('merge never un-passes a record the server has already passed', () => {
  /* Local is newer but failed; the server is older but holds a pass. Monotone
     merge must latch passed=true, exactly as the server's MAX(passed) would. */
  const store = create({ storage: memoryStorage(), now: () => 900 });
  store.write('chapter-1', 'ch01-ex01', { passed: false, score: 0.2 });
  const result = store.merge([{ chapter: 'chapter-1', exercise: 'ch01-ex01', passed: 1, score: 0.8, updated: 400 }]);
  assert.equal(result.changed, 1);
  const merged = store.read('chapter-1', 'ch01-ex01');
  assert.equal(merged.passed, true);
  assert.equal(merged.score, 0.8);
});

check('merge never lowers the score of an already-passed exercise', () => {
  const store = create({ storage: memoryStorage(), now: () => 900 });
  store.write('chapter-1', 'ch01-ex01', { passed: true, score: 1 });
  store.merge([{ chapter: 'chapter-1', exercise: 'ch01-ex01', passed: 0, score: 0, updated: 400 }]);
  const merged = store.read('chapter-1', 'ch01-ex01');
  assert.equal(merged.passed, true);
  assert.equal(merged.score, 1);
});

check('the push-back row carries the merged pass, not the regressing local one', () => {
  /* changed=1 means the caller will ship snapshot() to the server; that payload
     must already hold the monotone value or the write-back re-regresses it. */
  const store = create({ storage: memoryStorage(), now: () => 900 });
  store.write('chapter-1', 'ch01-ex01', { passed: false, score: 0.1 });
  const result = store.merge([{ chapter: 'chapter-1', exercise: 'ch01-ex01', passed: 1, score: 0.7, updated: 400 }]);
  assert.equal(result.changed, 1);
  assert.equal(store.snapshot()[0].passed, 1);
  assert.equal(store.snapshot()[0].score, 0.7);
});

check('merge takes attempts from the winning side even when it is lower', () => {
  /* Documented trade: attempts is a per-device counter and the server copy is
     the accumulated one, so the newer side's value wins the field outright —
     which can lower it. Only passed/score are latched. */
  const store = create({ storage: memoryStorage(), now: () => 900 });
  for (let i = 0; i < 10; i += 1) store.write('chapter-1', 'ch01-ex01', {});
  assert.equal(store.read('chapter-1', 'ch01-ex01').attempts, 10);
  store.merge([{ chapter: 'chapter-1', exercise: 'ch01-ex01', passed: 0, score: 0, attempts: 3, updated: 1000 }]);
  assert.equal(store.read('chapter-1', 'ch01-ex01').attempts, 3);
});

check('merge ignores rows whose chapter or exercise id is not a string', () => {
  const store = create({ storage: memoryStorage() });
  const result = store.merge([
    { chapter: 1, exercise: 'ch01-ex01', passed: 1 },
    { chapter: 'chapter-1', exercise: 2, passed: 1 },
    { chapter: '', exercise: 'ch01-ex01', passed: 1 },
  ]);
  assert.equal(result.records.length, 0);
  assert.equal(store.read('chapter-1', 'ch01-ex01'), null);
});

check("a self-assessment of 'fail' is not counted as self-assessed progress", () => {
  const store = create({ storage: memoryStorage() });
  store.write('chapter-1', 'ch01-ex01', { passed: false, selfAssessed: 'fail' });
  store.write('chapter-1', 'ch01-ex02', { passed: false, selfAssessed: 'pass' });
  const summary = store.chapterSummary('chapter-1', ['ch01-ex01', 'ch01-ex02']);
  assert.equal(summary.selfAssessed, 1);
});

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log('\nPASS: exercise store');
