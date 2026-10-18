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

let failures = 0;
let passed = 0;
async function check(name, fn) {
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
        assert.equal(prompt, item.prompt, `${item.id}: prompt text was altered`);
        assert.ok(prompt.trim().length > 0, `${item.id}: empty prompt`);
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
      if (body.querySelector('.exercise-fallback')) fallbacks.push(item.id);
    }
  }
  assert.deepEqual(fallbacks, [], 'these predict exercises could not parse their options');
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

console.log(`\n${failures ? 'FAIL' : 'PASS'}: ${passed} passed, ${failures} failed — the shipped corpus renders end to end`);
  process.exit(failures ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});