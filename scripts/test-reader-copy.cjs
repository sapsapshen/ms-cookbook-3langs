/* No reader should ever see "Failed to fetch" or a Python exception string.
   These checks read the shipped sources, because the mapping is the contract.
   Run with: node scripts/test-reader-copy.cjs */
'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const read = path => readFileSync(resolve(ROOT, path), 'utf8');
const FILES = ['assets/discussion.js', 'assets/wishes.js', 'assets/analytics-dashboard.js'];
const KEYS = ['error.serviceDown', 'error.retryLater', 'error.network', 'error.rateLimited'];

let passed = 0;
const failures = [];
function check(name, body) {
  try { body(); passed += 1; console.log('ok  ' + name); }
  catch (error) { failures.push([name, error]); console.log('FAIL ' + name + ': ' + error.message); }
}

check('no reader-facing surface prints a raw error.message', () => {
  for (const file of FILES) {
    const offenders = [...read(file).matchAll(/\.textContent\s*=\s*error\.message|\.textContent\s*=\s*e\.message/g)];
    assert.equal(offenders.length, 0, `${file} still shows ${offenders.length} raw error strings`);
  }
});

check('each file maps status codes through friendlyStatus', () => {
  for (const file of FILES) {
    assert.match(read(file), /function friendlyStatus\(status\)/, `${file} has no friendlyStatus`);
  }
});

check('write requests back off on 503', () => {
  for (const file of ['assets/discussion.js', 'assets/wishes.js']) {
    const source = read(file);
    assert.match(source, /response\.status\s*===\s*503|status\s*===\s*503/, `${file} does not look for 503`);
    assert.match(source, /attempts|attempt/, `${file} does not count retries`);
  }
});

check('all four keys exist in all three locales', () => {
  for (const code of ['zh', 'en', 'es']) {
    const source = read(`assets/locale/${code}.js`);
    for (const key of KEYS) assert.ok(source.includes(`'${key}'`), `${code} is missing ${key}`);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
