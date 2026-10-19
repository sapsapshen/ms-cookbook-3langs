'use strict';
const assert = require('node:assert/strict');
const { create } = require('../assets/exercise-store.js');

/* A floor on the number of cases. Deleting every `check(...)` below leaves
 * `failures` at 0 and exits 0, so an emptied suite would ship as a green CI run
 * proving nothing. The floor sits below the current count on purpose: adding
 * cases on purpose must never trip it, only losing them should. */
const MIN_CASES = 32;

let failures = 0;
let cases = 0;
function check(name, fn) {
  cases += 1;
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

check('a tie that only the server passed still reports the row as adopted', () => {
  /* Equal stamps, local not passed, server passed. The latch fires either way —
     `merged.passed` is unconditional — so the row IS adopted locally, and
     `records` is the only signal the caller gets for that. Without the
     tie-break this row changes data while landing in NEITHER list: records=0
     (looks unadopted) and changed=0 (nothing to push back). The assertion below
     is therefore the thing that distinguishes the two implementations; the
     passed/score checks alone pass in both. */
  const store = create({ storage: memoryStorage(), now: () => 600 });
  store.write('chapter-1', 'ch01-ex01', { passed: false, score: 0.4 });
  const result = store.merge([{ chapter: 'chapter-1', exercise: 'ch01-ex01', passed: 1, score: 0.9, updated: 600 }]);
  const merged = store.read('chapter-1', 'ch01-ex01');
  assert.equal(merged.passed, true);
  assert.equal(merged.score, 0.9);
  /* changed stays 0: the server already holds the pass, so there is nothing to
     write back — which is exactly why `records` has to carry the adoption. */
  assert.equal(result.changed, 0);
  assert.equal(result.records.length, 1);
  assert.equal(result.records[0].chapterId, 'chapter-1');
  assert.equal(result.records[0].exerciseId, 'ch01-ex01');
  assert.equal(result.records[0].record.passed, true);
  assert.equal(result.records[0].record.score, 0.9);
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

/* --- Review round 2: the sync boundary ------------------------------------ */

check('every self-assessment state survives a round trip through the wire', () => {
  /* snapshot() is what the sync endpoint POSTs, so whatever it drops is lost on
     the next merge. 'fail' in particular must stay exactly 'fail': the server
     used to answer 'graded', which this function counts as progress. */
  for (const state of ['pass', 'partial', 'fail', '']) {
    const store = create({ storage: memoryStorage(), now: () => 1750000000 });
    store.write('chapter-1', 'ch01-ex01', { passed: false, selfAssessed: state });
    assert.equal(store.snapshot()[0].selfAssessed, state);
    const reloaded = create({ storage: memoryStorage() });
    reloaded.merge(store.snapshot());
    assert.equal(reloaded.read('chapter-1', 'ch01-ex01').selfAssessed, state);
  }
});

check("a server 'fail' merged in is still not counted as progress", () => {
  /* The end of the bug: server answers 'fail' -> merge() adopts it ->
     chapterSummary must not count it. With the old 'graded' mapping the row
     arrived as a truthy non-'fail' string and counted. */
  const store = create({ storage: memoryStorage(), now: () => 1750000000 });
  store.merge([{ chapter: 'chapter-1', exercise: 'ch01-ex01', passed: 0, score: 0, selfAssessed: 'fail', updated: 1750000100 }]);
  assert.equal(store.read('chapter-1', 'ch01-ex01').selfAssessed, 'fail');
  assert.equal(store.chapterSummary('chapter-1', ['ch01-ex01']).selfAssessed, 0);
});

check("a server 'partial' merged in IS counted as progress", () => {
  /* The other side of the same boundary: 'partial' is honest progress and must
     not be flattened into '' along with the unreadable states. */
  const store = create({ storage: memoryStorage(), now: () => 1750000000 });
  store.merge([{ chapter: 'chapter-1', exercise: 'ch01-ex01', passed: 0, score: 0, selfAssessed: 'partial', updated: 1750000100 }]);
  assert.equal(store.read('chapter-1', 'ch01-ex01').selfAssessed, 'partial');
  assert.equal(store.chapterSummary('chapter-1', ['ch01-ex01']).selfAssessed, 1);
});

check('a self-assessment can be revised in both directions', () => {
  /* Unlike passed/score there is nothing to latch: the learner re-reading the
     answer turns 'fail' into 'pass', and a bad day turns it back. */
  const store = create({ storage: memoryStorage() });
  store.write('chapter-1', 'ch01-ex01', { selfAssessed: 'pass' });
  store.write('chapter-1', 'ch01-ex01', { selfAssessed: 'fail' });
  assert.equal(store.read('chapter-1', 'ch01-ex01').selfAssessed, 'fail');
  store.write('chapter-1', 'ch01-ex01', { selfAssessed: 'partial' });
  assert.equal(store.read('chapter-1', 'ch01-ex01').selfAssessed, 'partial');
});

check('the default clock stamps seconds, not milliseconds', () => {
  /* The unit has to match the server's int(time.time()), because merge()
     compares the two numbers directly. Date.now() is ~1000x too large, so the
     local row would win every single sync and the server's copy would never be
     read back. */
  const store = create({ storage: memoryStorage() });
  const written = store.write('chapter-1', 'ch01-ex01', {});
  assert.equal(written.updated, Math.floor(Date.now() / 1000));
  assert.equal(written.updated < 1e11, true);
});

check('a millisecond stamp left by the old build is folded on read', () => {
  /* Progress already in localStorage keeps its millisecond stamp, and a
     not-yet-redeployed server answers in milliseconds too. normalize() is the
     single choke point both go through, so folding there migrates them without
     a separate pass over storage. */
  const storage = memoryStorage({
    'ms-cookbook.exercise.v1': JSON.stringify({ 'chapter-1': { 'ch01-ex01': { passed: true, score: 1, updated: 1750000000123 } } }),
  });
  const store = create({ storage });
  assert.equal(store.read('chapter-1', 'ch01-ex01').updated, 1750000000);
  assert.equal(store.snapshot()[0].updated, 1750000000);
});

check('an incoming millisecond row no longer outranks a newer local second row', () => {
  /* The failure this fixes, end to end: local work at 1750000500s versus a
     server row stamped 1750000000000ms. Unfolded, the server wins forever. */
  const store = create({ storage: memoryStorage(), now: () => 1750000500 });
  store.write('chapter-1', 'ch01-ex01', { passed: true, score: 1 });
  const result = store.merge([{ chapter: 'chapter-1', exercise: 'ch01-ex01', passed: 0, score: 0, updated: 1750000000123 }]);
  assert.equal(store.read('chapter-1', 'ch01-ex01').passed, true);
  assert.equal(result.changed, 1);
});

/* --- Review round 3: batch size and the value that leaves this store ------- */

check('a score above 1 is clamped to 1 on the way out', () => {
  /* The server validates le=1. A record scoring 1.7 used to leave this store
     untouched and fail there, and before per-row validation that failed the
     reader's whole sync batch. The clamp belongs on both sides of the wire. */
  const store = create({ storage: memoryStorage() });
  store.write('chapter-1', 'ch01-ex01', { score: 1.7 });
  assert.equal(store.read('chapter-1', 'ch01-ex01').score, 1);
  assert.equal(store.snapshot()[0].score, 1);
});

check('a negative or non-numeric score still folds to 0', () => {
  const storage = memoryStorage({
    'ms-cookbook.exercise.v1': JSON.stringify({
      'chapter-1': { 'ch01-ex01': { score: -3 }, 'ch01-ex02': { score: 'high' } },
    }),
  });
  const store = create({ storage });
  assert.equal(store.read('chapter-1', 'ch01-ex01').score, 0);
  assert.equal(store.read('chapter-1', 'ch01-ex02').score, 0);
});

check('the clamp does not disturb a score inside the range', () => {
  const store = create({ storage: memoryStorage() });
  store.write('chapter-1', 'ch01-ex01', { score: 0.75 });
  assert.equal(store.read('chapter-1', 'ch01-ex01').score, 0.75);
});

check('chunks splits the snapshot without dropping or duplicating a row', () => {
  /* The server counts write REQUESTS, so a reader with more rows than one
     batch holds sends them in slices. Every row must appear exactly once. */
  const store = create({ storage: memoryStorage() });
  for (let i = 1; i <= 25; i += 1) store.write('chapter-1', `ch01-ex${String(i).padStart(2, '0')}`, { passed: true });
  const parts = store.chunks(10);
  assert.deepEqual(parts.map(part => part.length), [10, 10, 5]);
  const flat = parts.flat();
  assert.equal(flat.length, 25);
  assert.equal(new Set(flat.map(row => row.exercise)).size, 25);
  assert.deepEqual(flat, store.snapshot());
});

check('chunks on an empty store returns no batches', () => {
  const store = create({ storage: memoryStorage() });
  assert.deepEqual(store.chunks(10), []);
});

check('chunks falls back to one batch for a size it cannot use', () => {
  /* A zero, a negative number or nothing at all must not return an empty array
     of batches — that is the shape that would silently sync nothing. */
  const store = create({ storage: memoryStorage() });
  store.write('chapter-1', 'ch01-ex01', {});
  store.write('chapter-2', 'ch02-ex01', {});
  for (const size of [undefined, 0, -5, 2.5, 'ten']) {
    const parts = store.chunks(size);
    assert.equal(parts.length, 1, `size ${size}`);
    assert.equal(parts[0].length, 2, `size ${size}`);
  }
});

/* --- Review round 4: the two rows merge() used to forget ------------------ */

check('a row the server has never seen still schedules a write-back', () => {
  /* merge() used to walk `rows` only, so a row the server never returned could
     never reach `changed`: the reader did the exercise on this device, the
     count stayed 0, pushBack() never fired, and the work was reachable from no
     other device for the life of the account. syncProgress() is a one-shot push
     after each verdict with no retry and no offline queue, so one refused batch
     or one dropped connection made it permanent. */
  const store = create({ storage: memoryStorage(), now: () => 500 });
  store.write('chapter-1', 'ch01-ex01', { passed: true, score: 1 });
  const result = store.merge([]);
  assert.equal(result.changed, 1);
  /* changed is a COUNT, which is what pullProgress() consumes
     (`if (result.changed > 0)`), and the payload it ships is snapshot() — so
     "is the row in the write-back" is answered by the snapshot, not by changed. */
  assert.equal(typeof result.changed, 'number');
  const rows = store.snapshot();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].chapter, 'chapter-1');
  assert.equal(rows[0].exercise, 'ch01-ex01');
  assert.equal(rows[0].passed, 1);
  assert.equal(rows[0].score, 1);
});

check('only the rows the server is missing are written back, not the one it has', () => {
  /* Three local rows, the server answers for one of them — with exactly the
     values this device holds. Counting every local row would ship work the
     server already has; counting only the answered one is the bug itself. The
     two the server never mentioned are the payload. */
  const store = create({ storage: memoryStorage(), now: () => 500 });
  store.write('chapter-1', 'ch01-ex01', { passed: true, score: 1 });
  store.write('chapter-1', 'ch01-ex02', { passed: true, score: 1 });
  store.write('chapter-1', 'ch01-ex03', { passed: false, score: 0.2 });
  const result = store.merge([{ chapter: 'chapter-1', exercise: 'ch01-ex01', passed: 1, score: 1, updated: 500 }]);
  assert.equal(result.changed, 2);
  /* The answered row agreed with the server and was left alone; the two unknown
     ones kept the values this device earned. */
  assert.equal(result.records.length, 0);
  const byId = Object.fromEntries(store.snapshot().map(row => [row.exercise, row]));
  assert.equal(byId['ch01-ex02'].passed, 1);
  assert.equal(byId['ch01-ex03'].score, 0.2);
});

check('a write-back the server already agrees with is not scheduled', () => {
  /* The quota is 20 writes per 60 seconds and it counts REQUESTS, so a pull
     that changes nothing must schedule nothing: otherwise every chapter entry
     spends a write on a no-op and the reader can be refused for work they are
     actually doing. Identical passed, identical score, identical stamp. */
  const store = create({ storage: memoryStorage(), now: () => 500 });
  store.write('chapter-1', 'ch01-ex01', { passed: true, score: 1 });
  const row = { chapter: 'chapter-1', exercise: 'ch01-ex01', passed: 1, score: 1, updated: 500 };
  assert.equal(store.merge([row]).changed, 0);
  /* And again, so a steady state really is a steady state. */
  assert.equal(store.merge([row]).changed, 0);
});

check('a local pass the server has not accepted is written back', () => {
  /* merge() latches `passed` — merged.passed = incoming.passed || local.passed
     — and then put the row in `records` as a server row, so changed stayed 0.
     The badge said "passed" on this device and the server said 0, permanently:
     a pass the client knows about and never sends. The server's MAX(passed)
     cannot help, because it only ever sees what the client ships. */
  const store = create({ storage: memoryStorage(), now: () => 500 });
  store.write('chapter-1', 'ch01-ex01', { passed: true, score: 0.6, code: 'print(1)' });
  const result = store.merge([{ chapter: 'chapter-1', exercise: 'ch01-ex01', passed: 0, score: 0, updated: 900 }]);
  assert.equal(result.changed, 1);
  /* The row that ships is the MERGED one: latched pass, ratcheted score. The
     snapshot is the payload, so this is what the server would receive. */
  const row = store.snapshot()[0];
  assert.equal(row.passed, 1);
  assert.equal(row.score, 0.6);
  /* And once the server holds it, the next pull is a no-op — the monotonicity
     promise is closed in both directions. */
  assert.equal(store.merge([{ chapter: 'chapter-1', exercise: 'ch01-ex01', passed: 1, score: 0.6, updated: 900 }]).changed, 0);
});

check('a local score the server has not caught up with is written back', () => {
  /* The same hole on the score axis: the server row is newer, so it wins the
     timestamp and is adopted, but the ratchet leaves the higher local score on
     the row and nothing reported it. */
  const store = create({ storage: memoryStorage(), now: () => 500 });
  store.write('chapter-1', 'ch01-ex01', { passed: false, score: 0.9 });
  const result = store.merge([{ chapter: 'chapter-1', exercise: 'ch01-ex01', passed: 0, score: 0.3, updated: 900 }]);
  assert.equal(result.changed, 1);
  assert.equal(store.snapshot()[0].score, 0.9);
});

check('a row the pull did not ask about is not declared unknown', () => {
  /* pullProgress() requests one chapter at a time, so an absent row only means
     "unknown" INSIDE that chapter. Sweeping every chapter would declare the
     reader's other work unknown on every chapter entry and spend a write each
     time — the duplicate write-back this scoping exists to prevent. */
  const store = create({ storage: memoryStorage(), now: () => 500 });
  store.write('chapter-1', 'ch01-ex01', { passed: true });
  store.write('chapter-2', 'ch02-ex01', { passed: true });
  assert.equal(store.merge([], 'chapter-1').changed, 1);
  assert.equal(store.merge([], 'chapter-2').changed, 1);
  /* Unscoped, the same answer is exact: the pull saw everything. */
  assert.equal(store.merge([]).changed, 2);
});

check('a chapter pull does not count the row it adopted as missing', () => {
  /* The sweep runs after the loop, over the buckets the loop just wrote — so a
     row adopted from the server has to be excluded or every pull would report
     the very rows it just imported. */
  const store = create({ storage: memoryStorage(), now: () => 500 });
  const result = store.merge([{ chapter: 'chapter-1', exercise: 'ch01-ex01', passed: 1, score: 1, updated: 400 }], 'chapter-1');
  assert.equal(result.records.length, 1);
  assert.equal(result.changed, 0);
});

check('a row pushed while the pull was open is not written back twice', () => {
  /* A pull is a round trip the reader spends working: entering a chapter pulls,
     and a Run can land before the answer does. The answer then describes a
     moment before the row existed, so reading "absent" as "never seen" would
     ship it again -- one exercise against a 20-writes-per-minute quota, spent
     twice. `inFlight` is what the caller already sent during this request. */
  const store = create({ storage: memoryStorage(), now: () => 500 });
  store.write('chapter-1', 'ch01-ex01', { passed: true, score: 1 });
  assert.equal(store.merge([], 'chapter-1', [{ chapter: 'chapter-1', exercise: 'ch01-ex01' }]).changed, 0);
  /* A row whose push did NOT land is not listed, so it still counts: one
     duplicate write is recoverable, a result that never leaves the device is
     not. */
  store.write('chapter-1', 'ch01-ex02', { passed: true, score: 1 });
  assert.equal(store.merge([], 'chapter-1', [{ chapter: 'chapter-1', exercise: 'ch01-ex01' }]).changed, 1);
});

check('the in-flight list does not excuse the NEXT pull', () => {
  /* A pull that completed makes the server's own answer the authority again.
     Carrying the exclusion forward would exempt rows the server genuinely
     does not hold from every later sweep -- how one recovered row becomes a
     permanent no-op. The caller clears its list; this asserts merge() holds no
     memory of its own between calls. */
  const store = create({ storage: memoryStorage(), now: () => 500 });
  store.write('chapter-1', 'ch01-ex01', { passed: true, score: 1 });
  assert.equal(store.merge([], 'chapter-1', [{ chapter: 'chapter-1', exercise: 'ch01-ex01' }]).changed, 0);
  assert.equal(store.merge([], 'chapter-1').changed, 1);
});

check('a malformed in-flight entry is ignored rather than fatal', () => {
  const store = create({ storage: memoryStorage(), now: () => 500 });
  store.write('chapter-1', 'ch01-ex01', { passed: true });
  const result = store.merge([], 'chapter-1', [null, 42, { chapter: 1 }, { exercise: 'x' }, {}]);
  assert.equal(result.changed, 1);
});

check('the write-back row shape is the wire shape pushBack() sends', () => {
  /* snapshot() IS the push-back payload, so its keys have to be exactly what
     ExerciseItem validates on the server side — a missing or misnamed key is a
     row the sync endpoint skips, which is the same silent loss this round is
     about. */
  const store = create({ storage: memoryStorage(), now: () => 1750000500 });
  store.write('chapter-1', 'ch01-ex01', { passed: true, score: 0.75, code: 'print(1)', selfAssessed: 'partial' });
  store.merge([]);
  const row = store.snapshot()[0];
  assert.deepEqual(
    Object.keys(row).sort(),
    ['attempts', 'chapter', 'code', 'exercise', 'passed', 'score', 'selfAssessed', 'updated'],
  );
  assert.equal(typeof row.passed, 'number');
  assert.equal(typeof row.score, 'number');
  assert.equal(typeof row.updated, 'number');
  assert.equal(row.updated, 1750000500);
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
console.log(`\nPASS: exercise store (${cases} cases)`);
