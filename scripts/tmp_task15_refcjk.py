"""References whose CODE carries CJK string literals (task-15 temp tool).

`test_exercises.py` forbids CJK in the en/es `reference`, and
`check_exercise_references.py` EXECUTES every code/build reference. So a
reference that embeds a Chinese data literal has two possible en/es forms:

  keep      the Chinese -> validator rejects the file
  escape    \\uXXXX      -> identical behaviour, CJK-free source, still 100%

This lists every code/build reference that needs the escape form, so the
decision is per-item rather than guessed.
"""
import glob
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CJK = re.compile(r'[一-鿿　-〿＀-￯]')
CODE_TYPES = {'code', 'build'}
# A line is code when the whole reference is a program: it contains a def, an
# import, or the starter-style trailing print/assign block.
STRING = re.compile(r"'[^'\n]*[\u4e00-\u9fff][^'\n]*'|\"[^\"\n]*[\u4e00-\u9fff][^\"\n]*\"")


def main():
    escaped = kept = 0
    rows = []
    for path in sorted(glob.glob(os.path.join(ROOT, 'content', 'exercises', 'zh', '*.json'))):
        name = os.path.basename(path)
        for item in json.load(open(path, encoding='utf-8')):
            if item['type'] not in CODE_TYPES:
                continue
            ref = item.get('reference') or ''
            if not CJK.search(ref):
                continue
            looks_like_code = bool(re.search(r'^\s*(def |import |from |print\(|[a-z_]+\s*=)', ref, re.M))
            lits = STRING.findall(ref)
            rows.append((name, item['id'], looks_like_code, lits))
    print(f'{len(rows)} code/build references carry CJK\n')
    for name, ident, code, lits in rows:
        if not code:
            print(f'--- {name}:{ident}  PROSE (translate, no escape needed)')
            continue
        print(f'--- {name}:{ident}  CODE ({len(lits)} CJK literal(s)) -> escape as \\uXXXX')
        for lit in lits[:6]:
            print(f'      {lit}')
        escaped += 1
    print(f'\nprose references: {len(rows) - escaped}, code references needing escapes: {escaped}')


if __name__ == '__main__':
    main()