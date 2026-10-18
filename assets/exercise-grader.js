/* Pure grading logic for SILS exercises.
   No DOM, no network, no globals read: the same module runs in the browser and
   under node so the grading rules stay covered by CI without Pyodide. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ExerciseGrader = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PASS_THRESHOLD = 0.8;
  const LLM_WEIGHT = 0.3;

  function clamp01(value) {
    if (typeof value !== 'number' || Number.isNaN(value)) return 0;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }

  function weightOf(check) {
    const value = check && check.weight;
    return typeof value === 'number' && value > 0 ? value : 1;
  }

  function outcomeOf(outcomes, index) {
    const raw = outcomes && outcomes[index];
    if (typeof raw === 'boolean') return { ok: raw, detail: '' };
    if (raw && typeof raw === 'object') {
      return { ok: raw.ok === true, detail: typeof raw.detail === 'string' ? raw.detail : '' };
    }
    return { ok: false, detail: '' };
  }

  function evaluate(checks, outcomes) {
    const list = Array.isArray(checks) ? checks : [];
    const items = list.map((check, index) => {
      const outcome = outcomeOf(outcomes, index);
      return {
        kind: (check && check.kind) || 'unknown',
        weight: weightOf(check),
        ok: outcome.ok,
        detail: outcome.detail,
      };
    });
    let earned = 0;
    let total = 0;
    for (const item of items) {
      total += item.weight;
      if (item.ok) earned += item.weight;
    }
    return { items, earned, total, score: total ? earned / total : 0 };
  }

  /* Keeps every graded check's original position in exercise.checks so the
     caller-supplied outcomes stay index-aligned after the self-assessed ones
     are dropped. */
  function gradedChecks(exercise) {
    const checks = exercise && Array.isArray(exercise.checks) ? exercise.checks : [];
    return checks
      .map((check, index) => ({ check, index }))
      .filter(entry => entry.check && entry.check.kind !== 'self_assessed');
  }

  /* Caller contract: `options.outcomes` is parallel to the FULL exercise.checks
     array — same length, same order, one entry per check (self_assessed ones
     included). Only the graded subset is scored, and each of them reads its
     outcome from its own original index, so filtering can never shift the
     mapping. Consequences of that contract, all deliberate:
       - outcomes shorter than checks -> the missing entries fail closed
         (ok:false) instead of throwing;
       - outcomes longer than checks -> the surplus entries are ignored;
       - a non-positive or NaN weight normalises to 1 rather than throwing.
         The corpus validator is responsible for rejecting bad weights; the
         grader stays fail-safe so a malformed check never blocks a learner. */
  function grade(exercise, input) {
    const source = exercise && typeof exercise === 'object' ? exercise : {};
    const options = input && typeof input === 'object' ? input : {};
    const graded = gradedChecks(source);
    if (!graded.length) {
      return {
        mode: 'self-assessed',
        passed: false,
        score: 0,
        items: [],
        selfAssessed: options.selfAssessment || '',
        llm: null,
      };
    }
    // Re-index the outcomes onto the graded subset using the original positions
    // so evaluate() sees two equal-length arrays aligned index-for-index.
    const outcomes = graded.map(entry => (options.outcomes || [])[entry.index]);
    const deterministic = evaluate(graded.map(entry => entry.check), outcomes);
    const rubric = source.llm_rubric && typeof source.llm_rubric === 'object' ? source.llm_rubric : {};
    const usable = rubric.enabled === true
      && options.llm && typeof options.llm === 'object'
      && typeof options.llm.score === 'number' && !Number.isNaN(options.llm.score);
    const score = usable
      ? deterministic.score * (1 - LLM_WEIGHT) + clamp01(options.llm.score) * LLM_WEIGHT
      : deterministic.score;
    return {
      mode: usable ? 'llm' : 'deterministic',
      passed: score >= PASS_THRESHOLD,
      score,
      items: deterministic.items,
      selfAssessed: '',
      llm: usable ? options.llm : null,
    };
  }

  return { PASS_THRESHOLD, LLM_WEIGHT, clamp01, evaluate, grade };
});
