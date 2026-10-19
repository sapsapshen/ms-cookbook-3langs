const {test: nodeTest} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync, existsSync, readdirSync} = require('node:fs');
const {resolve} = require('node:path');

/* A floor on the number of cases, on this file too. This one matters more than
 * most: its whole job is to be the thing that notices when another check stops
 * being enforced, so a silently emptied test-ci-coverage.cjs would leave the
 * feature with no automated defence at all and still go green.
 *
 * `registered` counts declarations; node:test runs a file's tests after the
 * module finishes evaluating, so it is already final when the floor check runs.
 *
 * SILS_CASE_FLOOR raises the floor and nothing else, and exists so the self
 * check at the bottom can prove the assertion bites by running this very file
 * with a floor no run could ever meet. `Math.max` means it can only tighten. */
const MIN_CASES = Math.max(8, Number(process.env.SILS_CASE_FLOOR) || 0);
let registered = 0;
function test(name, fn) {
  registered += 1;
  return nodeTest(name, fn);
}

/* The CI wiring is the last line of defence for the exercise feature, and it
 * fails silently: a `paths:` entry that nobody added means the script still
 * passes locally forever while the change that broke it ships without CI ever
 * running it. Nothing in the workflow itself reports that -- a green run and a
 * skipped run look identical on the checks tab.
 *
 * So this file asserts the wiring from the outside. It reads the workflow as
 * text and checks three things: every verification script is executed by some
 * `run:`, every one of them also appears in `paths:` (otherwise editing it does
 * not trigger the workflow at all), and the workflow never names a script that
 * is not on disk.
 *
 * The list below is an explicit inventory rather than a directory glob on
 * purpose. A glob would silently accept a brand-new test file with no CI step,
 * which is the exact failure this file exists to catch. `test/`-suffixed
 * scripts that are deliberately NOT standalone CI steps have to be named in
 * EXCLUDED, so joining the club is a decision someone wrote down.
 */

const WORKFLOW = resolve(__dirname, '../.github/workflows/deploy-modelscope.yml');

/* Every verification script the exercise feature depends on. If one of these
 * stops running in CI, the feature has no automated defence left. */
const REQUIRED = [
  'scripts/build-exercises.py',
  'scripts/test_exercises.py',
  'scripts/check_exercise_references.py',
  'scripts/check_regex_parity.py',
  'scripts/test_pyodide_vendor.py',
  'scripts/test-exercise-grader.cjs',
  'scripts/test-exercise-store.cjs',
  'scripts/test-exercise-worker.cjs',
  'scripts/test-exercise-sandbox-real.cjs',
  'scripts/test-exercise-ui.cjs',
  'scripts/test-exercise-ui-corpus.cjs',
  'scripts/test-exercise-map.cjs',
  'scripts/test-exercise-wiring.cjs',
  'scripts/test-exercise-locale.cjs',
  'scripts/test-i18n.cjs',
  'scripts/test-exercise-ui-mutations.cjs',
];

/* scripts/test-*.cjs files that are intentionally not standalone CI steps.
 * Each entry says why, so a reader can tell a decision from an oversight. */
const EXCLUDED = new Map([
  ['scripts/test-exercise-ui-harness.cjs',
   'a shared harness required by test-exercise-ui / -map / -ui-corpus; running it alone executes nothing'],
  ['scripts/test-book-search.cjs',
   'pre-existing suite, never wired into CI before this feature; out of scope here'],
  ['scripts/test-reader-routes.cjs',
   'pre-existing suite, never wired into CI before this feature; out of scope here'],
  ['scripts/test-ci-coverage.cjs',
   'this file: it asserts on REQUIRED, so listing itself there would be circular. It does run in CI, through its own step.'],
]);

/* Minimal YAML slicing, enough for this one file and no more.
 *
 * GitHub Actions fails the whole workflow on a YAML parse error, so the shape
 * below cannot rot into something that "still parses". What it CAN do is stop
 * finding a section -- a moved key, a renamed step -- and hand back an empty
 * slice. Every consumer here treats empty as "all 15 are missing", so a parser
 * that loses track reports red rather than passing vacuously. That direction
 * is the whole point; the reverse tests at the bottom pin it down. */

function indentOf(line) {
  return line.length - line.replace(/^ */, '').length;
}

// The `paths:` allow-list under `on.push`. Stops at the first line indented no
// further than the key itself, so a sibling key (workflow_dispatch:) cannot
// leak its entries in. Returns [] when the key is absent -- never throws -- so
// the callers below decide what an absent filter means.
function parsePaths(text) {
  const lines = text.split('\n');
  const start = lines.findIndex(line => /^\s*paths:\s*$/.test(line));
  if (start === -1) return [];
  const base = indentOf(lines[start]);
  const entries = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.trim()) continue;
    if (indentOf(line) <= base) break;
    const item = /^\s*-\s*(.+?)\s*$/.exec(line);
    if (item) entries.push(item[1].replace(/^['"]|['"]$/g, ''));
  }
  return entries;
}

// Every `run:` block scalar in the job, concatenated with newlines. A one-line
// `run: node scripts/x.cjs` is matched too -- it is the shape this repo uses for
// short steps, and requiring the `|` form would let a step silently fall out of
// the coverage check by being reformatted.
function parseRunBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const line = /^\s*run:\s*(.*?)\s*$/.exec(lines[i]);
    if (!line) continue;
    const base = indentOf(lines[i]);
    if (line[1] && line[1] !== '|' && line[1] !== '>') {
      blocks.push(line[1]);
      continue;
    }
    const body = [];
    // A `#` line inside a `run: |` block is a shell comment: bash never runs
    // it, so it is not evidence that anything executed. Counting it would let
    // the exact failure this file exists to catch pass silently -- comment out
    // `node scripts/x.cjs` and the workflow ships the change with the script
    // never running, while the coverage check stays green because the name is
    // still on the page. The workflow's own comments name scripts (e.g. the
    // sandbox step's "paired with the real-runtime test"), which is exactly
    // why presence-in-the-text and executed-in-the-shell have to differ.
    let consumed = 0;
    for (const next of lines.slice(i + 1)) {
      if (!next.trim()) { body.push(''); consumed += 1; continue; }
      if (indentOf(next) <= base) break;
      consumed += 1;
      if (next.trim().startsWith('#')) continue;
      body.push(next.trim());
    }
    blocks.push(body.join('\n'));
    // Skip what we read. Counting consumed lines rather than body.length, since
    // comment lines are deliberately absent from `body`.
    i += consumed;
  }
  return blocks;
}

function scriptsIn(text) {
  return new Set([...text.matchAll(/scripts\/[A-Za-z0-9_.\/-]+/g)].map(m => m[0]));
}

function missing(required, present) {
  return required.filter(script => !present.has(script));
}

function readWorkflow() {
  return readFileSync(WORKFLOW, 'utf8');
}

test('16 个校验脚本都在 workflow 的某个 run: 里执行', () => {
  const runs = parseRunBlocks(readWorkflow());
  assert.ok(runs.length >= 5, `only ${runs.length} run: blocks parsed; the parser is not seeing the steps`);
  const executed = scriptsIn(runs.join('\n'));
  assert.deepEqual(missing(REQUIRED, executed), [],
    '这些脚本没有在 CI 里执行，改动它们不会得到任何反馈');
});

test('16 个校验脚本都在 paths: 白名单里，否则 workflow 根本不会被触发', () => {
  const paths = new Set(parsePaths(readWorkflow()));
  assert.ok(paths.size >= 20, `only ${paths.size} paths: entries parsed; the parser is not seeing the filter`);
  assert.deepEqual(missing(REQUIRED, paths), [],
    '这些脚本不在 paths: 里，改动它们不会触发 workflow（脚本本身通过与否都无关）');
});

test('workflow 没有引用不存在的脚本', () => {
  const text = readWorkflow();
  const referenced = new Set([
    ...scriptsIn(parseRunBlocks(text).join('\n')),
    ...scriptsIn(parsePaths(text).join('\n')),
  ]);
  const dangling = [...referenced].filter(script => !existsSync(resolve(__dirname, '..', script)));
  assert.deepEqual(dangling, [], 'workflow 引用了不存在的脚本，CI 必然在这一步失败');
});

test('scripts/test-*.cjs 要么在 REQUIRED，要么在 EXCLUDED 里写明原因', () => {
  const onDisk = readdirSync(resolve(__dirname))
    .filter(name => /^test-.*\.cjs$/.test(name))
    .map(name => `scripts/${name}`);
  const unaccounted = onDisk.filter(script => !REQUIRED.includes(script) && !EXCLUDED.has(script));
  assert.deepEqual(unaccounted, [],
    '新增的测试脚本没有进 CI，也没有写进 EXCLUDED 说明为什么不需要进');
});

/* Everything above is satisfiable by a bug in the helpers: a `present` set
 * sliced from the wrong place is empty, `missing` is empty because REQUIRED
 * itself is empty, and every check goes green while proving nothing. These
 * tests drive the same helpers with the coverage deliberately broken, so a
 * parser that stops finding the steps fails HERE instead of silently turning
 * the checks above into no-ops. */
test('反向验证：run: 里删掉 test-exercise-locale.cjs，漏项检测必须定位到它', () => {
  const text = readWorkflow().replace(/\n\s*node scripts\/test-exercise-locale\.cjs/, '');
  const executed = scriptsIn(parseRunBlocks(text).join('\n'));
  assert.deepEqual(missing(REQUIRED, executed), ['scripts/test-exercise-locale.cjs'],
    'run: 里删掉一个脚本后，漏项检测没有定位到它');
  // The unmodified workflow must be clean, or the mutation proved nothing.
  assert.deepEqual(missing(REQUIRED, scriptsIn(parseRunBlocks(readWorkflow()).join('\n'))), [],
    '未改动的 workflow 必须是绿的，否则上面的变异没有证明任何事');
});

/* The same deletion, but the line is kept and turned into a shell comment.
 * This is the sneakier half of the same hole, and it is why the sandbox step's
 * own prose ("paired with the real-runtime test") cannot be allowed to count as
 * coverage: commenting a step out leaves the script name in the file, so a
 * coverage check that reads text instead of executed lines stays green and the
 * change ships with the suite never running. */
test('反向验证：run: 里注释掉 test-exercise-map.cjs，漏项检测必须定位到它', () => {
  const commented = readWorkflow().replace(
    /^(\s*)node (scripts\/test-exercise-map\.cjs)$/m, '$1# node $2');
  // The mutation must actually have landed, or the assertion below is vacuous.
  assert.ok(!new RegExp(`^\\s*node ${'scripts/test-exercise-map.cjs'}$`, 'm').test(commented),
    '变异没有生效：workflow 里找不到未注释的 test-exercise-map.cjs 行');
  assert.ok(commented.includes('# node scripts/test-exercise-map.cjs'),
    '变异没有生效：注释行不在文件里');
  const executed = scriptsIn(parseRunBlocks(commented).join('\n'));
  assert.deepEqual(missing(REQUIRED, executed), ['scripts/test-exercise-map.cjs'],
    '把 run: 行注释掉后，漏项检测没有定位到它 —— 注释行被当成了执行证据');
  // The unmodified workflow must be clean, or the mutation proved nothing.
  assert.deepEqual(missing(REQUIRED, scriptsIn(parseRunBlocks(readWorkflow()).join('\n'))), [],
    '未改动的 workflow 必须是绿的，否则上面的变异没有证明任何事');
});

test('反向验证：paths: 里删掉 test-exercise-locale.cjs，白名单检测必须定位到它', () => {
  const text = readWorkflow().replace(/\n\s*- 'scripts\/test-exercise-locale\.cjs'/, '');
  const paths = new Set(parsePaths(text));
  // The neighbouring entry proves the parser is reading this list and not
  // something else that happens to contain the right words.
  assert.ok(paths.has('scripts/test-exercise-wiring.cjs'), '反向验证的前提不成立：邻居条目也没解析到');
  assert.deepEqual(missing(REQUIRED, paths), ['scripts/test-exercise-locale.cjs'],
    'paths: 里删掉一个脚本后，漏项检测没有定位到它');
  assert.deepEqual(missing(REQUIRED, new Set(parsePaths(readWorkflow()))), []);
});

test('反向验证：workflow 引用不存在的脚本时必须报出来', () => {
  const broken = readWorkflow().replace('node scripts/test-i18n.cjs', 'node scripts/test-i18n-typo.cjs');
  const referenced = scriptsIn([...parseRunBlocks(broken), ...parsePaths(broken)].join('\n'));
  const dangling = [...referenced].filter(script => !existsSync(resolve(__dirname, '..', script)));
  assert.deepEqual(dangling, ['scripts/test-i18n-typo.cjs'], '引用了不存在的脚本却没有报出来');
  assert.deepEqual([...scriptsIn(readWorkflow())].filter(s => !existsSync(resolve(__dirname, '..', s))), [],
    '未改动的 workflow 必须是干净的，否则上面的变异没有证明任何事');
});

test('反向验证：paths: 整体消失时必须报红，而不是因为"没解析到"而空过', () => {
  // The direction that matters: an empty slice must read as "all 15 missing",
  // never as "nothing to check". A parser that silently returns [] when the
  // section moves would otherwise turn every assertion above into a no-op.
  const text = readWorkflow().replace(/^(\s*)paths:\s*$/m, '$1disarmed:');
  assert.deepEqual(parsePaths(text), [], 'paths: 被改名后仍读出了条目，说明它在读别的东西');
  assert.deepEqual(missing(REQUIRED, new Set(parsePaths(text))), REQUIRED,
    'paths: 整体消失后，16 个脚本必须全部报为漏项');
  // Same for run: blocks.
  assert.deepEqual(missing(REQUIRED, scriptsIn('')), REQUIRED,
    '一个脚本都不执行时，漏项检测必须把 16 个全报出来');
});
/* Self-check for the floor above. The floor is a guard against a suite that
 * goes quiet, and a guard nobody has seen fire is indistinguishable from no
 * guard at all -- the same objection this file raises about the CI wiring. So
 * run this file again with the floor raised past anything a real run could
 * reach, and require the run to FAIL. If MIN_CASES were not actually wired to
 * the exit status, this test would go green and the guard would be decorative. */
test('反向验证：把用例数下限调到不可能达到，本文件必须报红退出', () => {
  // Disabled in the children: they exist only to observe the floor firing, and
  // re-entering here would make each level spawn two more runs.
  if (process.env.SILS_CASE_FLOOR || process.env.SILS_CASE_FLOOR_PROBE) {
    console.log('  skip  this run is a floor probe (SILS_CASE_FLOOR* is set)');
    return;
  }
  const {spawnSync} = require('node:child_process');
  const base = {...process.env, SILS_CASE_FLOOR_PROBE: '1'};
  const run = spawnSync(process.execPath, [__filename], {
    encoding: 'utf8',
    env: {...base, SILS_CASE_FLOOR: '100000'},
  });
  assert.notEqual(run.status, 0,
    '下限调到 100000 之后本文件仍然退出 0 —— 下限断言没有真的接在退出码上');
  assert.match(`${run.stdout}${run.stderr}`, /cases were lost, not fixed/,
    '下限生效了但失败信息没有点名「用例被删掉了」');
  // Without the override the same file must be green, or the self-check above
  // proved nothing beyond "some exit code is nonzero".
  const clean = spawnSync(process.execPath, [__filename], {encoding: 'utf8', env: base});
  assert.equal(clean.status, 0, `未改动时本文件必须是绿的：\n${clean.stdout}${clean.stderr}`);
});

/* The mutation harness used to be EXCLUDED for being slow (~6 min for all 47),
 * which is not the same as unrunnable: a harness nobody runs is not evidence
 * that the UI suite can fail, and the 47 mutations are independent, so a
 * deterministic stride carries the same proof for a fraction of the cost. These
 * two tests pin the part that is easy to fake -- a stride that reports a smaller
 * number while still running everything would make the CI step 6 minutes long
 * and look sampled in the log. */
function listSelected(stride) {
  const {execFileSync} = require('node:child_process');
  return execFileSync(process.execPath, [resolve(__dirname, 'test-exercise-ui-mutations.cjs')], {
    encoding: 'utf8',
    env: {...process.env, SILS_MUTATION_LIST: '1', SILS_MUTATION_STRIDE: String(stride)},
  });
}

test('变异套件的抽样档真的只挑出子集，不是跑完再改日志', () => {
  const picked = str => [...listSelected(str).matchAll(/^ {2}\[(\d+)\]/gm)].map(m => Number(m[1]));
  assert.equal(picked(1).length, 47, 'stride 1 必须选中全部 47 个变异');
  assert.equal(picked(5).length, 10, 'stride 5 必须正好选中 10 个变异');
  assert.equal(picked(15).length, 4, 'stride 15 必须正好选中 4 个变异');
  // The selected indices must be a genuine stride through the list -- the
  // cheapest way for a harness to appear sampled is to run all 47 and print 10.
  assert.deepEqual(picked(5), [0, 5, 10, 15, 20, 25, 30, 35, 40, 45],
    'stride 5 选中的不是每第 5 个，抽样是假的');
  assert.ok(picked(5).every(index => index < 47), 'stride 5 选中了越界的变异下标');
  // And a stride must actually shrink the set, or it is a relabelled full run.
  assert.ok(picked(5).length < picked(1).length && picked(15).length < picked(5).length,
    'stride 没有缩小规模，抽样是假的');
  // Stride 1 is what a developer gets locally, and it must stay the full set.
  assert.match(listSelected(1), /would run 47 of 47 mutations/);
  assert.match(listSelected(5), /would run 10 of 47 mutations/);
});

test('workflow 用的是抽样档，而且它独占一个 step', () => {
  const runs = parseRunBlocks(readWorkflow());
  const steps = runs.filter(block => block.includes('test-exercise-ui-mutations.cjs'));
  assert.equal(steps.length, 1, '变异套件必须出现在恰好一个 run: 块里');
  const step = steps[0];
  assert.match(step, /SILS_MUTATION_STRIDE=\d+/,
    'CI 里的变异套件没有设置抽样步长 —— 要么是全量 47 个（~6 分钟），要么是没跑');
  const stride = Number(/SILS_MUTATION_STRIDE=(\d+)/.exec(step)[1]);
  const selected = [...listSelected(stride).matchAll(/^ {2}\[(\d+)\]/gm)].length;
  assert.ok(selected > 0 && selected < 47,
    `CI 的步长 ${stride} 选出 ${selected} 个变异，既不是子集也不是空集`);
  /* The harness rewrites assets/exercise-ui.js in place, so a step that shares a
   * run block with another script that reads that file would observe a mutated
   * panel and fail for the wrong reason. Sharing a block is only safe if the
   * mutation script is the only one in it. */
  const others = runs.filter(block => block.includes('test-exercise-ui-mutations.cjs')
    && /node scripts\/test-exercise-ui\.cjs|node scripts\/test-exercise-map\.cjs/.test(block));
  assert.deepEqual(others, [],
    '变异套件和另一个读 exercise-ui.js 的套件共用了同一个 step，会互相污染');
});

// Must be the LAST registration: it reads `registered`, which is only final
// once every case above has been declared.
test('反向验证：这个套件自己还有足够的用例（下限断言）', () => {
  assert.ok(registered >= MIN_CASES,
    `only ${registered} cases are registered, the floor is ${MIN_CASES} — cases were lost, not fixed`);
});
