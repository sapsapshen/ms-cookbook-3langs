'use strict';
/* Renders the REAL corpus (assets/exercises.js) through the panel, so the
   shape assumptions the unit tests encode with fixtures are checked against
   what actually ships. Every one of the 9 exercises is expanded, and the
   grader is the real one. */
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const vm = require('node:vm');
const {boot, expand, buttonsIn, flush} = require('./test-exercise-ui-harness.cjs');

const ROOT = resolve(__dirname, '..');
const DATA = vm.runInNewContext(readFileSync(resolve(ROOT, 'assets/exercises.js'), 'utf8'), {window: {}});

/* A floor on the number of cases. Deleting every `check(...)` below leaves
 * `passed` and `failures` both at 0 and exits 0 — `PASS: 0 passed, 0 failed` —
 * so an emptied suite would ship as a green CI run proving nothing. The floor
 * sits below the current count on purpose: adding cases on purpose must never
 * trip it, only losing them should. */
const MIN_CASES = 5;

let failures = 0;
let passed = 0;
let cases = 0;
async function check(name, fn) {
  cases += 1;
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${error && error.message}`);
  }
}

async function main() {
console.log('exercise panel against the real corpus');

  await check('语料里的每一章都能挂载面板', () => {
  for (const chapterId of Object.keys(DATA.chapters)) {
    const h = boot({data: DATA, hash: `#${chapterId}`});
    assert.ok(h.panel(), `${chapterId}: no panel`);
    const cards = h.panel().querySelectorAll('.exercise-card');
    assert.equal(cards.length, DATA.chapters[chapterId].exercises.zh.length,
      `${chapterId}: card count does not match the corpus`);
  }
});

  await check('每一道题都能展开，且题干/起始代码齐全', async () => {
  const jobs = [];
  for (const chapterId of Object.keys(DATA.chapters)) {
    const h = boot({data: DATA, hash: `#${chapterId}`});
    for (const item of DATA.chapters[chapterId].exercises.zh) {
      jobs.push((async () => {
        const body = await expand(h, item.id);
        const prompt = body.querySelector('.exercise-prompt').textContent;
        // For a choice exercise the prompt paragraph carries the STEM only --
        // the option lines are rendered once, as the checkboxes -- so the
        // assertion is "the stem survives, minus the options it should have
        // handed to the controls", not "the paragraph is the raw string".
        if (item.type === 'predict') {
          assert.ok(prompt.trim().length > 0, `${item.id}: empty prompt`);
          const optionLines = item.prompt.split('\n').filter(line => /^\s*[A-Z][.、)）]\s/.test(line));
          for (const line of optionLines) {
            assert.ok(!prompt.includes(line.trim()), `${item.id}: option "${line.trim()}" was rendered twice`);
          }
          // Every option the prompt lists must be reachable as a checkbox.
          const options = body.querySelectorAll('input').map(node => node.value);
          assert.equal(options.length, optionLines.length,
            `${item.id}: ${options.length} controls for ${optionLines.length} options in the prompt`);
        } else {
          assert.equal(prompt, item.prompt, `${item.id}: prompt text was altered`);
          assert.ok(prompt.trim().length > 0, `${item.id}: empty prompt`);
        }
        if (item.type === 'reflect') {
          assert.ok(body.querySelector('.exercise-editor'), `${item.id}: no reflection box`);
          assert.equal(buttonsIn(body, 'run').length, 0, `${item.id}: a reflect exercise offered Run`);
        } else if (item.type === 'predict') {
          const options = body.querySelectorAll('input').map(node => node.value);
          assert.ok(options.length >= 2, `${item.id}: only ${options.length} options parsed from the prompt`);
          // Every offered option must be one the prompt actually lists.
          for (const letter of options) {
            assert.ok(new RegExp(`^${letter}[.、)）]\\s`, 'm').test(item.prompt),
              `${item.id}: option ${letter} is not in the prompt`);
          }
        } else {
          const editor = body.querySelector('.exercise-editor');
          assert.ok(editor, `${item.id}: no editor`);
          assert.equal(editor.value, item.starter || '', `${item.id}: starter mismatch`);
          assert.equal(buttonsIn(body, 'run').length, 1, `${item.id}: expected exactly one Run button`);
        }
      })());
    }
    await Promise.all(jobs.splice(0));
  }
});

  await check('每道题的 checks 都能被真实判分器消费（参考答案判 100%）', async () => {
  // The strongest available end-to-end signal: the shipped reference answer,
  // graded by the real grader through the real panel, must pass. A panel that
  // misaligns outcomes fails here for the specific exercise that broke.
  for (const chapterId of Object.keys(DATA.chapters)) {
    for (const item of DATA.chapters[chapterId].exercises.zh) {
      if (item.type === 'reflect') continue;
      if (item.type === 'predict') {
        const h = boot({data: DATA, hash: `#${chapterId}`});
        const body = await expand(h, item.id);
        const correct = (item.checks.find(c => c.kind === 'output_choice') || {}).correct || [];
        for (const input of body.querySelectorAll('input')) input.checked = correct.includes(input.value);
        await buttonsIn(body, 'submit')[0].fire('click');
        assert.equal(body.querySelector('.exercise-status').textContent, 'exercise.correct',
          `${item.id}: the reference answer was rejected`);
        continue;
      }
      const checks = item.checks;
      const h = boot({
        data: DATA,
        hash: `#${chapterId}`,
        // Stand in for the worker with the verdict the reference earns: every
        // check satisfied. This checks the panel's plumbing, not the corpus;
        // scripts/check_exercise_references.py is what proves the reference
        // really satisfies the checks under real Pyodide.
        sandbox: {
          run: () => Promise.resolve({
            ok: true, ms: 1,
            outcomes: checks.map(check => ({ok: true, detail: check.kind})),
          }),
          destroy() {},
        },
      });
      const body = await expand(h, item.id);
      body.querySelector('.exercise-editor').value = item.reference;
      await buttonsIn(body, 'run')[0].fire('click');
      assert.equal(body.querySelector('.exercise-status').dataset.tone, 'pass',
        `${item.id}: a fully-satisfied run did not pass`);
      assert.equal(h.store().read(chapterId, item.id).passed, true, `${item.id}: not recorded as passed`);
      assert.equal(h.calls.grade[0].options.outcomes.length, checks.length,
        `${item.id}: outcomes/checks length mismatch`);
    }
  }
});

  await check('语料里每一道题的选项都能被解析（无「选项见题干」回退）', async () => {
  const fallbacks = [];
  for (const chapterId of Object.keys(DATA.chapters)) {
    const h = boot({data: DATA, hash: `#${chapterId}`});
    for (const item of DATA.chapters[chapterId].exercises.zh) {
      if (item.type !== 'predict') continue;
      const body = await expand(h, item.id);
      if (body.querySelector('.exercise-fallback')) {
        fallbacks.push(item.id);
        // The degraded path also refuses to let the reader answer, so a question
        // that parses into something unusable cannot be submitted into a
        // guaranteed-wrong verdict.
        const submit = buttonsIn(body, 'submit')[0];
        assert.ok(submit && submit.disabled, `${item.id}: an unparsable question left Submit enabled`);
      }
    }
  }
  assert.deepEqual(fallbacks, [], 'these predict exercises could not parse their options');
});

await check('语料里配了 rubric 的 reflect 题真的会请求评分接口（LLM 路径不再是死代码）', async () => {
  /* The shipped corpus enables llm_rubric on exactly two exercises, and both
     are `reflect`. Before the reflection path consulted it, no exercise in the
     corpus could reach /api/exercises/grade: expanding all nine and clicking
     every button produced "grade hit? false". This walks the real corpus and
     asserts that every rubric-enabled exercise now asks, and that nothing is
     asked for a rubric that is switched off. */
  const asked = [];
  let enabled = 0;
  for (const chapterId of Object.keys(DATA.chapters)) {
    for (const language of DATA.languages) {
      for (const item of DATA.chapters[chapterId].exercises[language]) {
        if (!item.llm_rubric || item.llm_rubric.enabled !== true) continue;
        enabled += 1;
        const h = boot({
          data: DATA, hash: `#${chapterId}`, lang: language,
          fetch: url => String(url).includes('/api/exercises/grade')
            ? Promise.resolve({ok: false, status: 503, json: () => Promise.resolve({})})
            : Promise.resolve({ok: true, json: () => Promise.resolve({user: null, csrf: '', loginEnabled: true})}),
        });
        const body = await expand(h, item.id);
        // Whichever self-assessment the reader reaches for, the rubric is asked
        // once it is recorded.
        await buttonsIn(body)[0].fire('click');
        await flush();
        const hits = h.calls.fetch.filter(call => call.url.includes('/api/exercises/grade'));
        assert.equal(hits.length, 1, `${item.id}/${language}: expected one grading call, saw ${hits.length}`);
        asked.push(`${item.id}/${language}`);
        // And the answer cannot reach the verdict: a 503 here means there is no
        // opinion at all, and the self-assessment still stands on its own.
        const saved = h.store().read(chapterId, item.id);
        assert.equal(saved.selfAssessed, 'pass', `${item.id}: the self-assessment was not recorded`);
        assert.equal(saved.passed, false, `${item.id}: a self-assessment became a pass`);
        const badge = h.panel().querySelector(`.exercise-card[data-exercise="${item.id}"] .exercise-state`);
        assert.equal(badge.dataset.state, 'self',
          `${item.id}: the badge did not show the self-assessment`);
        assert.equal(body.querySelector('.exercise-llm-advice'), null,
          `${item.id}: a failed grading call still produced an opinion`);
      }
    }
  }
  assert.ok(enabled > 0, 'the corpus ships no rubric-enabled exercise -- the check would be vacuous');
  console.log(`       (rubric-enabled exercises exercised: ${asked.length} across ${DATA.languages.length} languages)`);
});

  await check('三语切换后每一章都能渲染对应语言的题目', () => {
  for (const language of DATA.languages) {
    for (const chapterId of Object.keys(DATA.chapters)) {
      const h = boot({data: DATA, hash: `#${chapterId}`, lang: language});
      const cards = h.panel().querySelectorAll('.exercise-card');
      const expected = DATA.chapters[chapterId].exercises[language];
      assert.ok(expected && expected.length > 0, `${chapterId}/${language}: no exercises shipped`);
      assert.equal(cards.length, expected.length, `${chapterId}/${language}: card count mismatch`);
      assert.equal(
        cards[0].querySelector('.exercise-toggle-title').textContent,
        `${1}. ${expected[0].objective}`,
        `${chapterId}/${language}: wrong language rendered`,
      );
    }
  }
});

  await check('语料中的 exerciseCount 与实际题目数一致', () => {
  let total = 0;
  for (const chapterId of Object.keys(DATA.chapters)) total += DATA.chapters[chapterId].exercises.zh.length;
  assert.equal(DATA.exerciseCount, total);
});

// Asserted, not just printed: an emptied suite would otherwise report
  // `PASS: 0 passed, 0 failed` and exit 0.
  if (cases < MIN_CASES) {
    console.error(`\nFAIL: only ${cases} cases ran, the floor is ${MIN_CASES} — cases were lost, not fixed`);
    process.exit(1);
  }
  console.log(`\n${failures ? 'FAIL' : 'PASS'}: ${passed} passed, ${failures} failed — the shipped corpus renders end to end`);
  process.exit(failures ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});