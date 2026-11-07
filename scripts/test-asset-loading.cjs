/* The injection primitive every lazy bundle in this site rides on.
   Run with: node scripts/test-asset-loading.cjs */
'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
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

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}
main();
