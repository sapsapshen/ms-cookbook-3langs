"""Exercise corpus validation. Runs standalone or under pytest."""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EX = ROOT / 'content' / 'exercises'
LANGUAGES = ['zh', 'en', 'es']

TYPES = {'code', 'predict', 'fill', 'build', 'reflect'}
SANDBOX_TYPES = {'code', 'build'}
CHECK_SPEC = {
    'assert_python': ('code',),
    'stdout_contains': ('value',),
    'stdout_equals': ('value',),
    'stdout_matches': ('pattern',),
    'var_equals': ('name', 'value'),
    'var_in_range': ('name', 'min', 'max'),
    'output_choice': ('correct',),
    'self_assessed': (),
}
CJK = re.compile(r'[一-鿿　-〿＀-￯]')


def book_chapters():
    data = json.loads((ROOT / 'content' / 'manifest.json').read_text(encoding='utf-8'))
    return {f"chapter-{c['number']}": c for c in data['chapters']}


def load_exercises():
    manifest = json.loads((EX / 'manifest.json').read_text(encoding='utf-8'))
    books = book_chapters()
    corpus = {}
    for entry in manifest['chapters']:
        chapter_id = entry['chapter']
        book = books[chapter_id]
        assert book['status'] == 'ready', f'{chapter_id} is pending and must be excluded'
        prefix = f"ch{book['number']:02d}"
        assert entry['idPrefix'] == prefix, f'{chapter_id} idPrefix must be {prefix}'
        for lang in LANGUAGES:
            path = EX / lang / f"chapter-{book['number']:02d}.json"
            assert path.exists(), f'missing {path.relative_to(ROOT)}'
            items = json.loads(path.read_text(encoding='utf-8'))
            assert isinstance(items, list) and items, f'{path.name} must be a non-empty array'
            for item in items:
                item['_file'] = f'{lang}/{path.name}'
                item['_chapter'] = chapter_id
                item['_number'] = book['number']
            corpus[(chapter_id, lang)] = items
    return manifest, corpus


def validate_item(item, lang):
    where = f"{item['_file']}:{item['id']}"
    for key in ('id', 'chapter', 'type', 'objective', 'prompt', 'explanation'):
        assert isinstance(item.get(key), str) and item[key].strip(), f'{where} missing {key}'
    assert item['chapter'] == item['_chapter'], f'{where} chapter mismatch'
    assert item['id'].startswith(f"ch{item['_number']:02d}-ex"), f'{where} id must be chNN-exNN'
    assert item['type'] in TYPES, f'{where} unknown type {item["type"]}'
    assert item['difficulty'] in (1, 2, 3), f'{where} difficulty must be 1-3'
    assert isinstance(item['minutes'], int) and 1 <= item['minutes'] <= 60, \
        f'{where} minutes out of range'
    assert len(item['objective']) <= 60, f'{where} objective too long'

    checks = item.get('checks') or []
    assert isinstance(checks, list), f'{where} checks must be an array'
    graded = [c for c in checks if c.get('kind') != 'self_assessed']
    for check in checks:
        kind = check.get('kind')
        assert kind in CHECK_SPEC, f'{where} unknown check kind {kind}'
        for field in CHECK_SPEC[kind]:
            assert field in check, f'{where} check {kind} missing {field}'
        assert isinstance(check.get('weight'), (int, float)) and check['weight'] >= 1, \
            f'{where} check {kind} weight must be a number >= 1'
        if kind == 'assert_python':
            compile(check['code'], '<check>', 'exec')
        if kind == 'stdout_matches':
            re.compile(check['pattern'])
        if kind == 'output_choice':
            assert isinstance(check['correct'], list) and check['correct'], \
                f'{where} output_choice.correct must be a non-empty array'

    if item['type'] == 'reflect':
        assert isinstance(item.get('reference'), str) and item['reference'].strip(), \
            f'{where} reflect needs a reference'
        assert not graded, f'{where} reflect must not carry graded checks'
    else:
        assert graded, f'{where} needs at least one graded check'
        if item['type'] in SANDBOX_TYPES:
            assert isinstance(item.get('starter'), str), f'{where} needs starter code'

    rubric = item.get('llm_rubric') or {}
    assert isinstance(rubric.get('enabled', False), bool), f'{where} llm_rubric.enabled must be bool'

    if lang in ('en', 'es'):
        for key in ('objective', 'prompt', 'explanation', 'reference'):
            value = item.get(key)
            if isinstance(value, str) and value:
                assert not CJK.search(value), f'{where} {key} still contains Chinese'


def run_checks():
    manifest, corpus = load_exercises()
    assert manifest['languages'] == LANGUAGES, 'manifest.languages must be zh,en,es'
    assert manifest['version'] == 1
    assert isinstance(manifest.get('packages'), list)
    base_ids = None
    for (chapter_id, lang), items in corpus.items():
        ids = [item['id'] for item in items]
        assert len(set(ids)) == len(ids), f'{chapter_id}/{lang} has duplicate ids'
        for item in items:
            validate_item(item, lang)
        if lang == 'zh' and base_ids is None:
            base_ids = (chapter_id, set(ids))
    assert base_ids is not None, 'no zh exercises found'
    assert base_ids[1], 'at least one zh exercise required'
    seen = set()
    for chapter_id, _ in corpus:
        zh = {item['id'] for item in corpus[(chapter_id, 'zh')]}
        for lang in ('en', 'es'):
            other = {item['id'] for item in corpus[(chapter_id, lang)]}
            assert zh == other, f'{chapter_id}/{lang} id set diverges: {sorted(zh ^ other)}'
        seen |= zh
    # Compare the union of every chapter's ids against the total count, not
    # against one chapter: base_ids only holds the first zh chapter.
    total = sum(len(v) for (_, lang), v in corpus.items() if lang == 'zh')
    assert len(seen) == total, 'exercise ids repeat across chapters'
    return manifest, corpus


def test_corpus_valid():
    manifest, corpus = run_checks()
    total = sum(len(v) for (c, lang), v in corpus.items() if lang == 'zh')
    assert total >= 1


if __name__ == '__main__':
    try:
        manifest, corpus = run_checks()
    except AssertionError as error:
        print(f'FAIL: {error}', file=sys.stderr)
        sys.exit(1)
    total = sum(len(v) for (c, lang), v in corpus.items() if lang == 'zh')
    print(f'PASS: {total} exercises across {len({c for c, _ in corpus})} chapters, {len(LANGUAGES)} languages')