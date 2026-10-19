"""Self-test for the translation linter (task-15 temp tool).

Every rule in tmp_task15_lint.py exists because a real slip slipped through
while writing the sheets. This file pins each rule to the string that caused
it plus a neighbour that must NOT trip it, so a later edit to the patterns
cannot silently turn a rule into a no-op or into noise.

Usage:
    python3 scripts/tmp_task15_lint_selftest.py
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import tmp_task15_lint as L  # noqa: E402

# (lang, text, must_be_caught)
CASES = [
    # CJK pasted into Latin prose.
    ('es', 'sacaría nota满分', True),
    ('en', 'the answer is因为任何', True),
    ('es', '。如果 no aplica', True),
    ('en', 'a clean English sentence', False),
    # A word from the other language.
    ('es', 'más Easily se pasa', True),
    ('es', 'te has desviado del camino', False),
    ('es', 'Has encontrado el fichero', False),
    ('en', 'the learner must decide', False),
    # Two words fused by a missing space.
    ('es', 'la plataformathen filtra', True),
    ('en', 'a perfectly normal sentence', False),
    # An asterisk welded between two letters.
    ('es', 'cuando un paso*rinde mal', True),
    ('en', 'the value is total * ratio', False),
    # An English identifier leaking through an underscore.
    ('es', 'el número de_parameters', True),
    ('en', 'the variable train_type is a string', False),
    # A CJK character wedged between Latin letters.
    ('es', 'Si这一步 sale mal', True),
    ('es', 'usa int() y (entero) aquí', False),
    # An English fragment spliced into a Spanish word.
    ('es', 'el problema no seDWUnhandled', True),
    ('es', 'una frase normal en español', False),
    # Mojibake.
    ('en', 'the answer is ' + chr(0xFFFD) + ' here', True),
    ('en', 'the answer is fine here', False),
]


def caught(lang, text):
    """Every signal the linter would raise for this text."""
    body = L.strip_code(text)
    if L.CJK.search(text) or L.CJK_PUNCT.search(text) or L.MOJIBAKE.search(text):
        return True
    if L.HAN_RUN.search(body) or L.MIXED_SCRIPT.search(body):
        return True
    if L.FUSED_ASTERISK.search(body) or L.UNDERSCORE_GLUE.search(body):
        return True
    if L.INTRUDER.search(text) or L.CAPS_GLUE.search(body):
        return True
    if L.foreign_words(lang, text) or L.fused_words(lang, text):
        return True
    return False


def main():
    failures = 0
    for lang, text, want in CASES:
        got = caught(lang, text)
        if got == want:
            print(f'  ok   {"catches" if want else "ignores"}  {text[:44]!r}')
        else:
            failures += 1
            print(f'  FAIL {"catches" if want else "ignores"}  {text[:44]!r}')
    if failures:
        print(f'{failures} rule(s) no longer behave as pinned')
    else:
        print(f'PASS: all {len(CASES)} lint rules behave as pinned')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())