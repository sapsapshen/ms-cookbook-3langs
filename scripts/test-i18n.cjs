const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const vm = require('node:vm');

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