"""Lint the generated en/es corpora for translation slips (task-15 temp tool).

The merge script makes structural parity impossible to break, but nothing
stops a prose field from picking up a stray word from the other language.
These are the failure modes seen while writing the sheets, so each has a
mechanical check:

  * CJK left in en/es prose (test_exercises.py catches it; this reports the
    exact field so the fix is obvious)
  * Spanish text carrying an English function word -- prose pasted from the
    English sheet by mistake
  * English text carrying a Spanish function word
  * objectives over the 60 character limit the validator enforces
  * mojibake: U+FFFD or the C1 range

A hit inside inline code (`...`), a fenced block or a quoted identifier is
not a slip: code, commands and paths are copied verbatim on purpose.
"""
import glob
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EX = os.path.join(ROOT, 'content', 'exercises')
CJK = re.compile(r'[一-鿿　-〿＀-￯]')
# U+FFFD and the C1 control block, written as escapes so the source itself
# stays pure ASCII and no editor can silently normalise the pattern away.
MOJIBAKE = re.compile('[\ufffd\u007f-\u009f]')

# Words that belong to one language and not the other. Used as SETS, not
# patterns: a token either is one of these or it is not, which keeps the test
# free of anchoring bugs. Deliberately limited to function words and adverbs
# that never double as a technical term, so the hit rate stays high.
ENGLISH_WORDS = {
    'the', 'and', 'with', 'that', 'this', 'these', 'those', 'from', 'into',
    'when', 'then', 'than', 'but', 'not', 'are', 'was', 'were', 'has', 'have',
    'had', 'for', 'you', 'your', 'which', 'while', 'where', 'what', 'should',
    'would', 'could', 'must', 'each', 'every', 'both', 'only', 'also', 'more',
    'most', 'less', 'there', 'their', 'its', 'they', 'them', 'were', 'been',
    'being', 'does', 'doing', 'done', 'above', 'below', 'again', 'very',
    'easily', 'surely', 'hence', 'whereas', 'moreover', 'furthermore',
    'learner', 'themselves', 'therefore', 'however', 'instead', 'first',
}
SPANISH_WORDS = {
    'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'del', 'al',
    'que', 'con', 'por', 'para', 'sin', 'sobre', 'entre', 'como', 'más',
    'pero', 'sus', 'está', 'están', 'ser', 'hay', 'le', 'les', 'ya', 'tu',
    'tus', 'ti', 'muy', 'también', 'entonces', 'después', 'antes', 'cada',
    'otro', 'otra', 'puede', 'pueden', 'hace', 'hay', 'será', 'debería',
    'porque', 'entonces', 'único', 'única', 'misma', 'mismo',
}
# Words genuinely shared by both languages, so they are never a hit. `has` is
# the Spanish preterite of `haber` ("te has desviado"), and a sentence may also
# open with "Has ..."; both are correct Spanish, not English leakage.
SHARED = {
    'no', 'son', 'an', 'as', 'at', 'be', 'in', 'is', 'it', 'la', 'el', 'on',
    'or', 'y', 'si', 'tu', 'o', 'ha', 'a', 'e', 'un', 'al', 'del', 'este',
    'esta', 'ese', 'esa', 'uno', 'dos', 'antes', 'sobre', 'entre', 'sin',
    'has', 'hay', 'sea', 'son', 'eran', 'fue', 'poco', 'solo', 'cual',
}
WORD = re.compile(r"[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+")

# Any CJK punctuation or fullwidth form. The en/es prose is Latin-script, and
# the CJK that legitimately survives is confined to the escaped \uXXXX literals
# and to the one zh-preserved pattern, neither of which contains these.
CJK_PUNCT = re.compile(r'[　-〿＀-￯]')
# A run of Han characters: a pasted fragment, not a word.
HAN_RUN = re.compile(r'[一-鿿]{2,}')
# Mixed script inside one token: a Latin letter glued to a Han one.
MIXED_SCRIPT = re.compile(r'[A-Za-z][一-鿿]|[一-鿿][A-Za-z]')

def fused_words(lang, value):
    """English/Spanish tokens with the other language's word glued on."""
    needle = ENGLISH_TAIL if lang == 'es' else SPANISH_TAIL
    return sorted(set(needle.findall(strip_code(value))))

# Corruption seen while writing the sheets: a CJK character wedged between
# Latin letters ("lo que)thischapter", "Si这一步", "capítuloordena"), or a CJK
# verb spliced into a Spanish sentence ("no清除 todos"). Parentheses are
# excluded on purpose -- `int(...)` and `(entero)` are ordinary prose.
INTRUDER = re.compile(r'[A-Za-z][一-鿿][A-Za-z]|[一-鿿][A-Za-z]{2,}'
                      r'|[一-鿿]{2,}[A-Za-z]')

# An escape that lost its leading backslash-u and now reads as letters:
# "\\u00bfEntiende" decodes to "bfEntiende". The pattern is a two-letter
# fragment that looks like a hex escape's tail followed by a capital.
BROKEN_ESCAPE = re.compile(r'\\\\u[0-9a-fA-F]{0,2}[a-z]{2}[A-Z]')

# A stray English fragment spliced into a Spanish word ("el problema no seDW",
# "no清除 todos"): two or more lowercase letters, then a short capitalised run
# glued to the end, mid-sentence. Identifiers are excluded by strip_code.
CAPS_GLUE = re.compile(r'[a-z]{2}[A-Z][a-zA-Z]+')
# Real camelCase names the rule above would otherwise report. Every entry here
# was confirmed to be a legitimate product or library name, not a splice.
CAMEL_OK = {
    'elScope', 'alScope', 'inHash', 'imHash', 'vaScript', 'enAI',
    'roDivisionError', 'bfCu', 'ebRTC', 'ebSocket', 'ebSocketIO',
}

# An English function word fused onto the end of a Spanish word, and the
# reverse. Both real cases seen while writing the sheets end this way, and the
# tail has to be a word the language does NOT spell that way itself -- `esta`,
# `las` and `the` are excluded because `respuesta` and `clausulas` are real
# words, while `...formathen` is not.
ENGLISH_TAIL = re.compile(r'(?:formathen|soakitchen|sometext|somethe|andthe)')
SPANISH_TAIL = re.compile(r'(?:laridad|lamente|seccion|cioness?|queda)')
# An English noun glued onto a Spanish word by an underscore, the way an
# untranslated variable name leaks into prose: `de_parameters`, `the_output`.
# Identifier names like `train_type` and `max_length` are legitimate, so the
# rule only fires when a SPANISH word sits on the left of the underscore,
# which no real identifier does.
UNDERSCORE_GLUE = re.compile(
    r'\b(?:de|el|la|los|las|un|una|y|o|que|con|por|para|sin)_[a-z]{4,}\b')

# A run of Han characters: a pasted fragment, not a word.
HAN_RUN = re.compile(r'[一-鿿]{2,}')
# Mixed script inside one token: a Latin letter glued to a Han one.
MIXED_SCRIPT = re.compile(r'[A-Za-z][一-鿿]|[一-鿿][A-Za-z]')
# An asterisk fused to a letter on BOTH sides (`paso*rinde`) is a typo. An
# asterisk with space around it is multiplication or a glob, and `**x**` is
# markdown bold, so neither is reported.
FUSED_ASTERISK = re.compile(r'[A-Za-zÁ-ÿ]\*[A-Za-zÁ-ÿ]')

CODE_SPAN = re.compile(r'`[^`]*`|```[\s\S]*?```|^\s{4,}\S.*$', re.MULTILINE)
# A reference that is a whole program rather than prose. Nothing in it is
# natural language, so the word checks do not apply at all -- Python keywords
# like `for` and `with` would otherwise read as English leakage.
PROGRAM = re.compile(r'^\s*(?:def |import |from |[A-Za-z_]\w*\s*=|print\()',
                     re.MULTILINE)
PROSE = ('objective', 'prompt', 'explanation', 'reference')


def strip_code(value):
    """Blank out code so a word search only sees running prose."""
    return CODE_SPAN.sub(lambda m: ' ' * len(m.group(0)), value)


def texts(lang):
    for path in sorted(glob.glob(os.path.join(EX, lang, '*.json'))):
        for item in json.load(open(path, encoding='utf-8')):
            for field in PROSE:
                value = item.get(field)
                if isinstance(value, str) and value:
                    yield os.path.basename(path), item['id'], field, value
            criteria = (item.get('llm_rubric') or {}).get('criteria')
            if criteria:
                yield os.path.basename(path), item['id'], 'criteria', criteria


def foreign_words(lang, value):
    """Words of the other language that appear in `lang` prose."""
    other = ENGLISH_WORDS if lang == 'es' else SPANISH_WORDS
    hits = []
    for word in WORD.findall(strip_code(value)):
        low = word.lower()
        if low in other and low not in SHARED:
            hits.append(word)
    return sorted(set(hits))


def main():
    problems = 0
    for lang in ('en', 'es'):
        for name, ident, field, value in texts(lang):
            where = f'{lang}/{name}:{ident}:{field}'
            snippet = re.sub(r'\s+', ' ', value)[:150]
            for kind, haystack, needle in (
                    ('CJK residue', value, CJK),
                    ('mojibake', value, MOJIBAKE),
                    ('CJK punctuation', value, CJK_PUNCT),
                    ('stray Han run', strip_code(value), HAN_RUN),
                    ('mixed script', value, MIXED_SCRIPT),
                    ('fused asterisk', strip_code(value), FUSED_ASTERISK),
                    ('intruder character', value, INTRUDER),
                    ('underscore glue', strip_code(value), UNDERSCORE_GLUE)):
                if needle.search(haystack):
                    problems += 1
                    print(f'  {kind:<20} {where}\n{"":<22}{snippet}')
            # A whole-program reference is exempt from the word checks: Python
            # keywords (`for`, `with`, `while`) would read as language leakage.
            if not (field == 'reference' and PROGRAM.search(value)):
                words = foreign_words(lang, value)
                if words:
                    problems += 1
                    print(f'  {"foreign words":<20} {where}\n{"":<22}'
                          f'{words[:12]}')
                glued = fused_words(lang, value)
                if glued:
                    problems += 1
                    print(f'  {"fused words":<20} {where}\n{"":<22}'
                          f'{glued[:12]}')
            broken = sorted({m.group(0) for m in
                             BROKEN_ESCAPE.finditer(value)})
            if broken:
                problems += 1
                print(f'  {"broken escape":<20} {where}\n{"":<22}{broken[:6]}')
            caps = sorted({m.group(0) for m in CAPS_GLUE.finditer(strip_code(value))}
                          - CAMEL_OK)
            if caps:
                problems += 1
                print(f'  {"caps glued":<20} {where}\n{"":<22}{caps[:8]}')
            if field == 'objective' and len(value) > 60:
                problems += 1
                print(f'  {"objective too long":<20} {where} ({len(value)})')
    print('PASS: no translation slips' if not problems
          else f'{problems} problems found')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())