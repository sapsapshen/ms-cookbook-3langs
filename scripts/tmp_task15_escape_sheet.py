"""Escape CJK inside an already-written sheet, in place (task-15 temp tool).

Writing a Chinese example sentence into a sheet by hand tends to leave the raw
characters in the JSON even after the prose around them is translated, and
`test_exercises.py` rejects any CJK in the en/es fields. This rewrites the CJK
characters of the sheet's string values as backslash-u escapes, which keeps the
JSON valid and the runtime text identical.

Only CJK is escaped. Accented Latin stays as-is: the corpus is UTF-8 and
`ensure_ascii=False` already writes `á` literally, so escaping Spanish
accents would only make the repository unreadable for no benefit.

Usage:
    python3 scripts/tmp_task15_escape_sheet.py .data/task15-sheets/en/chapter-10.json
"""
import json
import re
import sys
from pathlib import Path

CJK = re.compile(r'[⺀-鿿豈-﫿＀-￯]')


def escape_char(ch):
    code = ord(ch)
    if code > 0xFFFF:
        shifted = code - 0x10000
        return (f'\\u{0xD800 + (shifted >> 10):04x}'
                f'\\u{0xDC00 + (shifted & 0x3FF):04x}')
    return f'\\u{code:04x}'


def main():
    path = Path(sys.argv[1])
    data = json.loads(path.read_text(encoding='utf-8'))
    changed = 0

    def walk(node):
        nonlocal changed
        if isinstance(node, dict):
            for key, value in node.items():
                if isinstance(value, str) and CJK.search(value):
                    node[key] = CJK.sub(lambda m: escape_char(m.group(0)), value)
                    changed += 1
                elif not isinstance(value, str):
                    walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)

    walk(data)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n',
                     encoding='utf-8')
    print(f'{path}: escaped {changed} field(s)')


if __name__ == '__main__':
    main()