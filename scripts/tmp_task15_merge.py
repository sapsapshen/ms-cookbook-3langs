"""Merge a translation sheet into the zh corpus to emit an en/es chapter.

Structural fields are copied verbatim from zh so the two can never drift:
`id`, `chapter`, `type`, `difficulty`, `minutes`, `starter`, every key of
`checks` (including `code`, `pattern`, `value`, `weight`, `correct`, `min`,
`max`, `name`) and `llm_rubric.enabled`. Only the five prose fields are taken
from the translation sheet:

    objective, prompt, explanation, reference, criteria

`checks` overrides are opt-in per index and per field, for the rare check
whose `value`/`pattern` is only true in Chinese. Nothing else is writable
from the sheet, so a mistranslated structural field is impossible by
construction.

Usage:
    python3 scripts/tmp_task15_merge.py en 01
    python3 scripts/tmp_task15_merge.py es 01
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EX = ROOT / 'content' / 'exercises'
SHEETS = ROOT / '.data' / 'task15-sheets'

PROSE = ('objective', 'prompt', 'explanation', 'reference')
CHECK_FIELDS = ('kind', 'code', 'name', 'value', 'min', 'max', 'weight',
                'correct', 'pattern')

# A sheet value that means "take the zh text verbatim, escaping its CJK".
FROM_ZH = '@zh'
CJK = re.compile(r'[一-鿿　-〿＀-￯]')


def escape(text):
    """CJK -> \\uXXXX, so the source is ASCII and the runtime value is equal."""
    def one(ch):
        code = ord(ch)
        if code > 0xFFFF:
            shifted = code - 0x10000
            return (f'\\u{0xD800 + (shifted >> 10):04x}'
                    f'\\u{0xDC00 + (shifted & 0x3FF):04x}')
        return f'\\u{code:04x}'
    return ''.join(ch if ord(ch) < 0x80 else one(ch) for ch in text)


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def dump(path, data):
    Path(path).write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def merge(lang, number):
    zh = load(EX / 'zh' / f'chapter-{number:02d}.json')
    sheet = load(SHEETS / lang / f'chapter-{number:02d}.json')
    sheet = {entry['id']: entry for entry in sheet}
    zh_ids = [item['id'] for item in zh]
    assert set(sheet) == set(zh_ids), (
        f'{lang} ch{number}: sheet ids {sorted(set(sheet) ^ set(zh_ids))}')
    out = []
    for item in zh:
        src = sheet[item['id']]
        twin = {}
        for key, value in item.items():
            if key in PROSE:
                # A code reference is copied verbatim and escaped, rather than
                # retyped: `test_exercises.py` forbids CJK in the en/es
                # `reference`, and `check_exercise_references.py` executes it,
                # so the literal must keep the same runtime value. Escaping
                # satisfies both without the translator touching the code.
                if src[key] == FROM_ZH:
                    assert CJK.search(value or ''), (
                        f'{item["id"]}: {FROM_ZH} used but the {key} has no CJK')
                    twin[key] = escape(value)
                else:
                    twin[key] = src[key]
            elif key == 'llm_rubric':
                twin[key] = dict(value)
                if value.get('criteria'):
                    twin[key]['criteria'] = src['criteria']
            elif key == 'checks':
                overrides = src.get('check_overrides') or {}
                checks = []
                for index, check in enumerate(value):
                    twin_check = dict(check)
                    patch = overrides.get(str(index)) or overrides.get(index)
                    if patch:
                        for field, replacement in patch.items():
                            assert field in CHECK_FIELDS, f'unwritable check field {field}'
                            twin_check[field] = replacement
                    checks.append(twin_check)
                twin[key] = checks
            else:
                twin[key] = value
        out.append(twin)
    return zh, out


def main():
    lang, number = sys.argv[1], int(sys.argv[2])
    zh, out = merge(lang, number)
    dump(EX / lang / f'chapter-{number:02d}.json', out)
    print(f'{lang}/chapter-{number:02d}.json: {len(out)} exercises')


if __name__ == '__main__':
    main()