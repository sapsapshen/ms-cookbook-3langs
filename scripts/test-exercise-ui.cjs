'use strict';
/* UI logic checks for assets/exercise-ui.js. The DOM, fixtures and boot()
   live in test-exercise-ui-harness.cjs, shared with the corpus suite. */
const assert = require('node:assert/strict');
const {boot, exercise, exerciseData, cardFor, expand, buttonsIn, rowsIn, flush} = require('./test-exercise-ui-harness.cjs');

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

/* ----------------------------------------------------------------- the tests */

async function main() {
  console.log('exercise panel UI');

  await check('面板被注入到 .chapter-pager 之后（G1：只能由脚本创建）', () => {
    const h = boot();
    assert.ok(h.panel(), 'panel missing');
    assert.equal(
      h.root.children.indexOf(h.panel()),
      h.root.children.indexOf(h.pager) + 1,
      'panel must directly follow the pager',
    );
    assert.ok(h.panel().querySelectorAll('button').length > 0, 'expected script-created buttons');
    assert.equal(h.pager.children.length, 0, 'the pager itself must not be mutated');
  });

  await check('展开题目会创建编辑器并填入 starter', async () => {
    const h = boot();
    const body = await expand(h, 'ch07-ex01');
    const editor = body.querySelector('.exercise-editor');
    assert.ok(editor, 'editor missing');
    assert.equal(editor.value, 'name = ""\n', 'starter was not loaded');
  });

  await check('已有作答记录优先于 starter', async () => {
    const h = boot();
    h.store().write('chapter-7', 'ch07-ex01', {code: 'print("mine")'});
    const body = await expand(h, 'ch07-ex01');
    assert.equal(body.querySelector('.exercise-editor').value, 'print("mine")');
  });

  await check('点「运行」调用 sandbox.run 并原样带上该题的 checks', async () => {
    const checks = [
      {kind: 'stdout_contains', value: 'a', weight: 1},
      {kind: 'var_equals', name: 'x', value: 1, weight: 1},
    ];
    const h = boot({data: exerciseData([exercise({checks})])});
    const body = await expand(h, 'ch07-ex01');
    body.querySelector('.exercise-editor').value = 'print("a")';
    await buttonsIn(body, 'run')[0].fire('click');
    assert.equal(h.calls.run.length, 1, 'sandbox.run was not called exactly once');
    assert.equal(h.calls.run[0].code, 'print("a")');
    assert.deepEqual(h.calls.run[0].checks, checks);
  });

  await check('数组按索引对齐：outcomes 逐位传给判分器，不重排不过滤', async () => {
    // Only the middle check fails. If the panel reordered, filtered or padded
    // the array, the failing verdict would land on a different check -- the
    // exact defect Task 4 shipped once.
    const checks = [
      {kind: 'stdout_contains', value: 'one', weight: 1},
      {kind: 'assert_python', code: 'assert False, "middle always fails"', weight: 1},
      {kind: 'var_equals', name: 'z', value: 3, weight: 1},
    ];
    const outcomes = [
      {ok: true, detail: 'first ok'},
      {ok: false, detail: 'middle boom'},
      {ok: true, detail: 'third ok'},
    ];
    const h = boot({
      data: exerciseData([exercise({checks})]),
      sandbox: {run: () => Promise.resolve({ok: true, outcomes, ms: 5}), destroy() {}},
    });
    const body = await expand(h, 'ch07-ex01');
    await buttonsIn(body, 'run')[0].fire('click');
    assert.equal(h.calls.grade.length, 1, 'grader.grade was not called');
    const forwarded = h.calls.grade[0].options.outcomes;
    assert.equal(forwarded.length, 3, 'outcomes length must equal checks length');
    assert.deepEqual(forwarded.map(o => o.ok), [true, false, true], 'outcomes were reordered or filtered');
    assert.deepEqual(forwarded.map(o => o.detail), ['first ok', 'middle boom', 'third ok']);
    assert.deepEqual(rowsIn(body).map(r => r.dataset.ok), ['true', 'false', 'true'],
      'the rendered list must agree with the array, in the same order');
  });

  await check('数组按索引对齐：沙箱少给结果时按位补齐为失败，不整体偏移', async () => {
    const checks = [
      {kind: 'stdout_contains', value: 'a', weight: 1},
      {kind: 'stdout_contains', value: 'b', weight: 1},
    ];
    const h = boot({
      data: exerciseData([exercise({checks})]),
      // Truncated: only the FIRST result came back.
      sandbox: {run: () => Promise.resolve({ok: true, outcomes: [{ok: true, detail: 'first'}], ms: 3}), destroy() {}},
    });
    const body = await expand(h, 'ch07-ex01');
    await buttonsIn(body, 'run')[0].fire('click');
    const forwarded = h.calls.grade[0].options.outcomes;
    assert.equal(forwarded.length, 2, 'a short outcomes array must be padded, not shifted');
    assert.equal(forwarded[0].ok, true, 'the first slot must keep its own result');
    assert.equal(forwarded[1].ok, false, 'a missing slot must fail closed');
  });

  await check('混合判据（含 self_assessed）仍按原位对齐', async () => {
    // The grader drops self_assessed before scoring but reads outcomes by their
    // ORIGINAL index. The panel must therefore hand over the FULL array,
    // aligned to the FULL check list, or every check after the dropped one
    // scores against the wrong slot.
    const checks = [
      {kind: 'self_assessed'},
      {kind: 'stdout_contains', value: 'x', weight: 1},
      {kind: 'stdout_contains', value: 'y', weight: 1},
    ];
    const outcomes = [
      {ok: false, detail: ''},
      {ok: true, detail: 'x present'},
      {ok: true, detail: 'y present'},
    ];
    const h = boot({
      data: exerciseData([exercise({checks})]),
      sandbox: {run: () => Promise.resolve({ok: true, outcomes, ms: 1}), destroy() {}},
    });
    const body = await expand(h, 'ch07-ex01');
    await buttonsIn(body, 'run')[0].fire('click');
    const forwarded = h.calls.grade[0].options.outcomes;
    assert.equal(forwarded.length, 3, 'the full check list length must be forwarded');
    assert.deepEqual(forwarded.map(o => o.detail), ['', 'x present', 'y present']);
    // Both real checks pass, so the exercise passes despite the leading
    // self_assessed entry failing.
    assert.equal(cardFor(h, 'ch07-ex01').querySelector('.exercise-state').dataset.state, 'passed');
  });

  await check('代码报错时状态区显示可操作的那一行，且文章不受影响', async () => {
    const h = boot({
      sandbox: {
        run: () => Promise.resolve({
          ok: false, ms: 4,
          error: 'Traceback (most recent call last):\n  File "<exec>", line 1\nNameError: name \'x\' is not defined',
          outcomes: [{ok: false, detail: ''}],
        }),
        destroy() {},
      },
    });
    const body = await expand(h, 'ch07-ex01');
    await buttonsIn(body, 'run')[0].fire('click');
    const status = body.querySelector('.exercise-status');
    assert.equal(status.dataset.tone, 'error');
    assert.equal(status.textContent, 'NameError: name \'x\' is not defined',
      'should show the actionable last line, not the whole traceback');
    assert.ok(h.panel(), 'panel was torn down by a code error');
    assert.equal(h.root.children.indexOf(h.panel()), h.root.children.indexOf(h.pager) + 1);
  });

  await check('沙箱抛异常时显示错误但不影响其它功能', async () => {
    const boom = () => { throw new Error('worker unavailable'); };
    const h = boot({sandbox: {run: boom, destroy: boom}});
    const body = await expand(h, 'ch07-ex01');
    await buttonsIn(body, 'run')[0].fire('click');
    const status = body.querySelector('.exercise-status');
    assert.equal(status.dataset.tone, 'error');
    assert.equal(status.textContent, 'exercise.sandboxFailed');
    assert.equal(buttonsIn(body, 'run')[0].disabled, false, 'run button stayed disabled');
    assert.ok(h.panel().querySelector('.exercise-card'), 'the rest of the panel is gone');
  });

  await check("沙箱整个不可用时面板仍可挂载，不抛异常", () => {
    const h = boot({noSandbox: true});
    assert.ok(h.panel(), 'panel should still mount without a sandbox');
    assert.equal(h.calls.sandboxInit, null);
  });

  await check("type: 'reflect' 的题不出现运行按钮", async () => {
    const h = boot({
      data: exerciseData([exercise({id: 'ch13-ex03', type: 'reflect', checks: [{kind: 'self_assessed'}]})]),
    });
    const body = await expand(h, 'ch13-ex03');
    assert.equal(buttonsIn(body, 'run').length, 0, 'a reflect exercise must not offer Run');
    assert.equal(buttonsIn(body, 'submit').length, 0, 'nor a Submit');
    assert.deepEqual(buttonsIn(body).map(b => b.dataset.role), ['pass', 'partial', 'fail']);
  });

  await check('reflect 自评被记录，但永远不算通过', async () => {
    const h = boot({
      data: exerciseData([exercise({id: 'ch13-ex03', type: 'reflect', checks: [{kind: 'self_assessed'}]})]),
    });
    const body = await expand(h, 'ch13-ex03');
    await buttonsIn(body, 'pass')[0].fire('click');
    const store = h.store();
    assert.equal(store.read('chapter-7', 'ch13-ex03').selfAssessed, 'pass');
    assert.equal(store.read('chapter-7', 'ch13-ex03').passed, false,
      'a self-assessment must never mark an exercise as passed');
    assert.equal(cardFor(h, 'ch13-ex03').querySelector('.exercise-state').dataset.state, 'self');
    await buttonsIn(body, 'fail')[0].fire('click');
    assert.equal(store.read('chapter-7', 'ch13-ex03').passed, false, '"没答出" must not pass either');
    assert.equal(cardFor(h, 'ch13-ex03').querySelector('.exercise-state').dataset.state, 'todo');
  });

  await check("type: 'predict' 列出全部选项，而不只是正确答案", async () => {
    const item = exercise({
      id: 'ch07-ex03', type: 'predict', starter: '',
      prompt: '下面哪个写法能直接得到模型输出？（多选）\n\nA. `print(model(prompt))`\nB. `model(prompt)` 单独一行\nC. `print(model.generate(prompt))`\nD. `x = model.generate(prompt)` 然后 `print(x)`',
      checks: [{kind: 'output_choice', correct: ['A', 'C', 'D'], weight: 3}],
    });
    const h = boot({data: exerciseData([item])});
    const body = await expand(h, 'ch07-ex03');
    const offered = body.querySelectorAll('input').map(node => node.value);
    assert.deepEqual(offered, ['A', 'B', 'C', 'D'],
      'every option in the prompt must be offered, not only the correct ones');
    // Rendering check.correct as the choice list would hide B and make the
    // question unanswerable-but-always-right.
    assert.notDeepEqual(offered, ['A', 'C', 'D']);
  });

  await check('predict 选对通过、选错不通过，判据仍按索引对齐', async () => {
    const item = exercise({
      id: 'ch07-ex03', type: 'predict', starter: '', prompt: 'A. a\nB. b\nC. c',
      checks: [{kind: 'output_choice', correct: ['A', 'C'], weight: 3}],
    });
    const good = boot({data: exerciseData([item])});
    const goodBody = await expand(good, 'ch07-ex03');
    const inputs = goodBody.querySelectorAll('input');
    inputs[0].checked = true;
    inputs[2].checked = true;
    await buttonsIn(goodBody, 'submit')[0].fire('click');
    assert.equal(good.calls.grade[0].options.outcomes.length, 1, 'one outcome per check');
    assert.equal(good.calls.grade[0].options.outcomes[0].ok, true);
    assert.equal(goodBody.querySelector('.exercise-status').textContent, 'exercise.correct');
    assert.equal(cardFor(good, 'ch07-ex03').querySelector('.exercise-state').dataset.state, 'passed');

    const bad = boot({data: exerciseData([item])});
    const badBody = await expand(bad, 'ch07-ex03');
    badBody.querySelectorAll('input')[0].checked = true;
    await buttonsIn(badBody, 'submit')[0].fire('click');
    assert.equal(bad.calls.grade[0].options.outcomes[0].ok, false);
    assert.equal(badBody.querySelector('.exercise-status').textContent, 'exercise.incorrect');
    assert.equal(cardFor(bad, 'ch07-ex03').querySelector('.exercise-state').dataset.state, 'todo');
  });

  await check('选项题不启动 Pyodide（G9）', async () => {
    const boom = () => { throw new Error('the worker must not start for a choice question'); };
    const item = exercise({
      id: 'ch07-ex03', type: 'predict', starter: '', prompt: 'A. a\nB. b',
      checks: [{kind: 'output_choice', correct: ['A'], weight: 1}],
    });
    const h = boot({data: exerciseData([item]), sandbox: {run: boom, destroy: boom}});
    const body = await expand(h, 'ch07-ex03');
    body.querySelectorAll('input')[0].checked = true;
    await buttonsIn(body, 'submit')[0].fire('click');
    assert.equal(body.querySelector('.exercise-status').textContent, 'exercise.correct');
    assert.equal(h.calls.run.length, 0, 'a choice question must not start the worker');
  });

  await check('llm_rubric.enabled 为 false 时不请求评分接口（即使 criteria 非空）', async () => {
    // The corpus ships enabled:false WITH a written criteria (ch07-ex01 does),
    // so "enabled" has to be the gate on its own -- falling through to the
    // criteria check would start calling a paid endpoint for every exercise.
    const h = boot({data: exerciseData([exercise({llm_rubric: {enabled: false, criteria: 'be clear'}})])});
    const body = await expand(h, 'ch07-ex01');
    await buttonsIn(body, 'run')[0].fire('click');
    await flush();
    assert.equal(h.calls.fetch.filter(c => c.url.includes('/api/exercises/grade')).length, 0,
      'a disabled rubric must never reach the grading endpoint');
  });

  await check('llm 请求本身失败时降级为确定性判分，而不是丢弃本次结果', async () => {
    // The 503 path returns null; this is the path where the request itself
    // throws (offline, DNS failure, a CORS error). It must degrade the same
    // way, because the reader's deterministic verdict does not depend on it.
    const h = boot({
      data: exerciseData([exercise({llm_rubric: {enabled: true, criteria: 'be clear'}})]),
      sandbox: {run: () => Promise.resolve({ok: true, outcomes: [{ok: true, detail: ''}], ms: 2}), destroy() {}},
      fetch: url => String(url).includes('/grade')
        ? Promise.reject(new Error('network down'))
        : Promise.resolve({ok: true, json: () => Promise.resolve({user: null, csrf: ''})}),
    });
    const body = await expand(h, 'ch07-ex01');
    await buttonsIn(body, 'run')[0].fire('click');
    await flush();
    assert.equal(h.calls.grade.length, 1, 'the deterministic verdict was never recorded');
    assert.equal(h.calls.grade[0].options.llm, null);
    assert.equal(body.querySelector('.exercise-status').dataset.tone, 'pass',
      'a failing LLM call turned a correct answer into an error');
    assert.equal(cardFor(h, 'ch07-ex01').querySelector('.exercise-state').dataset.state, 'passed');
  });

  await check('llm 评分接口 503 时静默降级为确定性判分', async () => {
    const h = boot({
      data: exerciseData([exercise({llm_rubric: {enabled: true, criteria: 'be clear'}})]),
      sandbox: {run: () => Promise.resolve({ok: true, outcomes: [{ok: true, detail: ''}], ms: 2}), destroy() {}},
      fetch: url => String(url).includes('/grade')
        ? Promise.resolve({ok: false, status: 503, json: () => Promise.resolve({})})
        : Promise.resolve({ok: true, json: () => Promise.resolve({user: null, csrf: ''})}),
    });
    const body = await expand(h, 'ch07-ex01');
    await buttonsIn(body, 'run')[0].fire('click');
    assert.ok(h.calls.fetch.some(c => c.url.includes('/api/exercises/grade')), 'the grade endpoint was never called');
    assert.equal(h.calls.grade[0].options.llm, null, 'a 503 must degrade to null, not to a fake score');
    assert.equal(body.querySelector('.exercise-status').dataset.tone, 'pass');
    assert.equal(cardFor(h, 'ch07-ex01').querySelector('.exercise-state').dataset.state, 'passed');
  });

  await check('llm 评分成功时参与判分并展示反馈', async () => {
    const h = boot({
      data: exerciseData([exercise({llm_rubric: {enabled: true, criteria: 'be clear'}})]),
      sandbox: {run: () => Promise.resolve({ok: true, outcomes: [{ok: true, detail: ''}], ms: 2}), destroy() {}},
      fetch: url => String(url).includes('/grade')
        ? Promise.resolve({ok: true, json: () => Promise.resolve({score: 0.9, feedback: '变量用得好'})})
        : Promise.resolve({ok: true, json: () => Promise.resolve({user: null, csrf: ''})}),
    });
    const body = await expand(h, 'ch07-ex01');
    await buttonsIn(body, 'run')[0].fire('click');
    assert.equal(h.calls.grade[0].options.llm.score, 0.9);
    assert.ok(body.textContent.includes('变量用得好'), 'llm feedback was not shown');
  });

  await check('未登录时跳过同步，本地进度照常保留', async () => {
    const passing = {run: () => Promise.resolve({ok: true, outcomes: [{ok: true, detail: ''}], ms: 1}), destroy() {}};
    const h = boot({fetch: () => Promise.resolve({ok: true, json: () => Promise.resolve({user: null, csrf: ''})}), sandbox: passing});
    const body = await expand(h, 'ch07-ex01');
    await buttonsIn(body, 'run')[0].fire('click');
    await flush();
    assert.equal(h.calls.fetch.filter(c => c.url.includes('/api/exercises/progress')).length, 0,
      'a signed-out reader must not have progress posted');
    assert.equal(h.store().read('chapter-7', 'ch07-ex01').passed, true,
      'local progress was lost');
  });

  await check('登录后每次判分只同步一行（配额按请求计数）', async () => {
    const posts = [];
    const passing = {run: () => Promise.resolve({ok: true, outcomes: [{ok: true, detail: ''}], ms: 1}), destroy() {}};
    const h = boot({
      sandbox: passing,
      fetch: (url, init) => {
        if (String(url).endsWith('/api/exercises/progress')) {
          posts.push(JSON.parse(init.body));
          return Promise.resolve({ok: true, json: () => Promise.resolve({})});
        }
        return Promise.resolve({ok: true, json: () => Promise.resolve({user: {id: 7}, csrf: 'tok'})});
      },
    });
    const body = await expand(h, 'ch07-ex01');
    await buttonsIn(body, 'run')[0].fire('click');
    await flush();
    assert.equal(posts.length, 1, 'exactly one sync request per graded run');
    assert.equal(posts[0].items.length, 1, 'one row per request, never the whole snapshot');
    assert.equal(posts[0].items[0].exercise, 'ch07-ex01');
    assert.equal(posts[0].items[0].passed, 1);
  });

  await check('同步失败不影响判分结果', async () => {
    const h = boot({
      fetch: () => Promise.reject(new Error('offline')),
      sandbox: {run: () => Promise.resolve({ok: true, outcomes: [{ok: true, detail: ''}], ms: 1}), destroy() {}},
    });
    const body = await expand(h, 'ch07-ex01');
    await buttonsIn(body, 'run')[0].fire('click');
    assert.equal(cardFor(h, 'ch07-ex01').querySelector('.exercise-state').dataset.state, 'passed');
    assert.equal(body.querySelector('.exercise-status').dataset.tone, 'pass');
  });

  await check('没有练习的章节渲染空面板（由 CSS 隐藏）', () => {
    const h = boot({data: exerciseData([])});
    const panel = h.panel();
    assert.ok(panel, 'panel element should still exist');
    assert.equal(panel.children.length, 0, 'an empty chapter must not render an empty heading');
    assert.equal(panel.textContent, '');
  });

  await check('非章节路由不注入面板', () => {
    const h = boot({hash: '#home'});
    assert.equal(h.panel(), null, 'the panel belongs to the chapter view only');
  });

  await check('hashchange 切章后渲染新章节并清掉旧章节', () => {
    const second = exercise({id: 'ch13-ex01', chapter: 'chapter-13', objective: '另一个目标'});
    const h = boot({data: exerciseData([exercise()], {'chapter-13': [second]})});
    assert.ok(cardFor(h, 'ch07-ex01'));
    h.window.location.hash = '#chapter-13';
    for (const handler of h.listeners.get('hashchange') || []) handler();
    assert.ok(cardFor(h, 'ch13-ex01'), 'the new chapter was not rendered');
    assert.equal(cardFor(h, 'ch07-ex01'), null, 'the previous chapter was not cleared');
  });

  await check('同一章内跳转（锚点导航）不重建面板，读者展开的题保持展开', async () => {
    const h = boot();
    const body = await expand(h, 'ch07-ex01');
    assert.equal(body.hidden, false, 'the card did not expand');
    // Jumping to a heading inside the same chapter fires hashchange with a
    // different hash but the same chapter. Re-rendering there would collapse
    // every card and throw away whatever the reader had typed.
    h.window.location.hash = '#chapter-7#c7-s2';
    for (const handler of h.listeners.get('hashchange') || []) handler();
    const after = cardFor(h, 'ch07-ex01').querySelector('.exercise-body');
    assert.equal(after, body, 'the expanded body was replaced');
    assert.equal(after.hidden, false, 'the reader\'s open exercise was collapsed by an anchor jump');
    assert.equal(h.window.ExerciseUI.chapterId(), 'chapter-7');
  });

await check('切换语言后重新渲染，面板仍然可用', () => {
    const h = boot();
    h.window.MSI18N.lang = 'en';
    assert.ok(typeof h.calls.langListener === 'function', 'the language listener was never registered');
    h.calls.langListener();
    assert.ok(h.panel().querySelector('.exercise-summary'), 'the panel did not survive the switch');
    assert.ok(cardFor(h, 'ch07-ex01'), 'the cards did not survive the switch');
    // Re-render leaves the module re-usable: init() must not have re-bound.
    assert.equal((h.listeners.get('hashchange') || []).length, 1);
  });

  await check('init() 幂等：重复调用不会重复绑定监听器', () => {
    const h = boot();
    const before = (h.listeners.get('hashchange') || []).length;
    h.window.ExerciseUI.init();
    h.window.ExerciseUI.init();
    assert.equal((h.listeners.get('hashchange') || []).length, before, 'init() re-bound hashchange');
  });

  await check('teardown() 移除面板与监听器', () => {
    const h = boot();
    assert.ok(h.panel());
    h.window.ExerciseUI.teardown();
    assert.equal(h.panel(), null, 'the panel was left in the document');
    assert.equal((h.listeners.get('hashchange') || []).length, 0, 'hashchange survived teardown');
    assert.equal(h.calls.langListener, null, 'the language listener survived teardown');
  });

  await check('展开是惰性的：未展开的题不创建编辑器', () => {
    const h = boot();
    assert.equal(h.panel().querySelectorAll('textarea').length, 0,
      'editors must be built on first expand, not at render');
  });

  await check('重置按钮恢复 starter 并清空上一次的结果', async () => {
    const h = boot();
    const body = await expand(h, 'ch07-ex01');
    const editor = body.querySelector('.exercise-editor');
    editor.value = 'print("changed")';
    await buttonsIn(body, 'run')[0].fire('click');
    assert.ok(rowsIn(body).length > 0, 'expected a result list');
    await buttonsIn(body).find(b => b.dataset.role !== 'run').fire('click');
    assert.equal(editor.value, 'name = ""\n');
    assert.equal(rowsIn(body).length, 0, 'the old result was not cleared');
    assert.equal(body.querySelector('.exercise-status').textContent, '');
  });

  await check('已通过的题再次运行失败也不回退（进度单调）', async () => {
    let attempt = 0;
    const h = boot({
      sandbox: {
        run: () => {
          attempt += 1;
          return Promise.resolve({
            ok: true, ms: 1,
            outcomes: attempt === 1 ? [{ok: true, detail: ''}] : [{ok: false, detail: ''}],
          });
        },
        destroy() {},
      },
    });
    const body = await expand(h, 'ch07-ex01');
    await buttonsIn(body, 'run')[0].fire('click');
    assert.equal(cardFor(h, 'ch07-ex01').querySelector('.exercise-state').dataset.state, 'passed');
    await buttonsIn(body, 'run')[0].fire('click');
    assert.equal(cardFor(h, 'ch07-ex01').querySelector('.exercise-state').dataset.state, 'passed',
      'a later failure revoked an earlier pass');
  });

  await check('部分正确记录 0.5 且不通过，与状态区一致', async () => {
    const item = exercise({
      checks: [
        {kind: 'stdout_contains', value: 'a', weight: 1},
        {kind: 'stdout_contains', value: 'b', weight: 1},
      ],
    });
    const h = boot({
      data: exerciseData([item]),
      sandbox: {
        run: () => Promise.resolve({ok: true, ms: 1, outcomes: [{ok: true, detail: ''}, {ok: false, detail: 'no b'}]}),
        destroy() {},
      },
    });
    const body = await expand(h, 'ch07-ex01');
    await buttonsIn(body, 'run')[0].fire('click');
    const saved = h.store().read('chapter-7', 'ch07-ex01');
    assert.equal(saved.score, 0.5, 'a half-correct run should record 0.5');
    assert.equal(saved.passed, false, '0.5 is below the 0.8 threshold');
    assert.deepEqual(rowsIn(body).map(r => r.dataset.ok), ['true', 'false']);
    assert.equal(cardFor(h, 'ch07-ex01').querySelector('.exercise-state').dataset.state, 'todo');
  });

  await check('运行中显示加载提示（Pyodide 按需下载）', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const h = boot({
      sandbox: {
        run: () => gate.then(() => ({ok: true, ms: 1, outcomes: [{ok: true, detail: ''}]})),
        destroy() {},
      },
    });
    const body = await expand(h, 'ch07-ex01');
    const status = body.querySelector('.exercise-status');
    const pending = buttonsIn(body, 'run')[0].fire('click');
    assert.equal(status.textContent, 'exercise.loading', 'no loading hint before the runtime answers');
    assert.equal(buttonsIn(body, 'run')[0].disabled, true, 'Run must be disabled while in flight');
    release();
    await pending;
    assert.notEqual(status.textContent, 'exercise.loading', 'the loading hint was never cleared');
  });

  console.log(`\n${failures ? 'FAIL' : 'PASS'}: ${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});