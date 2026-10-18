const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const vm = require('node:vm');

/* The exercise panel's copy.
 *
 * assets/i18n.js:28-36 makes two failures indistinguishable from a typo at a
 * glance: a missing key returns the key itself, and it RETURNS BEFORE the
 * `{name}` substitution loop runs. So a key that exists but whose placeholder
 * is misspelled renders as the sentence with a literal `{ttoal}` in it, and no
 * test that asserts only "key is present" can see either defect.
 *
 * Every assertion below therefore goes through the real runtime with the real
 * dictionaries, and checks the RENDERED string rather than the key set alone.
 */

/* The real lookup table, loaded the way the browser loads it. A stub
 * `t: key => key` would swallow the vars argument and make this file vacuous.
 *
 * `window` has to BE the sandbox's own global object, not a separate object
 * hanging off it: assets/i18n.js publishes onto `window.MSI18N` while the
 * locale files call the bare `MSI18N.register(...)`, so a detached `window`
 * leaves the register calls looking for a global that was never defined.
 *
 * The DOM stubs exist only so set() -> notify() -> apply() can walk an empty
 * document; nothing here renders. */
function runtime() {
  const empty = () => [];
  const sandbox = {
    document: {
      readyState: 'loading',
      addEventListener() {},
      querySelectorAll: empty,
      querySelector: () => null,
      documentElement: {getAttribute: () => null, setAttribute() {}},
      title: ''
    },
    localStorage: {getItem: () => null, setItem() {}},
    console
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInNewContext(readFileSync(resolve(__dirname, '../assets/i18n.js'), 'utf8'), sandbox);
  for (const language of ['zh', 'en', 'es']) {
    vm.runInNewContext(readFileSync(resolve(__dirname, `../assets/locale/${language}.js`), 'utf8'), sandbox);
  }
  assert.ok(sandbox.MSI18N, 'i18n.js did not publish MSI18N');
  return sandbox.MSI18N;
}

/* The raw per-language dictionaries, keyed by language. Presence is asserted
 * against THESE rather than through t(), because t() falls back to zh
 * (assets/i18n.js:30-32): an entry deleted from es.js still renders -- in
 * Chinese -- so a `t(key) !== key` assertion over it passes while Spanish
 * readers see the wrong language. Verified by mutation: removing
 * exercise.chooseAnswer from es.js leaves such an assertion green. */
function dictionaries() {
  const all = {};
  for (const language of ['zh', 'en', 'es']) {
    const entries = {};
    vm.runInNewContext(readFileSync(resolve(__dirname, `../assets/locale/${language}.js`), 'utf8'), {
      MSI18N: {register: (code, values) => { assert.equal(code, language); Object.assign(entries, values); }}
    });
    all[language] = entries;
  }
  return all;
}

/* Every key the exercise UI asks for. Two of them are assembled at runtime
 * rather than written out: `t(\`exercise.${key}Label\`)` needs both labelledEditor
 * call sites resolved, and ANSWER_LABELS hides three more behind a lookup. A
 * grep for t('exercise...') alone misses all five. */
const KEYS = [
  'a11y.exercisePanel',
  'exercise.chooseAnswer',
  'exercise.codeLabel',
  'exercise.correct',
  'exercise.elapsed',
  'exercise.headerCount',
  'exercise.incorrect',
  'exercise.loading',
  'exercise.mapTitle',
  'exercise.mapTotal',
  'exercise.optionPlaceholder',
  'exercise.optionsUnparsed',
  'exercise.reflectLabel',
  'exercise.reflectPlaceholder',
  'exercise.reset',
  'exercise.run',
  'exercise.sandboxFailed',
  'exercise.score',
  'exercise.selfFail',
  'exercise.selfPartial',
  'exercise.selfPass',
  'exercise.selfRecorded',
  'exercise.solution',
  'exercise.statePassed',
  'exercise.stateSelf',
  'exercise.stateTodo',
  'exercise.submit',
  'exercise.synced',
  'exercise.title'
];

/* The variable names are read off the call sites, not guessed:
 *   exercise-ui.js:559  t('exercise.score', {percent})
 *   exercise-ui.js:559  t('exercise.elapsed', {ms})
 *   exercise-ui.js:840  t('exercise.headerCount', {total, passed})
 *   exercise-map.js:210 t('exercise.mapTotal', {passed, total}) */
const PLACEHOLDERS = {
  'exercise.score': {percent: 80},
  'exercise.elapsed': {ms: 1234},
  'exercise.headerCount': {total: 12, passed: 7},
  'exercise.mapTotal': {passed: 7, total: 12}
};

const SOURCES = ['../assets/exercise-ui.js', '../assets/exercise-map.js'];

/* The keys the SOURCE actually asks for, recovered the same way the panel
 * resolves them at runtime: literal keys, the ANSWER_LABELS table, and the
 * `${key}Label` template paired with its two labelledEditor call sites. */
function keysUsedInCode() {
  const used = new Set();
  for (const file of SOURCES) {
    const source = readFileSync(resolve(__dirname, file), 'utf8');
    for (const [, key] of source.matchAll(/\bt\(\s*['"]((?:exercise|a11y\.exercise)[A-Za-z.]*)['"]/g)) used.add(key);
    for (const [, table] of source.matchAll(/ANSWER_LABELS\s*=\s*\{([^}]*)\}/g)) {
      for (const [, key] of table.matchAll(/'([^']+)'/g)) used.add(key);
    }
    if (/t\(`exercise\.\$\{key\}Label`\)/.test(source)) {
      for (const [, id] of source.matchAll(/labelledEditor\([^,]+,\s*'([a-z]+)'/g)) used.add(`exercise.${id}Label`);
    }
  }
  return used;
}

test('29 个 exercise 词条三语齐备', () => {
  assert.equal(KEYS.length, 29, `清单应为 29 个 key，实际 ${KEYS.length}`);
  const all = dictionaries();
  for (const key of KEYS) {
    for (const language of ['zh', 'en', 'es']) {
      assert.equal(typeof all[language][key], 'string', `${key} missing in ${language}`);
      assert.notEqual(all[language][key], key, `${key} has no ${language} copy`);
      assert.ok(all[language][key].trim(), `${key} is blank in ${language}`);
    }
  }
});

test('带占位符的词条插值后不留 {name}', () => {
  const i18n = runtime();
  for (const [key, vars] of Object.entries(PLACEHOLDERS)) {
    for (const language of ['zh', 'en', 'es']) {
      i18n.set(language, {persist: false});
      const rendered = i18n.t(key, vars);
      assert.doesNotMatch(rendered, /\{[a-z]+\}/, `${key} in ${language} left an unsubstituted placeholder: ${rendered}`);
      for (const value of Object.values(vars)) {
        assert.ok(rendered.includes(String(value)), `${key} in ${language} dropped the value ${value}: ${rendered}`);
      }
    }
  }
});

test('三语 key 集合完全相等', () => {
  // Read the raw dictionaries, not t(): i18n.js falls back to zh, so a key
  // present only in zh renders fine in all three languages and the set
  // difference would be invisible through the runtime.
  const all = dictionaries();
  const sets = {zh: Object.keys(all.zh).sort(), en: Object.keys(all.en).sort(), es: Object.keys(all.es).sort()};
  const diff = (a, b) => sets[a].filter(k => !sets[b].includes(k)).concat(sets[b].filter(k => !sets[a].includes(k)));
  assert.deepEqual(sets.en, sets.zh, `English 与中文差集：${diff('zh', 'en')}`);
  assert.deepEqual(sets.es, sets.zh, `Spanish 与中文差集：${diff('zh', 'es')}`);
});

test('代码里每一个 t() 调用都能在三语中查到', () => {
  const all = dictionaries();
  const used = keysUsedInCode();
  assert.ok(used.size >= 29, `只从源码里提取到 ${used.size} 个 key，解析规则失效`);
  for (const key of used) {
    for (const language of ['zh', 'en', 'es']) {
      assert.equal(typeof all[language][key], 'string', `${key} is called in the exercise sources but missing in ${language}`);
    }
  }
});

test('代码里用到的 key 与本文件清单一一对应', () => {
  const used = keysUsedInCode();
  assert.deepEqual([...used].sort(), [...KEYS].sort(),
    '清单与源码实际调用的 key 不一致：多出的或漏掉的都会在页面上变成字面量 key');
});

test('中文为回退来源：英文西语的占位符与中文一致', () => {
  const all = dictionaries();
  const placeholders = value => (String(value).match(/\{[a-z]+\}/g) || []).sort();
  for (const key of KEYS) {
    const expected = placeholders(all.zh[key]);
    for (const language of ['en', 'es']) {
      assert.deepEqual(placeholders(all[language][key]), expected,
        `${key} 的占位符在 ${language} 中不一致：zh=${expected} ${language}=${placeholders(all[language][key])}`);
    }
  }
});

test('占位符的名字与源码调用点传入的变量一致', () => {
  // The set of names in each dictionary entry must equal the set of keys the
  // call site passes. i18n.js only substitutes the names it is handed, so a
  // typo here renders as literal `{ttoal}` with no error anywhere.
  const all = dictionaries();
  const used = value => (String(value).match(/\{[a-z]+\}/g) || []).map(name => name.slice(1, -1)).sort();
  for (const [key, vars] of Object.entries(PLACEHOLDERS)) {
    const passed = Object.keys(vars).sort();
    for (const language of ['zh', 'en', 'es']) {
      assert.deepEqual(used(all[language][key]), passed,
        `${key} in ${language} declares ${used(all[language][key])} but the call site passes ${passed}`);
    }
  }
  /* The variable names an object literal binds, at the top level only.
 * `{ ms: Math.round(result.ms || 0) }` binds `ms` -- Math, round and result
 * live inside the value expression and are not variables t() is handed. */
function boundNames(body) {
  const parts = [];
  let depth = 0;
  let current = '';
  for (const character of body) {
    if ('([{'.includes(character)) depth += 1;
    else if (')]}'.includes(character)) depth -= 1;
    if (character === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += character;
  }
  parts.push(current);
  return parts.map(part => {
    const colon = part.indexOf(':');
    // `{ total: entry.total }` names the variable before the colon;
    // `{ percent }` is shorthand and names the whole part.
    return (colon === -1 ? part : part.slice(0, colon)).trim();
  }).filter(Boolean).sort();
}

// Every key the sources call WITH a vars object must actually use it --
  // a silently ignored vars argument renders an unsubstituted sentence.
  for (const file of SOURCES) {
    const source = readFileSync(resolve(__dirname, file), 'utf8');
    for (const [, key, vars] of source.matchAll(/\bt\(\s*'((?:exercise|a11y\.exercise)[A-Za-z.]*)'\s*,\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/g)) {
      const names = boundNames(vars);
      assert.ok(names.length > 0, `${key} is called with an empty vars object in ${file}`);
      const expected = Object.keys(PLACEHOLDERS[key] || {}).sort();
      assert.deepEqual(names, expected, `${key} in ${file} passes ${names}, dictionary expects ${expected}`);
    }
  }
});