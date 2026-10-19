"""Audit language-dependent `checks[].value` / `checks[].pattern` in zh (task-15 temp tool)."""
import json
import glob
import os
import re

CJK = re.compile(r'[一-鿿　-〿＀-￯]')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    total_checks = 0
    text_value = 0        # value/pattern carrying CJK -> must translate
    numeric_value = 0
    ascii_value = 0       # language-neutral string -> keep
    detail = []
    for path in sorted(glob.glob(os.path.join(ROOT, 'content', 'exercises', 'zh', '*.json'))):
        ch = os.path.basename(path)
        items = json.load(open(path, encoding='utf-8'))
        for it in items:
            for i, c in enumerate(it.get('checks') or []):
                for f in ('value', 'pattern'):
                    if f not in c:
                        continue
                    total_checks += 1
                    v = c[f]
                    if not isinstance(v, str):
                        numeric_value += 1
                        continue
                    if CJK.search(v):
                        text_value += 1
                        detail.append((ch, it['id'], i, c['kind'], f, v))
                    else:
                        ascii_value += 1
    print(f'total value/pattern fields : {total_checks}')
    print(f'  non-string (numeric)     : {numeric_value}  (language-neutral)')
    print(f'  string without CJK       : {ascii_value}  (language-neutral)')
    print(f'  string with CJK          : {text_value}  (NEEDS TRANSLATION)')
    print()
    print('=== per-item detail of CJK-bearing value/pattern ===')
    for d in detail:
        print(f'{d[0]} {d[1]} checks[{d[2]}] {d[3]}.{d[4]} = {d[5]!r}')


if __name__ == '__main__':
    main()