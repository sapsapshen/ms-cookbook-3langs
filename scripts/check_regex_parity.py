r"""Prove every `stdout_matches` pattern behaves the same in Python and JS.

The harness (`check_exercise_references.py`) grades a reference with **Python**
`re`. The browser grades the learner with a JS `RegExp` built from the very same
`pattern` string. A pattern that means one thing in Python and another in JS is
therefore a latent defect: it either fails a correct learner in the browser or
lets a wrong one through, and neither engine complains.

Rule 16 of the plan tells authors to keep the two engines in agreement but, until
this round, gave them no way to CHECK it. This file is that way, in two halves:

  1. **A static whitelist lint.** Constructs whose meaning differs *by definition*
     are rejected outright, whatever the pattern does:
        named groups `(?<n>...)`, lookbehind `(?<=...)` / `(?<!...)`,
        inline flags `(?i)`, anchors `\A` / `\Z`, atomic groups `(?>...)`,
        possessive quantifiers `*+`, conditionals `(?(...)...)`, `\p{...}`.
     Each entry in `BANNED` explains why in one line, so the failure message
     doubles as the rule.

  2. **A parity run over real inputs.** Every pattern in the corpus is applied to
     the stdout its own reference answer produces, plus a fixed battery of
     adversarial strings (full-width digits, `--flag=value` CLI forms, tabs and
     newlines, the 0.7000000000000001 float tail, ...). Python and node each
     report match/no-match per (pattern, sample) pair and the two lists must be
     identical.

Half 1 catches the always-wrong; half 2 catches the context-dependent — `\d` and
`\w` are Unicode-aware in Python and ASCII-only in JS, so a pattern only diverges
once a non-ASCII digit shows up. That is why the battery carries one, and why the
plan's rule 16 says `\d` is fine *in ASCII contexts* rather than banned.

Usage:
    python scripts/check_regex_parity.py
    pytest scripts/check_regex_parity.py
"""
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from check_exercise_references import executable_items, solve  # noqa: E402
from test_exercises import ROOT, load_exercises  # noqa: E402

# (regex, why it is banned). Order only affects the message, not the verdict.
BANNED = (
    (r'\(\?<[^=!]', 'named group (?<n>...) — Python 3.6+ only, JS has no equivalent'),
    (r'\(\?<[=!]', 'lookbehind (?<=...) / (?<!...) — Python-only, JS must use a lookahead'),
    (r'\(\?[aiLmsux]+\)', 'inline flags (?i) — placement and meaning differ between re and RegExp'),
    (r'\\A', r'\A — string start in Python, a literal "A" in JS'),
    (r'\\Z', r'\Z — string end in Python, a literal "Z" in JS'),
    (r'\(\?>', 'atomic group (?>...) — Python 3.11+ only'),
    (r'[*+?]\+', 'possessive quantifier — Python 3.11+ only, and it silently skips backtracking'),
    (r'\(\?\(', 'conditional pattern (?(...)...) — Python-only'),
    (r'\\[pP]\{', r'\p{...} — needs the third-party regex module in Python'),
)

# Fixed adversarial battery. Each entry exists to trip a specific engine
# difference; the comment says which one.
BATTERY = (
    '',                                                  # empty
    'swift sft --model Qwen/Qwen2.5-0.5B --dataset [\'alpaca-gpt4-data.json\'] '
    '--output output/v0-5b-lora --train-type lora --max-length 2048',   # spaced CLI form
    "swift sft --model='Qwen/Qwen2.5-0.5B' --dataset=['alpaca-gpt4-data.json'] "
    '--output=output/v0-5b-lora --train-type=lora --max-length=2048',    # '=' CLI form
    'swift sft\n\t--model  Qwen/Qwen2.5-0.5B\r\n--train-type   lora',     # mixed whitespace
    '我是沈愐，我想学Agent 开发\n',                                        # CJK, same line
    '我是沈愐，\n我想学\nAgent 开发\n',                                   # CJK across lines
    '我是沈愐，我想学\n',                                                  # truncated sentence
    '第 07 章 13 道题 2048 tokens',                                      # ASCII digits
    '第 ２０４８ 道题',                                     # full-width digits: \d differs
    '我想学２０４８ tokens',                                 # same, next to CJK: \d differs
    'accuracy 0.7000000000000001 vs 0.7',                   # float tail
    'name = ""\nrole = ""\n',                              # empty variables
)

NODE_DRIVER = """
const chunks = [];
process.stdin.on('data', c => chunks.push(c));
process.stdin.on('end', () => {
  const payload = JSON.parse(chunks.join(''));
  const out = [];
  for (const pattern of payload.patterns) {
    let re;
    try {
      re = new RegExp(pattern);
    } catch (error) {
      out.push({ error: String(error && error.message || error) });
      continue;
    }
    out.push({ hits: payload.samples.map(sample => re.test(sample)) });
  }
  process.stdout.write(JSON.stringify(out));
});
"""


def patterns_by_item():
    """Yield (where, lang, item, [(index, pattern), ...]) for graded regex checks."""
    for lang, where, item in executable_items():
        found = [(index, check['pattern']) for index, check in enumerate(item.get('checks') or [])
                 if check['kind'] == 'stdout_matches']
        if found:
            yield where, lang, item, found


def reference_stdout(item):
    """The stdout the reference answer prints, or '' when it prints nothing.

    Real program output is the input that matters: it is what the pattern was
    written against. `solve` returns a `problem` string instead of stdout when
    the reference does not run standalone; `check_exercise_references.py` already
    fails the build on that, so here the empty string is good enough.
    """
    _mode, stdout, _namespace, _problem = solve(item)
    return stdout


def lint(where, pattern):
    """Banned constructs in one pattern, as human-readable messages."""
    found = []
    for token, why in BANNED:
        if re.search(token, pattern):
            found.append(f'{why} (matched {token!r})')
    return found


def node_matches(patterns, samples):
    """Run every pattern in node; return (results, node_error).

    `results[i]` is either a list of booleans (one per sample) or an error string
    for a pattern JS refuses to compile.
    """
    if shutil.which('node') is None:
        return None, 'node is not on PATH — this check compares against JS RegExp'
    payload = json.dumps({'patterns': patterns, 'samples': list(samples)}, ensure_ascii=False)
    done = subprocess.run(['node', '-e', NODE_DRIVER], input=payload, capture_output=True, text=True)
    if done.returncode != 0:
        return None, f'node exited {done.returncode}: {done.stderr.strip()}'
    try:
        return json.loads(done.stdout), None
    except json.JSONDecodeError as error:
        return None, f'node returned unreadable output ({error}): {done.stdout[:200]!r}'


def run_all():
    """Return (failures, checked_patterns, checked_pairs)."""
    entries = list(patterns_by_item())
    failures = []
    for where, _lang, _item, found in entries:
        for index, pattern in found:
            for problem in lint(where, pattern):
                failures.append(f'{where} checks[{index}] uses {problem}: {pattern}')

    patterns, owners, samples = [], [], list(BATTERY)
    for where, _lang, item, found in entries:
        samples.append(reference_stdout(item))   # real program output, per exercise
        for index, pattern in found:
            patterns.append(pattern)
            owners.append((where, index))
    results, error = node_matches(patterns, samples)
    if error:
        return failures + [error], len(patterns), 0

    pairs = 0
    for position, ((where, index), pattern) in enumerate(zip(owners, patterns)):
        got = results[position]
        if isinstance(got, dict) and got.get('error'):
            failures.append(f'{where} checks[{index}] does not compile as a JS RegExp: '
                            f'{got["error"]} (pattern: {pattern})')
            continue
        python_hits = [bool(re.search(pattern, sample)) for sample in samples]
        for sample, py_hit, js_hit in zip(samples, python_hits, got['hits']):
            pairs += 1
            if py_hit != js_hit:
                failures.append(
                    f'{where} checks[{index}] diverges: Python says {py_hit}, JS says {js_hit} '
                    f'for {sample[:60]!r} (pattern: {pattern})')
    return failures, len(patterns), pairs


def test_regex_parity():
    """pytest entry point; CI can also run this file directly."""
    failures, patterns, pairs = run_all()
    assert patterns, 'no stdout_matches patterns found — the corpus loader is broken'
    assert not failures, '\n'.join(f'FAIL: {problem}' for problem in failures)


def main():
    try:
        failures, patterns, pairs = run_all()
    except AssertionError as error:
        print(f'FAIL: {error}', file=sys.stderr)
        return 1
    print(f'{patterns} stdout_matches patterns, {pairs} (pattern, sample) pairs '
          f'compared under Python re and JS RegExp')
    if failures:
        print('--- failures ---', file=sys.stderr)
        for problem in failures:
            print(f'FAIL: {problem}', file=sys.stderr)
        return 1
    print('PASS: every stdout_matches pattern compiles in both engines and agrees '
          'on every sample')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
