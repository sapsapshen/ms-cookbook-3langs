'use strict';
const assert = require('node:assert/strict');
const G = require('../assets/exercise-grader.js');

/* A floor on the number of cases. Deleting every `check(...)` below leaves
 * `failures` at 0 and exits 0, so an emptied suite would ship as a green CI run
 * proving nothing. The floor sits below the current count on purpose: adding
 * cases on purpose must never trip it, only losing them should. */
const MIN_CASES = 26;

let failures = 0;
let cases = 0;
function check(name, fn) {
  cases += 1;
  try { fn(); console.log(`  ok  ${name}`); }
  catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); }
}

console.log('ExerciseGrader');

check('exposes the 0.8 pass threshold', () => {
  assert.equal(G.PASS_THRESHOLD, 0.8);
});

check('weighted score sums earned over total', () => {
  const result = G.evaluate(
    [{ kind: 'a', weight: 3 }, { kind: 'b', weight: 1 }],
    [true, false]);
  assert.equal(result.earned, 3);
  assert.equal(result.total, 4);
  assert.equal(result.score, 0.75);
});

check('defaults a missing weight to 1', () => {
  const result = G.evaluate([{ kind: 'a' }], [true]);
  assert.equal(result.total, 1);
  assert.equal(result.score, 1);
});

check('accepts boolean and object outcomes alike', () => {
  const result = G.evaluate([{ kind: 'a', weight: 1 }, { kind: 'b', weight: 1 }], [true, { ok: true, detail: 'fine' }]);
  assert.equal(result.score, 1);
  assert.equal(result.items[1].detail, 'fine');
});

/* --- strict boolean handling for object outcomes -----------------------------
   The grader is the only authority on pass/fail, so an outcome object must
   carry a literal `true` to count as passing. Any other value -- including
   truthy ones like 1, 'yes' or {} -- is a malformed outcome and must fail
   closed, otherwise a buggy sandbox runner would hand out a pass badge. */

check('an outcome object with ok:true counts as passing', () => {
  const result = G.evaluate([{ kind: 'a', weight: 1 }], [{ ok: true, detail: 'fine' }]);
  assert.equal(result.items[0].ok, true);
  assert.equal(result.earned, 1);
  assert.equal(result.score, 1);
});

check('a truthy non-boolean ok is not silently treated as a pass', () => {
  const result = G.evaluate(
    [{ kind: 'a', weight: 1 }, { kind: 'b', weight: 1 }, { kind: 'c', weight: 1 }],
    [{ ok: 1, detail: 'one' }, { ok: 'yes', detail: 'string' }, { ok: {}, detail: 'object' }]);
  assert.deepEqual(result.items.map(item => item.ok), [false, false, false]);
  assert.equal(result.earned, 0);
  assert.equal(result.score, 0);
});

check('a truthy non-boolean ok never reaches the pass badge through grade', () => {
  const exercise = { checks: [{ kind: 'stdout_equals', weight: 1 }, { kind: 'stdout_contains', weight: 1 }] };
  const outcome = G.grade(exercise, { outcomes: [{ ok: 1 }, { ok: 'yes' }] });
  assert.equal(outcome.score, 0);
  assert.equal(outcome.passed, false);
  assert.deepEqual(outcome.items.map(item => item.ok), [false, false]);
});

check('falsy ok values fail rather than pass', () => {
  const result = G.evaluate(
    [{ kind: 'a', weight: 1 }, { kind: 'b', weight: 1 }, { kind: 'c', weight: 1 }, { kind: 'd', weight: 1 }],
    [{ ok: 0 }, { ok: '' }, { ok: false }, { ok: null }]);
  assert.deepEqual(result.items.map(item => item.ok), [false, false, false, false]);
  assert.equal(result.score, 0);
});

check('a missing ok field fails closed', () => {
  const result = G.evaluate(
    [{ kind: 'a', weight: 1 }, { kind: 'b', weight: 1 }],
    [{ detail: 'no ok at all' }, {}]);
  assert.deepEqual(result.items.map(item => item.ok), [false, false]);
  assert.equal(result.score, 0);
});

check('strictness holds at grade level for mixed ok values', () => {
  const exercise = { checks: [{ kind: 'a', weight: 1 }, { kind: 'b', weight: 1 }] };
  const outcome = G.grade(exercise, { outcomes: [{ ok: true }, { ok: 1 }] });
  assert.equal(outcome.score, 0.5);
  assert.equal(outcome.passed, false);
});

check('a non-object, non-boolean outcome never passes', () => {
  const result = G.evaluate(
    [{ kind: 'a', weight: 1 }, { kind: 'b', weight: 1 }, { kind: 'c', weight: 1 }],
    [1, 'true', null]);
  assert.deepEqual(result.items.map(item => item.ok), [false, false, false]);
  assert.equal(result.score, 0);
});

check('an empty check list scores zero rather than dividing by zero', () => {
  const result = G.evaluate([], []);
  assert.equal(result.total, 0);
  assert.equal(result.score, 0);
});

check('a failing outcome is never silently dropped', () => {
  const result = G.evaluate([{ kind: 'a', weight: 1 }, { kind: 'b', weight: 1 }], [true, false]);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[1].ok, false);
});

check('reflect exercises fall back to self assessment', () => {
  const outcome = G.grade(
    { type: 'reflect', checks: [{ kind: 'self_assessed', weight: 1 }] },
    { selfAssessment: 'pass' });
  assert.equal(outcome.mode, 'self-assessed');
  assert.equal(outcome.passed, false);
  assert.equal(outcome.selfAssessed, 'pass');
});

check('self assessment above threshold still does not count as passing', () => {
  const outcome = G.grade(
    { type: 'reflect', checks: [{ kind: 'self_assessed', weight: 1 }] },
    { selfAssessment: 'pass' });
  assert.equal(outcome.score, 0);
});

check('deterministic grade passes at or above the threshold', () => {
  const exercise = { checks: [{ kind: 'stdout_equals', weight: 4 }, { kind: 'stdout_contains', weight: 1 }] };
  const outcome = G.grade(exercise, { outcomes: [true, false] });
  assert.equal(outcome.mode, 'deterministic');
  assert.equal(outcome.score, 0.8);
  assert.equal(outcome.passed, true);
});

check('a weighted score below the threshold fails', () => {
  const exercise = { checks: [{ kind: 'stdout_equals', weight: 4 }, { kind: 'stdout_contains', weight: 1 }] };
  const outcome = G.grade(exercise, { outcomes: [true, false] });
  assert.equal(outcome.score, 0.8);
  const lower = G.grade(
    { checks: [{ kind: 'a', weight: 4 }, { kind: 'b', weight: 2 }, { kind: 'c', weight: 4 }] },
    { outcomes: [true, true, false] });
  assert.equal(lower.score < 0.8, true);
  assert.equal(lower.passed, false);
});

check('an llm rubric blends into the deterministic score', () => {
  const exercise = {
    checks: [{ kind: 'stdout_contains', weight: 1 }],
    llm_rubric: { enabled: true, criteria: 'explain the trade-off' },
  };
  const outcome = G.grade(exercise, { outcomes: [true], llm: { score: 0.5, feedback: 'partial' } });
  assert.equal(outcome.mode, 'llm');
  assert.equal(outcome.llm.feedback, 'partial');
  assert.equal(outcome.score, 0.85);
});

check('llm feedback is ignored when the rubric is disabled', () => {
  const exercise = { checks: [{ kind: 'stdout_contains', weight: 1 }], llm_rubric: { enabled: false } };
  const outcome = G.grade(exercise, { outcomes: [true], llm: { score: 0, feedback: 'nope' } });
  assert.equal(outcome.mode, 'deterministic');
  assert.equal(outcome.score, 1);
});

check('a missing llm payload degrades to deterministic without warning', () => {
  const exercise = {
    checks: [{ kind: 'stdout_contains', weight: 1 }],
    llm_rubric: { enabled: true, criteria: 'x' },
  };
  const outcome = G.grade(exercise, { outcomes: [true] });
  assert.equal(outcome.mode, 'deterministic');
  assert.equal(outcome.score, 1);
});

check('llm scores are clamped into the unit range', () => {
  const exercise = {
    checks: [{ kind: 'stdout_contains', weight: 1 }],
    llm_rubric: { enabled: true, criteria: 'x' },
  };
  assert.equal(G.grade(exercise, { outcomes: [true], llm: { score: 5 } }).score, 1);
  assert.equal(G.grade(exercise, { outcomes: [true], llm: { score: -3 } }).score, 0.7);
});

check('a non-graded exercise without checks never claims a pass', () => {
  const outcome = G.grade({ type: 'predict', checks: [] }, { outcomes: [] });
  assert.equal(outcome.passed, false);
  assert.equal(outcome.mode, 'self-assessed');
});

check('grade tolerates a missing exercise object', () => {
  const outcome = G.grade(undefined, {});
  assert.equal(outcome.passed, false);
  assert.equal(outcome.mode, 'self-assessed');
});

check('grading does not mutate the exercise it receives', () => {
  const exercise = { checks: [{ kind: 'stdout_contains', weight: 1 }] };
  const before = JSON.stringify(exercise);
  G.grade(exercise, { outcomes: [true] });
  assert.equal(JSON.stringify(exercise), before);
});

check('a self-assessed check leading the list does not shift the outcomes', () => {
  const exercise = {
    checks: [{ kind: 'self_assessed', weight: 1 }, { kind: 'stdout_equals', weight: 1 }],
  };
  const outcome = G.grade(exercise, { outcomes: [false, true] });
  assert.equal(outcome.mode, 'deterministic');
  assert.equal(outcome.score, 1);
  assert.equal(outcome.passed, true);
  assert.equal(outcome.items.length, 1);
  assert.equal(outcome.items[0].kind, 'stdout_equals');
  assert.equal(outcome.items[0].ok, true);
});

check('a self-assessed check in the middle does not shift the outcomes', () => {
  const exercise = {
    checks: [{ kind: 'stdout_equals', weight: 1 }, { kind: 'self_assessed', weight: 1 }, { kind: 'stdout_contains', weight: 1 }],
  };
  const outcome = G.grade(exercise, { outcomes: [true, false, true] });
  assert.equal(outcome.score, 1);
  assert.equal(outcome.passed, true);
  assert.deepEqual(outcome.items.map(item => item.kind), ['stdout_equals', 'stdout_contains']);
  assert.deepEqual(outcome.items.map(item => item.ok), [true, true]);
});

check('a self-assessed check trailing the list does not shift the outcomes', () => {
  const exercise = {
    checks: [{ kind: 'stdout_equals', weight: 1 }, { kind: 'self_assessed', weight: 1 }],
  };
  const outcome = G.grade(exercise, { outcomes: [true, false] });
  assert.equal(outcome.score, 1);
  assert.equal(outcome.passed, true);
  assert.equal(outcome.items.length, 1);
  assert.equal(outcome.items[0].kind, 'stdout_equals');
  assert.equal(outcome.items[0].ok, true);
});

check('llm is ignored when the exercise declares no rubric at all', () => {
  const exercise = { checks: [{ kind: 'stdout_contains', weight: 1 }] };
  const outcome = G.grade(exercise, { outcomes: [true], llm: { score: 0, feedback: 'nope' } });
  assert.equal(outcome.mode, 'deterministic');
  assert.equal(outcome.score, 1);
  assert.equal(outcome.llm, null);
});

check('a non-boolean rubric enabled flag does not turn on the llm path', () => {
  const exercise = {
    checks: [{ kind: 'stdout_contains', weight: 1 }],
    llm_rubric: { enabled: 1, criteria: 'x' },
  };
  const outcome = G.grade(exercise, { outcomes: [true], llm: { score: 0, feedback: 'nope' } });
  assert.equal(outcome.mode, 'deterministic');
  assert.equal(outcome.score, 1);
  assert.equal(outcome.llm, null);
});

check('outcomes shorter than the checks fail closed instead of throwing', () => {
  const exercise = { checks: [{ kind: 'a', weight: 1 }, { kind: 'b', weight: 1 }, { kind: 'c', weight: 1 }] };
  let outcome;
  assert.doesNotThrow(() => { outcome = G.grade(exercise, { outcomes: [true, false] }); });
  assert.equal(outcome.items.length, 3);
  assert.deepEqual(outcome.items.map(item => item.ok), [true, false, false]);
  assert.equal(outcome.score, 1 / 3);
  assert.equal(outcome.passed, false);
});

check('outcomes longer than the checks ignore the surplus entries', () => {
  const exercise = { checks: [{ kind: 'a', weight: 1 }, { kind: 'b', weight: 1 }] };
  let outcome;
  assert.doesNotThrow(() => { outcome = G.grade(exercise, { outcomes: [true, true, false, false, true] }); });
  assert.equal(outcome.items.length, 2);
  assert.deepEqual(outcome.items.map(item => item.ok), [true, true]);
  assert.equal(outcome.score, 1);
  assert.equal(outcome.passed, true);
});

check('a non-positive or NaN weight normalises without throwing', () => {
  const exercise = {
    checks: [
      { kind: 'a', weight: 0 },
      { kind: 'b', weight: -1 },
      { kind: 'c', weight: NaN },
    ],
  };
  let outcome;
  assert.doesNotThrow(() => { outcome = G.grade(exercise, { outcomes: [true, true, true] }); });
  assert.equal(outcome.items.length, 3);
  assert.deepEqual(outcome.items.map(item => item.weight), [1, 1, 1]);
  assert.equal(outcome.score, 1);
  assert.equal(outcome.passed, true);
  // Deterministic: same exercise graded twice yields byte-identical items.
  assert.deepEqual(G.grade(exercise, { outcomes: [true, true, true] }).items, outcome.items);
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
console.log(`\nPASS: exercise grader (${cases} cases)`);
