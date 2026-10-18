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
        // The endpoint serves both verbs now, so only a POST is a sync. A GET
        // is the pull half and counting it here would make this assert about
        // something other than what it names.
        if (String(url).endsWith('/api/exercises/progress') && init && init.method === 'POST') {
          posts.push(JSON.parse(init.body));
          return Promise.resolve({ok: true, json: () => Promise.resolve({})});
        }
        if (String(url).endsWith('/api/exercises/progress')) {
          return Promise.resolve({ok: true, json: () => Promise.resolve({items: []})});
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

  /* The harness default sandbox returns no outcomes, so every check fails
     closed. Any test that asserts a PASS after clicking Run needs this. */
  const passingSandbox = () => ({
    run: () => Promise.resolve({ok: true, outcomes: [{ok: true, detail: ''}], ms: 1}),
    destroy() {},
  });

  /* ---- the payload's CONTENT, not just its length ----------------------- */
  /* The server's upsert writes `code=excluded.code` and
     `self_assessed=excluded.self_assessed` unconditionally, and ExerciseItem
     defaults both to ''. A row that merely omits them therefore does not "fail
     to sync the code" -- it ERASES the code another device saved. The row count
     assertions above pass either way, which is why this defect survived them. */

  await check('推送的行带上读者自己的代码与自评（服务端 upsert 是无条件覆盖）', async () => {
    const posts = [];
    const h = boot({
      sandbox: passingSandbox(),
      fetch: (url, init) => {
        const path = String(url);
        if (path.endsWith('/api/session')) {
          return Promise.resolve({ok: true, json: () => Promise.resolve({user: {id: 7}, csrf: 'tok', loginEnabled: true})});
        }
        if (path.endsWith('/api/exercises/progress') && init && init.method === 'POST') {
          posts.push(JSON.parse(init.body));
          return Promise.resolve({ok: true, status: 201, json: () => Promise.resolve({})});
        }
        return Promise.resolve({ok: true, json: () => Promise.resolve({items: []})});
      },
    });
    const body = await expand(h, 'ch07-ex01');
    body.querySelector('.exercise-editor').value = 'print("my own work")';
    await buttonsIn(body, 'run')[0].fire('click');
    await flush();
    assert.equal(posts.length, 1, 'the graded run pushed nothing');
    const row = posts[0].items[0];
    // Not "the row has 8 keys" -- the VALUES have to be the reader's own.
    assert.equal(row.code, 'print("my own work")',
      'the code was not sent, so the server would blank the copy another device holds');
    const saved = h.store().read('chapter-7', 'ch07-ex01');
    assert.equal(row.code, saved.code, 'the pushed code disagrees with the local store');
    assert.equal(row.selfAssessed, saved.selfAssessed, 'the pushed self-assessment disagrees with the local store');
    assert.equal(row.selfAssessed, '', 'a graded run has no self-assessment to report');
    // And the key set is the store's wire shape, field for field.
    assert.deepEqual(Object.keys(row).sort(), Object.keys(h.store().snapshot()[0]).sort(),
      'the pushed row and store.snapshot() disagree on which fields exist');
  });

  await check('自评题推送的行带 selfAssessed 与自评文本', async () => {
    const posts = [];
    const h = boot({
      data: exerciseData([exercise({id: 'ch13-ex03', type: 'reflect', checks: [{kind: 'self_assessed'}], llm_rubric: {enabled: false, criteria: ''}})]),
      fetch: (url, init) => {
        const path = String(url);
        if (path.endsWith('/api/session')) {
          return Promise.resolve({ok: true, json: () => Promise.resolve({user: {id: 7}, csrf: 'tok', loginEnabled: true})});
        }
        if (path.endsWith('/api/exercises/progress') && init && init.method === 'POST') {
          posts.push(JSON.parse(init.body));
          return Promise.resolve({ok: true, status: 201, json: () => Promise.resolve({})});
        }
        return Promise.resolve({ok: true, json: () => Promise.resolve({items: []})});
      },
    });
    const body = await expand(h, 'ch13-ex03');
    body.querySelector('.exercise-editor').value = '我把 lr 调小了';
    await buttonsIn(body, 'partial')[0].fire('click');
    await flush();
    assert.equal(posts.length, 1, 'the self-assessment pushed nothing');
    const row = posts[0].items[0];
    assert.equal(row.selfAssessed, 'partial', 'the self-assessment token was not sent');
    assert.equal(row.code, '我把 lr 调小了', 'the reflection text was not sent');
    assert.equal(row.passed, 0, 'a self-assessment must never be pushed as a pass');
  });

  await check('端到端：推送 → 服务端 upsert → 另一台设备拉取，代码与自评仍在', async () => {
    /* The real store plus a fetch that implements the server's OWN upsert
       semantics (`code=excluded.code`, `self_assessed=excluded.self_assessed`,
       unconditional) over an in-memory table. Device A grades and
       self-assesses; device B -- a fresh localStorage, so a genuinely separate
       device -- pulls and must find both fields intact.

       A stub that stored the row verbatim would pass even with the missing
       fields, because it would have no "" default to fall back on. The
       overwrite is the whole defect, so the double has to overwrite. */
    const table = new Map();
    const upsertFetch = () => (url, init) => {
      const path = String(url);
      if (path.endsWith('/api/session')) {
        return Promise.resolve({ok: true, json: () => Promise.resolve({user: {id: 7}, csrf: 'tok', loginEnabled: true})});
      }
      if (path.endsWith('/api/exercises/progress') && init && init.method === 'POST') {
        for (const row of JSON.parse(init.body).items) {
          const key = `${row.chapter}/${row.exercise}`;
          const previous = table.get(key) || {code: '', selfAssessed: '', passed: 0, score: 0, attempts: 0};
          // Exactly app.py's ON CONFLICT clause: passed/score ratchet, the two
          // text columns are overwritten with whatever the client sent.
          table.set(key, {
            chapter: row.chapter,
            exercise: row.exercise,
            code: row.code === undefined ? '' : row.code,
            passed: Math.max(previous.passed, row.passed),
            score: Math.max(previous.score, row.score),
            selfAssessed: row.selfAssessed === undefined ? '' : row.selfAssessed,
            attempts: row.attempts,
            updated: row.updated,
          });
        }
        return Promise.resolve({ok: true, status: 201, json: () => Promise.resolve({saved: 1})});
      }
      return Promise.resolve({ok: true, json: () => Promise.resolve({items: [...table.values()]})});
    };

    const fixture = exerciseData([
      exercise({id: 'ch07-ex01'}),
      exercise({id: 'ch07-ex02', type: 'reflect', checks: [{kind: 'self_assessed'}], llm_rubric: {enabled: false, criteria: ''}}),
    ]);
    const deviceA = boot({data: fixture, sandbox: passingSandbox(), fetch: upsertFetch()});
    const graded = await expand(deviceA, 'ch07-ex01');
    graded.querySelector('.exercise-editor').value = 'print("跨设备的代码")';
    await buttonsIn(graded, 'run')[0].fire('click');
    const reflection = await expand(deviceA, 'ch07-ex02');
    reflection.querySelector('.exercise-editor').value = '我先量了基线再调参';
    await buttonsIn(reflection, 'partial')[0].fire('click');
    await flush();

    assert.equal(table.get('chapter-7/ch07-ex01').code, 'print("跨设备的代码")',
      "device A's code did not survive the server's upsert");
    assert.equal(table.get('chapter-7/ch07-ex02').selfAssessed, 'partial',
      "device A's self-assessment did not survive the server's upsert");

    // Device B: its own boot means its own empty localStorage.
    const deviceB = boot({data: fixture, fetch: upsertFetch()});
    await deviceB.window.ExerciseUI.pullProgress();
    await flush();
    assert.equal(deviceB.store().read('chapter-7', 'ch07-ex01').code, 'print("跨设备的代码")',
      "device A's code never reached device B -- the row was blanked on the way");
    assert.equal(deviceB.store().read('chapter-7', 'ch07-ex02').selfAssessed, 'partial',
      "device A's self-assessment never reached device B");
    assert.equal(deviceB.store().read('chapter-7', 'ch07-ex01').passed, true,
      'the pass itself did not cross either');
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

  /* ---- cross-device sync: the pull half --------------------------------- */
  /* The panel could always PUSH. Without these, a reader who worked on one
     device saw none of it on another, which is the whole promise the design
     makes in §7.2. The merge rules themselves belong to the store and are
     proven by test-exercise-store.cjs; what is locked HERE is that the panel
     actually calls it, on the right trigger, with the right shape of payload. */

  /* A fetch double that answers the whole session + progress surface, so a
     test states only the part it cares about. `items` is a function because
     several tests change what the server holds between calls. */
  function syncFetch(overrides) {
    const settings = overrides || {};
    const session = settings.session === undefined
      ? {user: {id: 7, name: 'ada'}, csrf: 'tok', loginEnabled: true}
      : settings.session;
    return (url, init) => {
      const path = String(url);
      if (path.endsWith('/api/session')) {
        if (settings.sessionThrows) return Promise.reject(new Error('offline'));
        return Promise.resolve({ok: true, json: () => Promise.resolve(session)});
      }
      if (path.endsWith('/api/exercises/progress')) {
        if (init && init.method === 'POST') {
          const payload = JSON.parse(init.body);
          (settings.posts || (settings.posts = [])).push(payload);
          if (settings.postThrows) return Promise.reject(new Error('offline'));
          return Promise.resolve({ok: true, status: 201, json: () => Promise.resolve({saved: payload.items.length})});
        }
        if (settings.getThrows) return Promise.reject(new Error('offline'));
        if (settings.getStatus && settings.getStatus !== 200) {
          return Promise.resolve({ok: false, status: settings.getStatus, json: () => Promise.resolve({})});
        }
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({items: typeof settings.items === 'function' ? settings.items() : (settings.items || [])}),
        });
      }
      return Promise.resolve({ok: true, json: () => Promise.resolve({})});
    };
  }

  const pulls = h => h.calls.fetch.filter(c => c.url.endsWith('/api/exercises/progress') && !(c.init && c.init.method === 'POST'));
  const posts = h => h.calls.fetch.filter(c => c.url.endsWith('/api/exercises/progress') && c.init && c.init.method === 'POST');

  await check('拉取后：服务端返回的记录被合并进本地存储', async () => {
    // Three cases in one pull: a row this device has never seen, a row that
    // beats a weaker local one, and a row that loses to a stronger local one.
    const h = boot({
      fetch: syncFetch({items: [
        {chapter: 'chapter-7', exercise: 'ch07-ex01', passed: 1, score: 1, code: 'print("from phone")', updated: 1750000000},
        {chapter: 'chapter-7', exercise: 'ch07-ex02', passed: 1, score: 0.8, updated: 1750000000},
      ]}),
    });
    await h.window.ExerciseUI.pullProgress();
    await flush();
    const store = h.store();
    assert.equal(pulls(h).length, 1, 'the pull did not happen exactly once');
    assert.equal(store.read('chapter-7', 'ch07-ex01').passed, true);
    assert.equal(store.read('chapter-7', 'ch07-ex01').score, 1);
    assert.equal(store.read('chapter-7', 'ch07-ex01').code, 'print("from phone")',
      'the code earned on the other device did not arrive');
    // The badge is the reader's only evidence the sync worked, so a merged pass
    // that leaves the panel saying "not done" is a broken feature even though
    // the data merged correctly.
    assert.equal(cardFor(h, 'ch07-ex01').querySelector('.exercise-state').dataset.state, 'passed');
    assert.equal(h.panel().querySelector('.exercise-count').textContent, 'exercise.headerCount');
  });

  await check('拉取不会覆盖本地进度：本地已通过 + 服务端未通过 → 仍是已通过', async () => {
    // The single most damaging thing this feature could do. merge() latches
    // `passed`, so the panel needs no defence of its own -- but it needs a test
    // that would go red if anyone replaced merge() with a last-write-wins copy.
    //
    // The pass is EARNED through the panel, not written into the store behind
    // its back: a badge painted before the write would be stale for reasons
    // that have nothing to do with the merge, and the assertion below would
    // then be measuring the setup instead of the behaviour.
    const h = boot({
      fetch: syncFetch({items: [
        // An older row that reports the same exercise as failed, with no code.
        {chapter: 'chapter-7', exercise: 'ch07-ex01', passed: 0, score: 0, code: '', updated: 1000},
      ]}),
      sandbox: passingSandbox(),
    });
    const body = await expand(h, 'ch07-ex01');
    body.querySelector('.exercise-editor').value = 'print("mine")';
    await buttonsIn(body, 'run')[0].fire('click');
    await flush();
    assert.equal(h.store().read('chapter-7', 'ch07-ex01').passed, true, 'the setup did not earn a pass');
    assert.equal(cardFor(h, 'ch07-ex01').querySelector('.exercise-state').dataset.state, 'passed');

    await h.window.ExerciseUI.pullProgress();
    await flush();
    const merged = h.store().read('chapter-7', 'ch07-ex01');
    assert.equal(merged.passed, true, 'a server failure revoked a pass the reader had earned');
    assert.equal(merged.score, 1);
    assert.equal(cardFor(h, 'ch07-ex01').querySelector('.exercise-state').dataset.state, 'passed',
      'the badge regressed even though the record did not');
  });

  await check('拉取不会清空本地 code（学员写的代码优先保留）', async () => {
    const h = boot({fetch: syncFetch({})});
    h.store().write('chapter-7', 'ch07-ex01', {passed: true, score: 1, code: 'print("my own work")'});
    // A row stamped EARLIER carries an empty code -- the shape a server row
    // has when another device recorded the verdict but not the text.
    await h.window.ExerciseUI.pullProgress();
    await flush();
    const merged = h.store().read('chapter-7', 'ch07-ex01');
    assert.equal(merged.code, 'print("my own work")',
      'the learner\'s own code was cleared by the merge');
    const body = await expand(h, 'ch07-ex01');
    assert.equal(body.querySelector('.exercise-editor').value, 'print("my own work")',
      'the editor came up empty even though the record still held the code');
  });

  await check('拉取回来的是秒级时间戳，与本地同一单位（不会被误判成更新）', async () => {
    // `updated` is the arbitration key, so a unit mismatch does not corrupt --
    // it inverts every comparison. The store folds millisecond stamps; this
    // pins the wire shape that folding depends on.
    let items = [];
    const h = boot({fetch: syncFetch({items: () => items})});
    h.store().write('chapter-7', 'ch07-ex01', {passed: true, score: 1, code: 'mine'});
    const local = h.store().read('chapter-7', 'ch07-ex01').updated;
    assert.ok(local < 1e11, `the local stamp is not in seconds: ${local}`);
    // A row from 60 SECONDS ago must lose. Served in milliseconds it would win
    // forever, which is exactly the inversion this asserts against.
    items = [{chapter: 'chapter-7', exercise: 'ch07-ex01', passed: 0, score: 0, code: '', updated: local - 60}];
    await h.window.ExerciseUI.pullProgress();
    await flush();
    assert.equal(h.store().read('chapter-7', 'ch07-ex01').passed, true,
      'a server row from 60 SECONDS ago outranked the local one');
    assert.equal(h.store().read('chapter-7', 'ch07-ex01').code, 'mine');
    // And the mirror: a row genuinely 60 seconds NEWER does win its fields.
    items = [{chapter: 'chapter-7', exercise: 'ch07-ex01', passed: 1, score: 1, code: 'newer', updated: local + 60}];
    await h.window.ExerciseUI.pullProgress();
    await flush();
    assert.equal(h.store().read('chapter-7', 'ch07-ex01').code, 'newer',
      'a genuinely newer server row was refused');
  });

  await check('游客态零请求：/api/session 说没登录，进章节也不发任何 progress 请求', async () => {
    // A guest has no CSRF token and no row on the server, so a pull could only
    // come back empty and a push would be refused. One /api/session probe is
    // the whole cost; asserting on it keeps this from regressing into
    // "cheap enough to always ask".
    const h = boot({fetch: syncFetch({session: {user: null, csrf: '', loginEnabled: true}}), sandbox: passingSandbox()});
    await flush();
    assert.equal(pulls(h).length, 0, 'a signed-out reader pulled progress');
    assert.equal(posts(h).length, 0, 'a signed-out reader pushed progress');
    assert.equal(h.calls.fetch.filter(c => c.url.endsWith('/api/session')).length, 1,
      'the session was probed more than once');
    // And still true after a verdict, on the same page view.
    const body = await expand(h, 'ch07-ex01');
    await buttonsIn(body, 'run')[0].fire('click');
    await flush();
    assert.equal(pulls(h).length + posts(h).length, 0, 'a signed-out reader touched the progress endpoint');
    assert.equal(h.store().read('chapter-7', 'ch07-ex01').passed, true, 'local progress was lost');
  });

  await check('登录功能未启用时不请求 progress（部署上没有账号可同步）', async () => {
    const h = boot({fetch: syncFetch({session: {user: null, csrf: '', loginEnabled: false}})});
    await flush();
    assert.equal(pulls(h).length + posts(h).length, 0,
      'a deployment with login disabled must not sync');
  });

  await check('拉取失败静默：网络错误、401、非 2xx 都不影响阅读', async () => {
    for (const failure of [
      {getThrows: true},
      {getStatus: 401},
      {getStatus: 500},
      {sessionThrows: true},
    ]) {
      const h = boot({fetch: syncFetch(failure)});
      // Must resolve rather than reject: a caller that awaited this without a
      // try/catch would turn a sync outage into an unhandled rejection.
      const result = await h.window.ExerciseUI.pullProgress();
      await flush();
      assert.equal(result, null, `${JSON.stringify(failure)} returned ${result} instead of null`);
      assert.ok(h.panel(), `${JSON.stringify(failure)} tore the panel down`);
      assert.ok(cardFor(h, 'ch07-ex01'), `${JSON.stringify(failure)} removed the cards`);
      assert.ok(h.root.children.indexOf(h.panel()) === h.root.children.indexOf(h.pager) + 1,
        `${JSON.stringify(failure)} moved the panel`);
    }
    // The last-resort guard. Every network failure above is already handled at
    // its own step, so the only way to reach the outer catch is a collaborator
    // throwing -- a store whose merge breaks, a DOM that went away underneath
    // us. That is exactly the case where a bare throw would become an
    // unhandled rejection on a page the reader is in the middle of.
    const broken = boot({fetch: syncFetch({items: [{chapter: 'chapter-7', exercise: 'ch07-ex01', passed: 1, updated: 1750000000}]})});
    broken.store().merge = () => { throw new Error('corrupt store'); };
    // Captured rather than awaited bare: an escaping rejection would abort the
    // whole suite and report as a crash, not as the single assertion it is.
    let result = 'no answer';
    try { result = await broken.window.ExerciseUI.pullProgress(); }
    catch (error) { result = `threw ${error && error.message}`; }
    await flush();
    assert.equal(result, null, `a throwing merge escaped to the caller: ${result}`);
    assert.ok(broken.panel() && cardFor(broken, 'ch07-ex01'), 'a throwing merge took the panel down');
  });

  await check('回写用分片：60 行分成多个请求，每个都不超过单批上限', async () => {
    // The server's per-minute quota counts REQUESTS, and its ExerciseProgress
    // cap bounds one body. A 60-row snapshot sent as a single request is
    // exactly the shape that used to be refused, so the push-back has to slice.
    const recorded = [];
    // Older than every local write, so merge() reports it as a row the local
    // side owns and the panel therefore owes the server.
    const items = [{chapter: 'chapter-7', exercise: 'ch07-ex01', passed: 0, score: 0, updated: 1000}];
    const h = boot({fetch: (url, init) => {
      if (String(url).endsWith('/api/session')) {
        return Promise.resolve({ok: true, json: () => Promise.resolve({user: {id: 7}, csrf: 'tok', loginEnabled: true})});
      }
      if (String(url).endsWith('/api/exercises/progress') && init && init.method === 'POST') {
        recorded.push(JSON.parse(init.body));
        return Promise.resolve({ok: true, status: 201, json: () => Promise.resolve({})});
      }
      return Promise.resolve({ok: true, json: () => Promise.resolve({items})});
    }});
    for (let index = 1; index <= 60; index += 1) {
      h.store().write('chapter-7', `ch07-ex${String(index).padStart(2, '0')}`, {passed: true, score: 1});
    }
    await h.window.ExerciseUI.pullProgress();
    await flush();
    assert.ok(recorded.length > 1, `60 rows went up in ${recorded.length} request(s), not sliced`);
    for (const payload of recorded) {
      assert.ok(payload.items.length <= 25, `a batch carried ${payload.items.length} rows`);
    }
    const flat = recorded.flatMap(payload => payload.items.map(row => row.exercise));
    assert.equal(flat.length, 60, 'a row was dropped or duplicated by the slicing');
    assert.equal(new Set(flat).size, 60);
    assert.equal(posts(h).length, recorded.length,
      'the request count does not match the recorded batches');
    // The push-back must carry the MERGED values, not the pre-merge local row
    // that would re-regress the server.
    const first = recorded.flatMap(payload => payload.items).find(row => row.exercise === 'ch07-ex01');
    assert.equal(first.passed, 1, 'the push-back carried a regressing pass instead of the merged one');
    assert.equal(first.score, 1);
  });

  await check('触发时机一：进入章节时拉取一次（首页进入章节也算）', async () => {
    const h = boot({hash: '#home', fetch: syncFetch({})});
    await flush();
    assert.equal(h.panel(), null, 'the home view must not mount a panel');
    assert.equal(pulls(h).length, 0, 'the home view pulled progress');
    h.window.location.hash = '#chapter-7';
    for (const handler of h.listeners.get('hashchange') || []) handler();
    await flush();
    assert.equal(pulls(h).length, 1, 'entering a chapter did not pull exactly once');
    // A same-chapter anchor jump must NOT re-pull: the reader is not
    // re-entering, and the panel was deliberately not rebuilt there.
    h.window.location.hash = '#chapter-7#c7-s2';
    for (const handler of h.listeners.get('hashchange') || []) handler();
    await flush();
    assert.equal(pulls(h).length, 1, 'an anchor jump inside the chapter re-pulled');
  });

  await check('触发时机二：session 变化时拉取一次（复用 purplebook:session 通道）', async () => {
    const h = boot({hash: '#home', fetch: syncFetch({})});
    await flush();
    assert.equal((h.listeners.get('purplebook:session') || []).length, 1,
      'the panel did not subscribe to the repo\'s own session channel');
    const signIn = {user: {id: 7, name: 'ada'}, csrf: 'tok', loginEnabled: true};
    for (const handler of h.listeners.get('purplebook:session') || []) handler({detail: signIn});
    await flush();
    assert.equal(pulls(h).length, 1, 'signing in did not pull');
    // The event fires on every account repaint, not only on a real change --
    // a second dispatch for the SAME reader must not spend another round trip.
    for (const handler of h.listeners.get('purplebook:session') || []) handler({detail: signIn});
    await flush();
    assert.equal(pulls(h).length, 1, 'a repeat session event for the same reader re-pulled');
    // Switching accounts is a different reader and must pull.
    for (const handler of h.listeners.get('purplebook:session') || []) handler({detail: {user: {id: 9}, csrf: 'tok2', loginEnabled: true}});
    await flush();
    assert.equal(pulls(h).length, 2, 'a different reader did not get their own pull');
    // Signing out must not pull -- and must not throw away local progress.
    for (const handler of h.listeners.get('purplebook:session') || []) handler({detail: {user: null, csrf: '', loginEnabled: true}});
    await flush();
    assert.equal(pulls(h).length, 2, 'signing out pulled');
    assert.ok(h.store(), 'signing out tore down the store');
  });

  await check('拉取后有新的通过记录时给一条轻量提示，其余情况保持安静', async () => {
    const quiet = boot({fetch: syncFetch({items: [
      // An imported code draft and a self-assessment are real merges, but they
      // are not surprising: nothing the reader sees here contradicts itself.
      {chapter: 'chapter-7', exercise: 'ch07-ex01', passed: 0, score: 0, code: 'draft', updated: 1750000000},
    ]})});
    await quiet.window.ExerciseUI.pullProgress();
    await flush();
    assert.equal(quiet.panel().querySelector('.exercise-synced'), null,
      'a silent merge announced itself');
    assert.equal(quiet.store().read('chapter-7', 'ch07-ex01').code, 'draft',
      'the imported draft did not land');

    const loud = boot({fetch: syncFetch({items: [
      {chapter: 'chapter-7', exercise: 'ch07-ex01', passed: 1, score: 1, updated: 1750000000},
    ]})});
    await loud.window.ExerciseUI.pullProgress();
    await flush();
    const note = loud.panel().querySelector('.exercise-synced');
    assert.ok(note, 'a badge flipped to "passed" with no explanation');
    assert.equal(note.textContent, 'exercise.synced');
    assert.equal(note.getAttribute('role'), 'status', 'the note is not announced to a screen reader');
    // Twice over does not stack: a second pull must not double the line.
    await loud.window.ExerciseUI.pullProgress();
    await flush();
    assert.equal(loud.panel().querySelectorAll('.exercise-synced').length, 1);
  });

  await check('拉取不重建面板：读者展开的题在同步后仍保持展开', async () => {
    const h = boot({fetch: syncFetch({items: [
      {chapter: 'chapter-7', exercise: 'ch07-ex01', passed: 1, score: 1, updated: 1750000000},
    ]})});
    const body = await expand(h, 'ch07-ex01');
    assert.equal(body.hidden, false);
    await h.window.ExerciseUI.pullProgress();
    await flush();
    const after = cardFor(h, 'ch07-ex01').querySelector('.exercise-body');
    assert.equal(after, body, 'the pull rebuilt the panel and collapsed the open exercise');
    assert.equal(after.hidden, false);
  });

  console.log(`\n${failures ? 'FAIL' : 'PASS'}: ${passed} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});