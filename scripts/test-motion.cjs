/* The motion layer's contract, checked against source rather than opinion:
   tokens exist, nothing animates a layout property, reduced motion is honoured
   in both CSS and JS, and the fallback never reintroduces a forced reflow.
   Run with: node scripts/test-motion.cjs */
'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const read = path => readFileSync(resolve(ROOT, path), 'utf8');
const CSS = read('assets/motion.css');
const JS = read('assets/motion.js');
const HTML = read('index.html');
const PAPER = read('assets/paper.js');

let passed = 0;
const failures = [];
function check(name, body) {
  try { body(); passed += 1; console.log('ok  ' + name); }
  catch (error) { failures.push([name, error]); console.log('FAIL ' + name + ': ' + error.message); }
}

const LAYOUT_PROPERTIES = ['width', 'height', 'top', 'left', 'right', 'bottom', 'margin', 'padding'];

check('motion.css declares every token exactly once', () => {
  for (const token of ['--motion-fast', '--motion-base', '--motion-slow', '--ease-out', '--ease-in-out', '--motion-rise']) {
    assert.ok(CSS.includes(token + ':'), `${token} is not declared`);
  }
});

check('no transition or animation touches a layout property', () => {
  for (const property of LAYOUT_PROPERTIES) {
    const pattern = new RegExp(`transition:[^;}]*\\b${property}\\b`, 'g');
    assert.equal((CSS.match(pattern) || []).length, 0, `motion.css transitions ${property}`);
  }
});

check('reveal styles are gated behind .motion-ready', () => {
  assert.match(CSS, /\.motion-ready \[data-reveal\]/, 'reveal rules must require the JS flag');
  assert.ok(!/^\s*\[data-reveal\]\s*\{[^}]*opacity:\s*0/m.test(CSS),
    'a bare [data-reveal]{opacity:0} would hide content when JS never runs');
});

check('prefers-reduced-motion zeroes the duration tokens', () => {
  const block = /@media \(prefers-reduced-motion: reduce\)\{([^}]*)\}/.exec(CSS);
  assert.ok(block, 'no reduced-motion block in motion.css');
  for (const token of ['--motion-fast', '--motion-base', '--motion-slow']) {
    assert.match(block[1], new RegExp(token + ':\\s*0ms'), `${token} not zeroed`);
  }
});

/* Slice the block whose opening brace follows `head`, honouring nesting: the
   reduced-motion block contains rules of its own, so a `[^}]*` capture would
   stop at the first nested brace and assert on a prefix. */
function mediaBlock(head) {
  const start = CSS.indexOf(head);
  assert.notEqual(start, -1, `${head} is missing from motion.css`);
  let depth = 0;
  for (let i = start + head.length - 1; i < CSS.length; i += 1) {
    if (CSS[i] === '{') depth += 1;
    else if (CSS[i] === '}') { depth -= 1; if (depth === 0) return CSS.slice(start, i + 1); }
  }
  throw new Error(`${head} is never closed`);
}

check('the reduced-motion block wins the cascade against the hiding rule', () => {
  // Same specificity as `.motion-ready [data-reveal]:not(.is-revealed)` above;
  // a weaker selector would lose and leave reduced-motion readers on invisible
  // prose, which is exactly what the zeroed tokens alone cannot prevent.
  const reduced = mediaBlock('@media (prefers-reduced-motion: reduce)');
  assert.match(reduced, /\.motion-ready \[data-reveal\]:not\(\.is-revealed\)\s*\{\s*opacity:\s*1\b/,
    'the reduced block must force an unrevealed [data-reveal] back to opacity 1');
});

check('motion.css transitions nothing but transform and opacity', () => {
  const ANIMATABLE = new Set(['transform', 'opacity']);
  const declarations = CSS.match(/transition:\s*[^;}]*/g) || [];
  assert.ok(declarations.length, 'motion.css declares no transition at all');
  for (const declaration of declarations) {
    const value = declaration.slice(declaration.indexOf(':') + 1).trim();
    if (value === 'none') continue;
    for (const part of value.split(',')) {
      const property = part.trim().split(/\s+/)[0];
      assert.ok(ANIMATABLE.has(property),
        `motion.css transitions ${property}; only transform and opacity may animate`);
    }
  }
});

check('motion.js reads reduced motion through matchMedia, not a CSS hack alone', () => {
  // The query's own parentheses are literal: escaping only the outer pair makes
  // them a regex group, which then matches a media query Chromium rejects.
  assert.match(JS, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)/);
});

check('motion.js skips View Transitions under reduced motion', () => {
  assert.match(JS, /if\s*\(reduce\.matches\s*\|\|\s*!document\.startViewTransition\)/);
});

check('the fallback uses WAAPI and never forces layout', () => {
  assert.match(JS, /\.animate\(/, 'fallback should be a one-shot WAAPI animation');
  assert.ok(!/void\s+\w+\.(offsetWidth|offsetHeight|clientHeight)/.test(JS),
    'restarting a class animation with a layout read is the reflow Task 7 removes');
});

check('reveal targets are the three generated lists plus any authored hook', () => {
  for (const selector of ['#articleBody h2', '#homePaths article', '#sceneGrid .scene', '[data-reveal]']) {
    assert.ok(JS.includes(selector), `motion.js does not reveal ${selector}`);
  }
});

check('scan writes the data-reveal hook the CSS gate keys off', () => {
  const body = /function scan\(root\)\s*\{([\s\S]*?)\n  \}/.exec(JS);
  assert.ok(body, 'scan() not found in motion.js');
  assert.match(body[1], /setAttribute\('data-reveal'/,
    'without the hook, CSS never hides the node and the entrance animation is a no-op');
});

check('paper.js routes every view change through Motion.transition', () => {
  assert.match(PAPER, /window\.Motion\.transition\(apply\)/);
  assert.match(PAPER, /const apply = \(\) =>/, 'route() must keep its DOM mutation in one closure');
});

check('index.html links motion.css', () => {
  assert.match(HTML, /<link rel="stylesheet" href="assets\/motion\.css\?v=[0-9a-f]{12}">/);
});

check('motion.js loads before paper.js', () => {
  const order = [...HTML.matchAll(/<script[^>]*\ssrc="assets\/([^"?]+\.js)/g)].map(m => m[1]);
  assert.notEqual(order.indexOf('motion.js'), -1, 'motion.js is not loaded');
  assert.ok(order.indexOf('motion.js') < order.indexOf('paper.js'),
    'route() calls window.Motion.transition at paper.js startup');
});

check('a mid-visit preference change reveals hidden content instead of reloading', () => {
  assert.match(JS, /reduce\.addEventListener\('change'/);
  assert.match(JS, /function revealEverything\(\)/);
  assert.ok(!/window\.location\.reload\(\)/.test(JS), 'reloading the document is not a motion fallback');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
