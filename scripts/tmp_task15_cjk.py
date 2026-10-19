"""Audit CJK dependence in the zh exercise corpus (temporary task-15 tool)."""
import json
import glob
import os
import re

CJK = re.compile(r'[一-鿿　-〿＀-￯]')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    rows = []
    for path in sorted(glob.glob(os.path.join(ROOT, 'content', 'exercises', 'zh', '*.json'))):
        ch = os.path.basename(path)
        items = json.load(open(path, encoding='utf-8'))
        for it in items:
            where = f"{ch}:{it['id']}"
            for field in ('objective', 'prompt', 'explanation', 'reference'):
                v = it.get(field)
                if isinstance(v, str) and CJK.search(v):
                    rows.append(('TEXT', where, field, 'translate'))
            st = it.get('starter')
            if isinstance(st, str) and CJK.search(st):
                rows.append(('STARTER-CJK', where, 'starter', 'keep verbatim'))
            for i, c in enumerate(it.get('checks') or []):
                for f in ('code', 'pattern', 'value', 'name'):
                    v = c.get(f)
                    if isinstance(v, str) and CJK.search(v):
                        rows.append(('CHECK-CJK', where, f"checks[{i}].{c['kind']}.{f}",
                                     repr(v)[:90]))
                if 'value' in c and not isinstance(c['value'], str):
                    rows.append(('VALUE-NUM', where, f"checks[{i}].{c['kind']}.value",
                                 repr(c['value'])[:60]))
            rub = it.get('llm_rubric') or {}
            cr = rub.get('criteria')
            if isinstance(cr, str) and cr and CJK.search(cr):
                rows.append(('RUBRIC', where, 'llm_rubric.criteria', 'translate'))
    kinds = {}
    for r in rows:
        kinds[r[0]] = kinds.get(r[0], 0) + 1
    print('=== summary ===')
    for k, v in sorted(kinds.items()):
        print(f'{k}: {v}')
    print()
    print('=== CHECK-CJK detail (must decide translate vs keep) ===')
    for r in rows:
        if r[0] in ('CHECK-CJK', 'STARTER-CJK', 'VALUE-NUM'):
            print(' | '.join(str(x) for x in r))


if __name__ == '__main__':
    main()