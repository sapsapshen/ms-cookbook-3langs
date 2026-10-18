'use strict';
const assert = require('node:assert/strict');
const G = require('../assets/exercise-grader.js');

let failures = 0;
function check(name, fn) {
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

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log('\nPASS: exercise grader');
