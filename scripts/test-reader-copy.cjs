/* No reader should ever see "Failed to fetch" or a Python exception string.
   These checks read the shipped sources, because the mapping is the contract,
   and run the extracted api() helper against a fake fetch to prove a GET goes
   out exactly once and a write is only replayed on a 503.
   Run with: node scripts/test-reader-copy.cjs */
'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm');

const ROOT = resolve(__dirname, '..');
const read = path => readFileSync(resolve(ROOT, path), 'utf8');
const FILES = ['assets/discussion.js', 'assets/wishes.js', 'assets/analytics-dashboard.js'];
const KEYS = ['error.serviceDown', 'error.retryLater', 'error.network', 'error.rateLimited'];

let passed = 0;
const failures = [];
const checks = [];
function check(name, body) { checks.push([name, body]); }

/* api() lives inside an IIFE, so slice `const wait` … the closing brace of
   api() and evaluate that slice in a vm with a fake fetch, an immediate
   setTimeout (records the backoff), a recording console and local
   t()/session stubs. */
function apiFrom(file, fetchImpl, delays, logged) {
  const source = read(file);
  const start = source.indexOf('const wait');
  assert.ok(start >= 0, `${file} has no wait helper`);
  const apiAt = source.indexOf('async function api', start);
  assert.ok(apiAt > start, `${file} has no api helper`);
  const bodyAt = source.indexOf('{', source.indexOf(')', apiAt));
  let depth = 0, quote = '', escaped = false, end = -1;
  for (let i = bodyAt; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"' || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) { end = i + 1; break; }
  }
  assert.ok(end > start, `${file} has an unbalanced api helper`);
  const factory = `(function() {
    const session = { csrf: 'test' };
    function t(key) { return key; }
    function refreshSession() {}
    ${source.slice(start, end)}
    return api;
  })()`;
  return vm.runInNewContext(factory, {
    fetch: fetchImpl,
    setTimeout: (fn, ms) => { delays.push(ms); return fn(); },
    console: { error: (...args) => logged.push(args) },
  });
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

check('a network throw on a write is never retried', async () => {
  for (const file of ['assets/discussion.js', 'assets/wishes.js']) {
    for (const method of ['POST', 'DELETE']) {
      let calls = 0;
      const delays = [], logged = [];
      const api = apiFrom(file, () => { calls += 1; return Promise.reject(new TypeError('Failed to fetch')); }, delays, logged);
      await assert.rejects(
        api('/api/wishes', { method, body: method === 'POST' ? '{"text":"hi"}' : undefined }),
        error => error.message === 'error.network',
        `${file} did not surface error.network for ${method}`
      );
      assert.equal(calls, 1, `${file} replayed a ${method} ${calls} times after a network throw`);
      assert.equal(logged.length, 1, `${file} swallowed the ${method} network cause without a console.error`);
      assert.equal(logged[0][1].message, 'Failed to fetch', `${file} console.error logged something other than the cause`);
    }
  }
});

check('a network throw on a GET is not retried', async () => {
  for (const file of ['assets/discussion.js', 'assets/wishes.js']) {
    let calls = 0;
    const delays = [], logged = [];
    const api = apiFrom(file, () => {
      calls += 1;
      return Promise.reject(new TypeError('Failed to fetch'));
    }, delays, logged);
    await assert.rejects(
      api('/api/session'),
      error => error.message === 'error.network',
      `${file} did not surface error.network for a GET`
    );
    assert.equal(calls, 1, `${file} replayed a GET ${calls} times after a network throw`);
    assert.deepEqual(delays, [], `${file} backed off before failing a GET`);
    assert.equal(logged.length, 1, `${file} swallowed the GET network cause without a console.error`);
    assert.equal(logged[0][1].message, 'Failed to fetch', `${file} console.error logged something other than the cause`);
  }
});

check('a 503 on a GET is not retried either', async () => {
  for (const file of ['assets/discussion.js', 'assets/wishes.js']) {
    let calls = 0;
    const delays = [], logged = [];
    const api = apiFrom(file, () => {
      calls += 1;
      return Promise.resolve({ status: 503, ok: false, json: async () => { throw new SyntaxError('not json'); } });
    }, delays, logged);
    await assert.rejects(
      api('/api/session'),
      error => error.message === 'error.serviceDown',
      `${file} did not surface error.serviceDown for a GET`
    );
    assert.equal(calls, 1, `${file} made ${calls} calls for a 503 on a GET`);
    assert.deepEqual(delays, [], `${file} backed off on a 503 for a GET`);
  }
});

check('a 503 on a write still backs off 400 ms then 800 ms', async () => {
  for (const file of ['assets/discussion.js', 'assets/wishes.js']) {
    let calls = 0;
    const delays = [];
    const api = apiFrom(file, () => {
      calls += 1;
      if (calls < 3) return Promise.resolve({ status: 503, ok: false, json: async () => ({ detail: 'busy' }) });
      return Promise.resolve({ status: 200, ok: true, json: async () => ({ id: calls }) });
    }, delays, []);
    const data = await api('/api/wishes', { method: 'POST', body: '{}' });
    assert.equal(calls, 3, `${file} made ${calls} calls for a 503 that cleared`);
    assert.equal(data.id, 3, `${file} lost the response after a 503 retry`);
    assert.deepEqual(delays, [400, 800], `${file} changed the 503 backoff`);
  }
});

check('a 503 that never clears stops after two retries', async () => {
  for (const file of ['assets/discussion.js', 'assets/wishes.js']) {
    let calls = 0;
    const delays = [];
    const api = apiFrom(file, () => {
      calls += 1;
      // A 503 from a proxy may not even be JSON; the status mapping must win.
      return Promise.resolve({ status: 503, ok: false, json: async () => { throw new SyntaxError('not json'); } });
    }, delays, []);
    await assert.rejects(
      api('/api/wishes', { method: 'POST', body: '{}' }),
      error => error.message === 'error.serviceDown',
      `${file} did not surface error.serviceDown`
    );
    assert.equal(calls, 3, `${file} made ${calls} calls before giving up on 503`);
    assert.deepEqual(delays, [400, 800], `${file} changed the 503 backoff`);
  }
});

(async () => {
  for (const [name, body] of checks) {
    try { await body(); passed += 1; console.log('ok  ' + name); }
    catch (error) { failures.push([name, error]); console.log('FAIL ' + name + ': ' + error.message); }
  }
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
})();
