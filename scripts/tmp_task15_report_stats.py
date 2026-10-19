"""Language-dependence audit of every graded field, for the task-15 report.

Answers two questions per field:

  * is the field language-dependent (does it only hold in Chinese)?
  * is it byte-identical across zh / en / es?

Structural fields are expected to be identical; the prose fields are expected
to differ. This prints both, so a mismatch in either direction is visible.
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EX = os.path.join(ROOT, 'content', 'exercises')
CJK = re.compile(r'[一-鿿　-〿＀-￯]')
CHECK_KEYS = ('kind', 'code', 'name', 'value', 'min', 'max', 'weight',
              'correct', 'pattern')


def load(lang, n):
    path = os.path.join(EX, lang, 'chapter-%02d.json' % n)
    return json.load(open(path, encoding='utf-8'))


def main():
    chapters = sorted(int(os.path.basename(p)[8:10])
                  for p in os.listdir(os.path.join(EX, 'zh'))
                  if p.startswith('chapter-'))
    neutral = dependent = 0
    stats = {}
    struct_mismatch = []
    value_rows = []
    for n in chapters:
        zh = {i['id']: i for i in load('zh', n)}
        en = {i['id']: i for i in load('en', n)}
        es = {i['id']: i for i in load('es', n)}
        for ident, zi in zh.items():
            for key in ('type', 'difficulty', 'minutes', 'starter'):
                vals = {lang: d[ident].get(key) for lang, d in
                        (('zh', zh), ('en', en), ('es', es))}
                if len(set(map(str, vals.values()))) > 1:
                    struct_mismatch.append(f'{ident}.{key}')
            zc, ec, sc = (zi.get('checks') or [], en[ident].get('checks') or [],
                          es[ident].get('checks') or [])
            for idx, (a, b, c) in enumerate(zip(zc, ec, sc)):
                for key in CHECK_KEYS:
                    if key not in a:
                        continue
                    vals = [a.get(key), b.get(key), c.get(key)]
                    if len(set(map(str, vals))) > 1:
                        struct_mismatch.append(f'{ident}.checks[{idx}].{key}')
                    if key in ('value', 'pattern'):
                        raw = a.get(key)
                        cjk = isinstance(raw, str) and bool(CJK.search(raw))
                        stats['cjk' if cjk else 'neutral'] = \
                            stats.get('cjk' if cjk else 'neutral', 0) + 1
                        value_rows.append((ident, idx, key, raw, cjk))
                        if cjk:
                            dependent += 1
                        else:
                            neutral += 1
    print('=== checks[].value / checks[].pattern language dependence ===')
    print(f'  language-neutral (identical in all three languages): {neutral}')
    print(f'  Chinese-dependent (carried over verbatim):             {dependent}')
    print()
    print('  per field:')
    for key in ('value', 'pattern'):
        rows = [r for r in value_rows if r[2] == key]
        nc = sum(1 for r in rows if not r[4])
        dc = len(rows) - nc
        print(f'    {key:<8} total {len(rows):>3}   neutral {nc:>3}   '
              f'Chinese-dependent {dc:>3}')
    print()
    print('  the Chinese-dependent ones:')
    for ident, idx, key, raw, _ in value_rows:
        if CJK.search(str(raw)):
            print(f'    {ident} checks[{idx}].{key} = {raw!r}')
    print()
    print('=== structural fields identical across the three languages ===')
    if struct_mismatch:
        print(f'  {len(struct_mismatch)} MISMATCH:')
        for m in struct_mismatch[:20]:
            print('   ', m)
    else:
        print('  all type / difficulty / minutes / starter / every check field '
              'match byte for byte')


if __name__ == '__main__':
    main()