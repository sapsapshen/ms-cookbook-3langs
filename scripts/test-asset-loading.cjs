/* The injection primitive every lazy bundle in this site rides on.
   Run with: node scripts/test-asset-loading.cjs */
'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { createHash } = require('node:crypto');
const vm = require('node:vm');

const ROOT = resolve(__dirname, '..');
const SOURCE = readFileSync(resolve(ROOT, 'assets/asset-loader.js'), 'utf8');

let passed = 0;
const failures = [];
async function check(name, body) {
  try { await body(); passed += 1; console.log('ok  ' + name); }
  catch (error) { failures.push([name, error]); console.log('FAIL ' + name + ': ' + error.message); }
}

/* A DOM small enough to watch what the loader does, and nothing more. */
function makeDom() {
  const nodes = [];
  const head = { append(node) { nodes.push(node); return node; } };
  return {
    nodes,
    window: {},
    document: {
      head,
      createElement: tag => ({
        tag, src: '',
        remove() { const at = nodes.indexOf(this); if (at >= 0) nodes.splice(at, 1); },
        set onload(fn) { this._load = fn; }, get onload() { return this._load; },
        set onerror(fn) { this._error = fn; }, get onerror() { return this._error; },
      }),
    },
    settle(index, ok) {
      const node = nodes[index];
      if (ok) node.onload(); else node.onerror(new Error('network'));
      return node;
    },
  };
}

function boot() {
  const dom = makeDom();
  vm.runInNewContext(SOURCE, { window: dom.window, document: dom.document });
  return { dom, loader: dom.window.AssetLoader };
}

async function main() {
  await check('asset-loader.js is syntactically valid and exports AssetLoader', () => {
    assert.ok(boot().loader.loadScript, 'loadScript missing');
    assert.ok(boot().loader.loadSequence, 'loadSequence missing');
  });

  await check('one src is injected exactly once, even when requested twice', () => {
    const { dom, loader } = boot();
    const first = loader.loadScript('assets/a.js');
    const second = loader.loadScript('assets/a.js');
    assert.equal(dom.nodes.length, 1, 'a second tag was injected for the same src');
    assert.equal(first, second, 'the promise was not reused');
  });

  await check('loadSequence injects in order and resolves only after each lands', async () => {
    const { dom, loader } = boot();
    const done = [];
    const running = loader.loadSequence(['assets/a.js', 'assets/b.js']).then(list => done.push(list));
    await Promise.resolve();
    assert.equal(dom.nodes.length, 1, 'the second script started before the first finished');
    dom.settle(0, true);
    await Promise.resolve();
    assert.equal(dom.nodes.length, 2);
    assert.equal(dom.nodes[1].src, 'assets/b.js');
    dom.settle(1, true);
    await running;
    assert.deepEqual(done, [['assets/a.js', 'assets/b.js']]);
  });

  await check('a failed injection rejects and is retryable', async () => {
    const { dom, loader } = boot();
    const failed = loader.loadScript('assets/a.js');
    dom.settle(0, false);
    await assert.rejects(failed);
    assert.equal(dom.nodes.length, 0, 'the failed tag was left in the document');
    const again = loader.loadScript('assets/a.js');
    assert.equal(dom.nodes.length, 1, 'a retry must be allowed after failure');
    dom.settle(0, true);
    assert.equal(await again, 'assets/a.js');
  });

  await check('i18n.js declares the lazy paths for en and es, each versioned', () => {
    const source = readFileSync(resolve(ROOT, 'assets/i18n.js'), 'utf8');
    /* The fingerprints are compared against the files they name rather than
       written as literals here: this same change edits both locale files, so a
       hard-coded hash would be stale by the time the commit lands -- and a stale
       one is exactly the bug the assertion exists to catch, not an exception to
       it. */
    const sha = path => createHash('sha256').update(readFileSync(resolve(ROOT, path))).digest('hex').slice(0, 12);
    for (const code of ['en', 'es']) {
      const pattern = new RegExp(`\\b${code}:\\s*\\[\\s*'assets/locale/${code}\\.js\\?v=([0-9a-f]{12})',\\s*'assets/content-i18n/${code}\\.js\\?v=([0-9a-f]{12})'`);
      const match = pattern.exec(source);
      assert.ok(match, `${code} lazy paths missing or unversioned`);
      assert.equal(match[1], sha(`assets/locale/${code}.js`), `assets/locale/${code}.js is pinned to a stale ?v=`);
      assert.equal(match[2], sha(`assets/content-i18n/${code}.js`), `assets/content-i18n/${code}.js is pinned to a stale ?v=`);
    }
  });

  await check('i18n.set waits for the pack before it notifies', () => {
    const source = readFileSync(resolve(ROOT, 'assets/i18n.js'), 'utf8');
    assert.match(source, /async function set\(code, options\)/, 'set must be async');
    assert.match(source, /await load\(code\)/, 'set must await the pack');
  });

  await check('paper.js lists the exercise bundle in load order', () => {
    const source = readFileSync(resolve(ROOT, 'assets/paper.js'), 'utf8');
    const list = /const EXERCISE_BUNDLE = \[([\s\S]*?)\]/.exec(source);
    assert.ok(list, 'EXERCISE_BUNDLE is not declared in paper.js');
    const modules = [...list[1].matchAll(/'assets\/([^'?]+)\.js/g)].map(m => m[1] + '.js');
    assert.deepEqual(modules, [
      'exercises.js', 'exercise-grader.js', 'exercise-store.js',
      'exercise-sandbox.js', 'exercise-map.js', 'exercise-ui.js',
    ], 'exercises.js must stay first: exercise-map.js reads window.EXERCISE_DATA at load');
  });

  await check('index.html no longer ships the lazy bundles', () => {
    const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
    for (const name of ['exercises.js', 'exercise-ui.js', 'locale/en.js', 'content-i18n/es.js']) {
      assert.ok(!html.includes('assets/' + name), `index.html still loads ${name}`);
    }
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}
main();
