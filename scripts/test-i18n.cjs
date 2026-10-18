const {test: nodeTest} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const vm = require('node:vm');

/* A floor on the number of cases. Deleting every `test(...)` below leaves this
 * file passing with nothing to say, so an emptied suite would ship as a green
 * CI run proving nothing. The floor sits at the current count minus the floor
 * check itself: adding cases on purpose must never trip it, only losing them
 * should.
 *
 * Registration is counted rather than executed: node:test runs a file's tests
 * after the module finishes evaluating, so `registered` is already final by the
 * time the floor check below runs. */
const MIN_CASES = 3;
let registered = 0;
function test(name, fn) {
  registered += 1;
  return nodeTest(name, fn);
}

// The three dictionaries share one flat namespace, so every key must exist in every
// language and the markup must only reference keys that were shipped.
const dictionaries = {};
for(const language of ['zh','en','es']) {
  const entries = {};
  const context = {MSI18N: {register: (code, values) => { assert.equal(code, language); Object.assign(entries, values); }}};
  vm.runInNewContext(readFileSync(resolve(__dirname, `../assets/locale/${language}.js`), 'utf8'), context);
  dictionaries[language] = entries;
}

const pages = ['../index.html', '../assets/analytics.html'];
for(const page of pages) {
  const markup = readFileSync(resolve(__dirname, page), 'utf8');
  for(const [, key] of markup.matchAll(/data-i18n(?:-html)?="([a-z][a-zA-Z.]*)"/g)) {
    for(const language of Object.keys(dictionaries)) assert.ok(key in dictionaries[language], `${page}: ${key} missing in ${language}`);
  }
  for(const [, list] of markup.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    for(const pair of list.split('|')) {
      const key = pair.split(':')[1];
      for(const language of Object.keys(dictionaries)) assert.ok(key in dictionaries[language], `${page}: ${key} missing in ${language}`);
    }
  }
  }

test('三种语言词条数量与键集合完全一致',()=>{
  const [zh,en,es] = Object.keys(dictionaries).map(language => Object.keys(dictionaries[language]).sort());
  assert.deepEqual(en,zh,'English 词条与中文不一致');
  assert.deepEqual(es,zh,'Spanish 词条与中文不一致');
  assert.ok(zh.length>250,`词条过少：${zh.length}`);
});

test('占位符在所有语言中一一对应',()=>{
  const placeholders = value => (String(value).match(/\{[a-z]+\}/g)||[]).sort();
  for(const key of Object.keys(dictionaries.zh)) {
    const expected = placeholders(dictionaries.zh[key]);
    for(const language of ['en','es']) assert.deepEqual(placeholders(dictionaries[language][key]),expected,`${key} 在 ${language} 中的占位符不一致`);
  }
});

test('中文为缺省语言，其余语言不回落为键名',()=>{
  for(const key of Object.keys(dictionaries.zh)) {
    assert.notEqual(dictionaries.zh[key],key,`${key} 缺少中文翻译`);
    for(const language of ['en','es']) assert.notEqual(dictionaries[language][key],key,`${key} 缺少 ${language} 翻译`);
  }
});
// Must be the LAST registration: it reads `registered`, which is only final
// once every case above has been declared.
test('这个套件自己还有足够的用例（下限断言）',()=>{
  assert.ok(registered>=MIN_CASES,`只注册了 ${registered} 个用例，下限是 ${MIN_CASES} —— 用例是被删掉了，不是被修好了`);
});
