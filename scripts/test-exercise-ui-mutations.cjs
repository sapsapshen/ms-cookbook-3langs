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
    "const options = promptOptions(exercise);",
    "const found = (exercise.checks || []).filter(c => c.kind === 'output_choice');\n    const options = (found[0] && found[0].correct || []).map(letter => ({letter, label: 'x'}));"],
  ['选项题也去启动沙箱（违反 G9）',
    "if (!sandbox) throw new Error('sandbox unavailable');",
    "if (!sandbox) sandbox = Sandbox.create({onPhase});\n        if (!sandbox) throw new Error('sandbox unavailable');\n        await sandbox.run({code: '', checks: []});"],
  ['llm_rubric.enabled=false 时也请求评分接口',
    "if (!exercise.llm_rubric || exercise.llm_rubric.enabled !== true) return null;",
    "if (!exercise.llm_rubric) return null;"],
  ['llm 失败时向上抛而不是降级',
    "    } catch { return null; }\n  }\n\n  function progressRow(record) {",
    "    } catch (error) { throw error; }\n  }\n\n  function progressRow(record) {"],
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
];

let survivors = 0;
for (const [name, from, to] of MUTATIONS) {
  if (!original.includes(from)) {
    console.log(`  SKIP  ${name}（锚点未命中，变异未生效）`);
    survivors += 1;
    continue;
  }
  fs.writeFileSync(TARGET, original.replace(from, to));
  let output = '';
  try {
    output = execFileSync(process.execPath, [path.join(__dirname, 'test-exercise-ui.cjs')], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    output = `${error.stdout || ''}${error.stderr || ''}`;
  } finally {
    fs.writeFileSync(TARGET, original);
  }
  const killed = /FAIL:/.test(output);
  const failing = (output.match(/^ {2}FAIL/gm) || []).length;
  console.log(`  ${killed ? 'killed' : 'SURVIVED'}  ${name}${killed ? ` (${failing} failing)` : ''}`);
  if (!killed) survivors += 1;
}
console.log(`\n${survivors ? 'SURVIVORS' : 'all killed'}: ${MUTATIONS.length - survivors} killed, ${survivors} survived`);
process.exit(survivors ? 1 : 0);