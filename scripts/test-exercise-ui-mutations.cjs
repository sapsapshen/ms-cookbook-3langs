'use strict';
/* Mutation harness: apply a rewrite to assets/exercise-ui.js, run the UI suite,
   restore. Each mutation must turn the suite RED -- a suite that cannot fail is
   not evidence of anything. */
const fs = require('node:fs');
const {execFileSync} = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TARGET = path.join(ROOT, 'assets', 'exercise-ui.js');
const original = fs.readFileSync(TARGET, 'utf8');

const MUTATIONS = [
  ['先过滤 self_assessed 再判分（Task 4 的 Critical 类别）',
    "const outcomes = alignOutcomes(checks, (check, index) => {",
    "const filtered = checks.filter(c => c.kind !== 'self_assessed');\n        const outcomes = alignOutcomes(filtered, (check, index) => {"],
  ['按 outcomes 长度截断 checks（长度不等则整体偏移）',
    "const outcomes = alignOutcomes(checks, (check, index) => {",
    "const outcomes = alignOutcomes(checks.slice(0, 2), (check, index) => {"],
  ['把 outcomes 反转（重排而非重排索引）',
    "return list.map((check, index) => {",
    "return list.map((check, index) => { index = list.length - 1 - index;"],
  ['缺失的 outcome 补成通过（不 fail closed）',
    "return { ok: false, detail: result.ok ? 'not evaluated' : 'code did not run' };",
    "return { ok: true, detail: '' };"],
  ['reflect 也走沙箱（出现运行按钮）',
    "if (exercise.type === 'reflect') buildReflectExercise(exercise, body);",
    "if (exercise.type === 'reflect') buildSandboxExercise(exercise, body);"],
  ['自评也写入 passed',
    "record(exercise, { code: area.value, selfAssessed: choice });",
    "record(exercise, { code: area.value, selfAssessed: choice, passed: choice !== 'fail' });"],
  ['predict 用 check.correct 渲染选项（隐藏错误选项）',
    "const { options, usable } = splitPrompt(exercise);",
    "const found = (exercise.checks || []).filter(c => c.kind === 'output_choice');\n    const options = (found[0] && found[0].correct || []).map(letter => ({letter, label: 'x'}));\n    const usable = options.length > 0;"],
  ['选项题也去启动沙箱（违反 G9）',
    "if (!sandbox) throw new Error('sandbox unavailable');",
    "if (!sandbox) sandbox = Sandbox.create({onPhase});\n        if (!sandbox) throw new Error('sandbox unavailable');\n        await sandbox.run({code: '', checks: []});"],
  ['llm_rubric.enabled=false 时也请求评分接口',
    "if (!exercise.llm_rubric || exercise.llm_rubric.enabled !== true) return null;",
    "if (!exercise.llm_rubric) return null;"],
  ['llm 失败时向上抛而不是降级',
    "      return typeof data.score === 'number' ? data : null;\n    } catch { return null; }",
    "      return typeof data.score === 'number' ? data : null;\n    } catch (error) { throw error; }"],
  ['判分失败也照样记录为通过',
    "record(exercise, { passed: verdict.passed, score: verdict.score, code: editor.value });",
    "record(exercise, { passed: true, score: 1, code: editor.value });"],
  ['catch 里把面板整个清空（判分失败影响阅读）',
    "status.dataset.tone = 'error';\n        status.textContent = t('exercise.sandboxFailed');",
    "status.dataset.tone = 'error';\n        status.textContent = t('exercise.sandboxFailed');\n        if (host) host.replaceChildren();"],
  ['init() 不幂等（每次调用都重新绑定）',
    "if (listenersBound) return;",
    "if (false) return;"],
  ['同章 hashchange 也重建面板（读者展开的题被收起）',
    "if (!current || (mounted && current === chapterId)) return;",
    "if (!current) return;"],
  ['空章节也渲染标题（留下空白标题）',
    "if (!items.length) return;",
    "if (false) return;"],
  ['展开时一次性构建所有题（失去惰性）',
    "if (!body.hidden && !body.dataset.filled) {",
    "if (!body.dataset.filled) { body.dataset.filled = '1'; buildCard(exercise, index); }\n      if (!body.hidden && !body.dataset.filled) {"],
  ['面板注入到 pager 之前',
    "pager.after(panel);",
    "pager.before ? pager.before(panel) : root.insertBefore(panel, pager);"],
  ['拉取根本不存在（回到只有推送的状态）',
    "      const result = store.merge(rows);",
    "      if (false) { const result = store.merge(rows); void result; }"],
  ['merge 结果不重绘（同步了但徽章不更新）',
    "      repaintFromMerge(result.records);",
    "      void result.records;"],
  ['合并后不回写（本地较新的行永远上不去）',
    "      if (result.changed > 0) await pushBack(current);",
    "      if (false) await pushBack(current);"],
  ['回写不分片（60 行一次全发）',
    "for (const batch of store.chunks(PUSH_CHUNK)) {",
    "for (const batch of store.chunks(store.snapshot().length)) {"],
  ['拉取失败向上抛而不是静默（外层兜底被移除）',
    "    } catch { return null; }\n    finally { pulling = false; }",
    "    } catch (error) { throw error; }\n    finally { pulling = false; }"],
  ['未登录也去拉取（游客态白发一次请求）',
    "      if (!current || !current.user || current.loginEnabled === false) return null;",
    "      if (!current) return null;"],
  ['不用 store.merge 而是自己覆盖（破坏单调性）',
    "      const result = store.merge(rows);",
    "      for (const row of rows) { store.write(row.chapter, row.exercise, {passed: row.passed === 1, score: row.score, code: row.code || ''}); }\n      const result = {changed: 0, records: []};"],
  ['进章节不拉取（失去触发时机一）',
    "    // pull is fire-and-forget and silent, so a chapter opens exactly as fast\n    // as it did before.\n    pullProgress();",
    "    // pull is fire-and-forget and silent, so a chapter opens exactly as fast\n    // as it did before.\n    if (false) pullProgress();"],
  ['推送的行丢掉 code 与 selfAssessed（服务端 upsert 会把另一台设备的记录写成空串）',
    "      code: typeof record.code === 'string' ? record.code : '',\n      selfAssessed: typeof record.selfAssessed === 'string' ? record.selfAssessed : '',",
    "      // omitted"],
  ['不监听 purplebook:session（失去触发时机二）',
    "window.addEventListener('purplebook:session', onSessionChange);",
    "window.addEventListener('purplebook:session-never', onSessionChange);"],
  ['选项组退回 div（屏幕阅读器读不到分组）',
    "const field = document.createElement('fieldset');",
    "const field = document.createElement('div');"],
  ['legend 不渲染（fieldset 没有名字等于没有分组）',
    "field.append(legend);",
    "void legend;"],
  ['编辑器退回没有 label 的 textarea',
    "    host.append(label, editor, actions, status, output);",
    "    void label; host.append(editor, actions, status, output);"],
  ['选项行不从题干里剥（每道选择题的选项显示两遍）',
    "const shown = exercise.type === 'predict' ? splitPrompt(exercise).prompt : exercise.prompt;",
    "const shown = exercise.prompt;"],
  ['不归一 CRLF（Windows 编写的题干只解析出最后一个选项）',
    "const text = String(exercise.prompt || '').replace(/\\r\\n?/g, '\\n');",
    "const text = String(exercise.prompt || '');"],
  ['不跳过围栏代码块（代码里的伪选项会顶掉真正的 A）',
    "    if (/^\\s*(?:```|~~~)/.test(raw)) { fenced = !fenced; stem.push(raw); previous = null; continue; }",
    "    // fenced blocks are parsed like any other line"],
  ['换行的选项被静默截断',
    "if (previous && isContinuation(raw, previous.indent)) {\n        previous.label += ` ${raw.trim()}`;\n        continue;\n      }",
    "if (previous && isContinuation(raw, previous.indent)) { continue; }"],
  ['续行不看缩进（选项后面的散文被吞进最后一个选项的标签）',
    "if (previous && isContinuation(raw, previous.indent)) {",
    "if (previous && raw.trim()) {"],
  ['空行不结束选项块（隔一个空行的散文照样进标签）',
    "    previous = null;\n    stem.push(raw);",
    "    if (raw.trim()) previous = null;\n    stem.push(raw);"],
  ['缩进的引用与列表也算续行',
    "  return !/^[ \\t]*(?:>|[-*+]\\s|\\d+[.)]\\s|#)/.test(line);",
    "  return true;"],
  ['单个选项也放行（读者看到一个复选框且永远答错）',
    "const contiguous = found.length >= 2\n    && found.every((option, index) => option.letter.charCodeAt(0) === 'A'.charCodeAt(0) + index);",
    "const contiguous = found.length >= 1;"],
  ['字母不连续也放行（B 丢了读者毫无提示）',
    "&& found.every((option, index) => option.letter.charCodeAt(0) === 'A'.charCodeAt(0) + index);",
    "&& true;"],
  ['reflect 不问 rubric（语料里两道 reflect 的 LLM 路径再次变成死代码）',
    "        consultLlmRubric(exercise, area.value, advice);",
    "        void advice;"],
  ['rubric 的分数拿去判定通过（自评被模型的分数收买）',
    "    const llm = await tryLlmGrade(exercise, answer);\n    if (!llm || !llm.feedback) return;",
    "    const llm = await tryLlmGrade(exercise, answer);\n    if (llm && llm.score >= 0.8) { record(exercise, { passed: true, score: llm.score }); return; }\n    if (!llm || !llm.feedback) return;"],
  ['llm 没有客户端超时（挂起的请求把判定和按钮一起卡住）',
    "    return Promise.race([fetch(url, options), timeout])\n      .finally(() => clearTimeout(timer));",
    "    void timeout; void timer;\n    return fetch(url, options);"],
  ['init() 不再重读依赖（脚本顺序一旦不对面板静默消失）',
    "  function init() {\n    if (listenersBound) return;\n    if (!resolve()) return;",
    "  function init() {\n    if (listenersBound) return;\n    if (!data || !data.chapters || !Grader || !store) return;"],
  ['拉取不按章节过滤（每次进章节整表 GET）',
    "        const path = chapterId ? `${PROGRESS_PATH}?chapter=${encodeURIComponent(chapterId)}` : PROGRESS_PATH;",
    "        const path = PROGRESS_PATH;"],
  ['迟到的 rubric 意见写进已卸载的节点',
    "    if (!isAttached(host)) return;",
    "    if (false) return;"],
];

/* Sampling. Each mutation costs a full UI-suite run (~8 s locally), so the
 * whole set is 45 x 8 s -- measured at 375908 ms (6.3 min) on Windows. That is
 * past a reasonable CI step, but "excluded because slow" is not the same as
 * "cannot be checked": a mutation harness nobody runs is not evidence, and the
 * 45 mutations are independent (each restores the file before the next), so a
 * deterministic sample carries the same kind of proof at a fraction of the cost.
 *
 * SILS_MUTATION_STRIDE=N runs every Nth mutation. Stride 1 (the default) runs
 * all 45 and is still what you want locally. CI uses a stride, so the job
 * carries proof that a mutation DOES turn the suite red without paying for the
 * whole set. The offset is fixed (always index 0, N, 2N...), so the sample is
 * deterministic: the same CI run always exercises the same mutations instead of
 * drifting run to run.
 *
 * This script rewrites assets/exercise-ui.js in place, so it must never share a
 * step with anything else that reads that file -- a concurrent step would see a
 * mutated panel and fail for the wrong reason. The workflow gives it its own
 * step for exactly that reason. */
function selectMutations(stride) {
  const all = MUTATIONS.map(([name], index) => ({name, index}));
  if (stride <= 1) return all;
  return all.filter((_, position) => position % stride === 0);
}

const stride = Number(process.env.SILS_MUTATION_STRIDE) || 1;
if (!Number.isInteger(stride) || stride < 1) {
  console.error(`SILS_MUTATION_STRIDE must be a positive integer, got ${JSON.stringify(process.env.SILS_MUTATION_STRIDE)}`);
  process.exit(2);
}
const selected = selectMutations(stride);

/* SILS_MUTATION_LIST prints what a given stride WOULD run and exits without
 * touching assets/exercise-ui.js. It exists so the stride can be asserted
 * cheaply: proving "stride 5 picks 9 of 45" by running it would cost 73 s per
 * stride. Sampling has to be a real subset, not a smaller number in the log,
 * so the selection is inspectable without paying for the runs. */
if (process.env.SILS_MUTATION_LIST) {
  for (const {name, index} of selected) console.log(`  [${index}] ${name}`);
  console.log(`\nstride ${stride}: would run ${selected.length} of ${MUTATIONS.length} mutations`);
  process.exit(0);
}

let survivors = 0;
for (const {index} of selected) {
  const [name, from, to] = MUTATIONS[index];
  if (!original.includes(from)) {
    console.log(`  SKIP  [${index}] ${name}（锚点未命中，变异未生效）`);
    survivors += 1;
    continue;
  }
  fs.writeFileSync(TARGET, original.replace(from, to));
  let output = '';
  let crashed = false;
  try {
    output = execFileSync(process.execPath, [path.join(__dirname, 'test-exercise-ui.cjs')], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // A non-zero exit that still printed the summary means assertions went red;
    // anything else is the suite dying outright. Both are kills -- a mutation
    // that crashes the process has certainly changed behaviour -- so the
    // distinction only affects how many failures get reported.
    crashed = !/FAIL:/.test(`${error.stdout || ''}${error.stderr || ''}`);
    output = `${error.stdout || ''}${error.stderr || ''}`;
  } finally {
    fs.writeFileSync(TARGET, original);
  }
  const killed = crashed || /FAIL:/.test(output);
  const failing = (output.match(/^ {2}FAIL/gm) || []).length;
  console.log(`  ${killed ? 'killed' : 'SURVIVED'}  [${index}] ${name}${killed ? ` (${failing} failing)` : ''}`);
  if (!killed) survivors += 1;
}
/* The counts come from the list, not from tallying the loop, so "ran N of 45"
 * stays true even when a mutation was skipped for a missed anchor. */
console.log(`\nstride ${stride}: ran ${selected.length} of ${MUTATIONS.length} mutations`);
console.log(`${survivors ? 'SURVIVORS' : 'all killed'}: ${selected.length - survivors} killed, ${survivors} survived`);
process.exit(survivors ? 1 : 0);