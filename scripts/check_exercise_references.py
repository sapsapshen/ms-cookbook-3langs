"""Prove every reference answer satisfies its own checks.

`scripts/test_exercises.py` validates the corpus SHAPE — field types, enums,
compilable check code, id parity across languages. It never runs anything, so a
reference that scores 40% on its own checks passes it. This script closes that
gap: it executes every `code` / `build` reference in a namespace that mirrors
the Pyodide sandbox, grades the outcome with the rules from
`assets/exercise-grader.js`, and requires a full score. `reflect` and `predict`
have no machine check (self-assessment / multi-select), so they are skipped.

On top of "the reference scores 100%", two invariants target the defect class
that motivated this file — a check that does not actually verify what the
prose promises:

  * Standalone references. A reference that only runs after the starter has
    been prepended is reported as a failure even when the fallback scores 100%.
    Reference answers are read on their own, so they have to stand alone.
  * Assertion A. When `explanation` quotes a concrete call on an exercise
    function — `metrics(0, 0, 0)`, `judge(0, 0.9)` — at least one check has to
    exercise that same call. This is the mechanical half of "the explanation's
    core claim must be covered by a check".

Assertion B (normative prose — "must not be skipped", "the key point is") is
deliberately NOT a hard assertion; `normative_claims` explains why and keeps it
as an advisory list instead.

Simulating the sandbox is only half of the job, and this file simulates HALF of
the half. Task 6's Pyodide worker publishes SEVEN `__sils_*` globals; this
harness publishes ONE. The gaps are deliberate (the harness grades a reference
it already controls), but they change what a passing result PROVES, so they are
spelled out here rather than left for Task 6 to discover:

  1. stderr is merged into the stdout buffer. The worker wraps the exec in
     `contextlib.redirect_stdout(_out), contextlib.redirect_stderr(_out)` with
     ONE buffer, and `evaluateHostChecks` is handed that single `stdout`. So
     `stdout_matches` / `stdout_contains` / `stdout_equals` really mean
     "stdout + stderr". This harness reproduces the merge, which means
     `print(cmd, file=sys.stderr)` SATISFIES `stdout_matches` here. That is not
     a harness bug — it is the worker contract — but a corpus author who wants
     "printed to stdout" must know it, because a learner who writes to stderr
     still passes.
  2. `__sils_error` and `__sils_ok` are NOT simulated. The worker catches
     `BaseException`, stores the traceback in `__sils_error`, and flips
     `__sils_ok` to False; the message handler then blanks EVERY sandbox
     outcome to `null` (`{ok: false, detail: 'code did not run'}`). This
     harness lets the exception escape to `solve()` instead and reports it as a
     non-standalone reference. Same verdict, different route.
  3. `__sils_assert_ok` and `__sils_assert_detail` (the worker's per-assert
     result slot, which produces the UI's failure message) are NOT simulated —
     `outcome()` below reduces an assertion to a bare True/False.
  4. `__sils_found` and `__sils_value` (the worker's variable-read slot behind
     `var_equals` / `var_in_range`) are NOT simulated — `outcome()` reads
     `namespace` directly. One real consequence: the worker distinguishes
     "never assigned" (`found === false`) from "assigned a wrong value", while
     here both are just a falsy comparison.
  5. `__sils_src` does not exist anywhere — not in the worker, not here. A check
     that needs the learner's SOURCE cannot be written yet; see the note at the
     end of the Task 3 report.

Task 6 MUST keep the worker aligned with this harness on points 1 and 2, since
that is the semantics this file already proves the corpus against: stderr
merged into the same buffer, and a crashed program scoring zero on the sandbox
checks rather than being graded on partial output.

Usage:
    python scripts/check_exercise_references.py
    pytest scripts/check_exercise_references.py
"""
import contextlib
import io
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_exercises import ROOT, load_exercises  # noqa: E402

GRADER = ROOT / 'assets' / 'exercise-grader.js'
EXECUTABLE_TYPES = {'code', 'build'}
SKIPPED_TYPES = {'reflect', 'predict'}
DEFINITION = re.compile(r'^[ \t]*def\s+([A-Za-z_]\w*)\s*\(', re.MULTILINE)
CALL = re.compile(r'\b([A-Za-z_]\w*)\(([^()]*)\)')
LITERAL = re.compile(r'\d')

# Normative markers per language. Advisory only — see normative_claims().
NORMATIVE = {
    'zh': re.compile(r'必须|不能省|不能|关键|务必|一定要'),
    'en': re.compile(r'\bmust\b|\bnever\b|\bcannot\b|\bessential\b|\bcritical\b', re.IGNORECASE),
    'es': re.compile(r'\bdebe\b|\bnunca\b|\bnecesari|\bobligatori|\bclave', re.IGNORECASE),
}


def pass_threshold():
    """The learner's pass mark, read from the grader instead of restated here."""
    source = GRADER.read_text(encoding='utf-8')
    found = re.search(r'const PASS_THRESHOLD = ([0-9.]+);', source)
    if not found:
        raise SystemExit(f'FAIL: cannot read PASS_THRESHOLD from {GRADER.name}')
    return float(found.group(1))


def executable_items():
    """Yield (lang, where, item) for every machine-checked exercise.

    Ordered by chapter number then language so a report reads 07 -> 13 -> 33
    instead of the alphabetical chapter-13, chapter-33, chapter-7 that a plain
    sort on the chapter id produces.
    """
    _manifest, corpus = load_exercises()
    for (chapter_id, lang), items in sorted(
            corpus.items(), key=lambda entry: (int(entry[0][0].split('-')[1]), entry[0][1])):
        for item in items:
            yield lang, f"{item['_file']}:{item['id']}", item


def _run(program):
    """Execute like the Pyodide worker does, then publish `__sils_stdout`.

    Task 6's `runUserCode` runs the learner's code with stdout redirected into a
    buffer and stores the result in a `__sils_stdout` global before any check
    runs. The checks then execute in that same global namespace, so an
    `assert_python` check can read what the learner printed. This harness
    reproduces both halves: the redirection and the global, so a check written
    against the real sandbox behaves identically here.

    The redirection is the SAME single buffer for stdout and stderr, exactly as
    in the worker — see point 1 in the module docstring. That is why a
    `print(..., file=sys.stderr)` satisfies `stdout_matches` here, and Task 6
    must not "fix" the worker into two buffers without changing this too.

    Unlike the worker this does not publish `__sils_error` / `__sils_ok`; the
    exception escapes to `solve()`. See point 2 in the module docstring.
    """
    namespace, out = {}, io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(out):
        exec(compile(program, '<program>', 'exec'), namespace)
    namespace['__sils_stdout'] = out.getvalue()
    return out.getvalue(), namespace


def solve(item):
    """Run the reference the way the sandbox would.

    Returns (mode, stdout, namespace, problem). `problem` is None on a clean
    standalone run; it carries the failure text otherwise. The starter fallback
    exists so the report can still show a score for a broken reference, but it
    is reported as a failure: a reference that needs the starter is not
    standalone, which the corpus rules forbid.

    A raising reference reaches the caller as `problem`; the worker reaches the
    same verdict a different way, by publishing `__sils_ok = False` and blanking
    every sandbox outcome (point 2 in the module docstring). Both score zero on
    the sandbox checks, so the two paths agree on the verdict.
    """
    reference = item['reference']
    try:
        stdout, namespace = _run(reference)
        return 'reference-alone', stdout, namespace, None
    except NameError:
        pass
    except Exception as error:  # noqa: BLE001
        return 'reference-alone', '', {}, f'reference raised {type(error).__name__}: {error}'
    try:
        stdout, namespace = _run((item.get('starter') or '') + '\n' + reference)
    except Exception as error:  # noqa: BLE001
        return 'starter+reference', '', {}, \
            f'starter + reference raised {type(error).__name__}: {error}'
    return 'starter+reference', stdout, namespace, \
        'reference is not standalone: it needs names the starter defines'


def outcome(check, stdout, namespace):
    """One check result, or None when the kind needs a learner answer.

    `stdout` is the MERGED stdout+stderr buffer (see point 1 in the module
    docstring), so every `stdout_*` kind below sees stderr too — the same input
    the worker's `evaluateHostChecks` receives. This function does not simulate
    the worker's `__sils_assert_ok` / `__sils_assert_detail` /
    `__sils_found` / `__sils_value` slots (points 3 and 4): it reduces each
    check to a bare boolean and reads the namespace directly.
    """
    kind = check['kind']
    try:
        if kind == 'assert_python':
            exec(compile(check['code'], '<check>', 'exec'), namespace)
            return True
        if kind == 'stdout_matches':
            return bool(re.search(check['pattern'], stdout))
        if kind == 'stdout_contains':
            return check['value'] in stdout
        if kind == 'stdout_equals':
            return stdout.strip() == str(check['value']).strip()
        if kind == 'var_equals':
            return namespace.get(check['name']) == check['value']
        if kind == 'var_in_range':
            value = namespace.get(check['name'])
            return isinstance(value, (int, float)) and check['min'] <= value <= check['max']
    except Exception:  # noqa: BLE001
        # The sandbox reports any exception from a check as a failure, so a
        # NameError on an undefined function is a failed check, not a crash.
        return False
    return None


def grade(item, stdout, namespace):
    """Weighted score using assets/exercise-grader.js rules.

    self_assessed checks are never scored, a non-positive weight normalises to
    1, and an unevaluable kind earns nothing — the same fail-closed behaviour
    the grader documents. Returns (earned, total, failed_kinds).
    """
    earned = total = 0
    failed = []
    for check in item.get('checks') or []:
        if check['kind'] == 'self_assessed':
            continue
        weight = check['weight']
        weight = weight if isinstance(weight, (int, float)) and weight > 0 else 1
        total += weight
        ok = outcome(check, stdout, namespace)
        if ok is True:
            earned += weight
        else:
            failed.append(check['kind'])
    return earned, total, failed


def exercise_functions(item):
    """Names the exercise itself defines — the only calls worth cross-checking."""
    names = set()
    for source in (item.get('starter') or '', item.get('reference') or ''):
        names.update(DEFINITION.findall(source))
    return names


def quoted_calls(text, known):
    """Concrete `fn(<literal args>)` calls in prose, whitespace-normalised."""
    calls = []
    for name, args in CALL.findall(text or ''):
        if name in known and LITERAL.search(args):
            calls.append(name + '(' + re.sub(r'\s+', '', args) + ')')
    return calls


def assertion_a(item):
    """Explanation calls that no check runs — the 'core claim uncovered' smell.

    Scoped narrowly on purpose. It only looks at `explanation` (the field that
    states conclusions; `prompt` legitimately shows worked examples that no
    check should run), only at functions the exercise defines (so `round(x, 3)`
    or `print(...)` in prose are ignored), and only at calls carrying a literal
    argument (so `metrics(correct, minor, wrong)` as a signature is ignored).
    """
    known = exercise_functions(item)
    if not known:
        return []
    haystack = re.sub(r'\s+', '', ' '.join(
        check.get('code') or '' for check in item.get('checks') or []))
    return [call for call in quoted_calls(item.get('explanation'), known)
            if call not in haystack]


def normative_claims(lang, where, item):
    """Advisory only: normative prose that a reader should back with a check.

    This is the unimplemented half of the requested assertion pair. A hard
    version would have to recognise "必须 / 不能省 / must not / clave" in three
    languages and then decide which check covers the claim — the first half is a
    keyword list over prose that varies per author, and the second half has no
    answer in general ("dataset 必须是列表" is covered by a value assertion,
    "早返回更易读" is covered by nothing and should not be). Both directions
    misfire, so listing the claims keeps the signal without failing the build on
    a wording choice. The mechanical guard against uncovered claims is
    assertion_a().
    """
    if lang not in NORMATIVE:
        return []
    found = NORMATIVE[lang].search(item.get('explanation') or '')
    return [f'{where}: "{found.group(0)}"'] if found else []


def run_all():
    """Return (failures, advisories, checked, skipped)."""
    threshold = pass_threshold()
    failures, advisories = [], []
    checked = skipped = 0
    for lang, where, item in executable_items():
        if item['type'] in SKIPPED_TYPES:
            skipped += 1
            continue
        if item['type'] not in EXECUTABLE_TYPES:
            skipped += 1
            continue
        checked += 1
        mode, stdout, namespace, problem = solve(item)
        if problem:
            failures.append(f'{where} {problem}')
            print(f'ERR  {where:<34} {mode:<18} {problem}')
            continue
        earned, total, failed = grade(item, stdout, namespace)
        score = earned / total if total else 0.0
        flag = 'OK  ' if score >= 1.0 else 'FAIL'
        print(f'{flag} {where:<34} {mode:<18} {earned:>3}/{total:<3} {score:>6.1%}'
              + (f'  missed: {",".join(failed)}' if failed else ''))
        if score < 1.0:
            failures.append(
                f'{where} reference scores {score:.0%} against its own checks '
                f'({earned}/{total}); failed: {",".join(failed) or "none"}')
        if score < threshold:
            failures.append(
                f'{where} reference would not even reach the {threshold:.0%} pass mark')
        for uncovered in assertion_a(item):
            failures.append(f'{where} explanation calls {uncovered} but no check runs it')
        advisories.extend(normative_claims(lang, where, item))
    return failures, advisories, checked, skipped


def test_references_score_full_marks():
    """pytest entry point; CI also runs this file directly."""
    failures, _advisories, checked, skipped = run_all()
    assert checked, 'no executable exercises found — the corpus loader is broken'
    assert not failures, '\n'.join(f'FAIL: {problem}' for problem in failures)


def main():
    try:
        failures, advisories, checked, skipped = run_all()
    except AssertionError as error:
        print(f'FAIL: {error}', file=sys.stderr)
        return 1
    print('\n--- advisory: normative claims (does not fail the run) ---')
    for note in advisories:
        print(' *', note)
    if not advisories:
        print('(none)')
    if failures:
        print('--- failures ---', file=sys.stderr)
        for problem in failures:
            print(f'FAIL: {problem}', file=sys.stderr)
        return 1
    print(f'PASS: {checked} executable references across 3 languages score 100% '
          f'({skipped} prose exercises skipped)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
