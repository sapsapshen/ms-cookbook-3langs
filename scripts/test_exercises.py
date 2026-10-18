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
    assert isinstance(manifest.get('chapters'), list) and manifest['chapters'], \
        'manifest.chapters must be a non-empty array'
    corpus = {}
    for entry in manifest['chapters']:
        assert isinstance(entry, dict), 'manifest chapter entry must be an object'
        chapter_id = entry.get('chapter')
        assert isinstance(chapter_id, str) and chapter_id, 'manifest chapter entry missing chapter'
        assert chapter_id in books, f'{chapter_id} is not a chapter in content/manifest.json'
        book = books[chapter_id]
        assert book.get('status') == 'ready', f'{chapter_id} is pending and must be excluded'
        assert isinstance(book.get('number'), int), f'{chapter_id} has no chapter number'
        prefix = f"ch{book['number']:02d}"
        assert entry.get('idPrefix') == prefix, f'{chapter_id} idPrefix must be {prefix}'
        for lang in LANGUAGES:
            path = EX / lang / f"chapter-{book['number']:02d}.json"
            assert path.exists(), f'missing {path.relative_to(ROOT)}'
            items = json.loads(path.read_text(encoding='utf-8'))
            assert isinstance(items, list) and items, f'{path.name} must be a non-empty array'
            for index, item in enumerate(items):
                assert isinstance(item, dict), \
                    f'{lang}/{path.name}[{index}] must be an object'
                item['_file'] = f'{lang}/{path.name}'
                item['_chapter'] = chapter_id
                item['_number'] = book['number']
            corpus[(chapter_id, lang)] = items
    return manifest, corpus


def validate_item(item, lang):
    where = f"{item.get('_file', '?')}:{item.get('id', '?')}"
    for key in ('id', 'chapter', 'type', 'objective', 'prompt', 'explanation'):
        assert isinstance(item.get(key), str) and item[key].strip(), f'{where} missing {key}'
    assert 'difficulty' in item, f'{where} missing difficulty'
    assert 'minutes' in item, f'{where} missing minutes'
    assert item['chapter'] == item['_chapter'], f'{where} chapter mismatch'
    assert item['id'].startswith(f"ch{item['_number']:02d}-ex"), f'{where} id must be chNN-exNN'
    assert item['type'] in TYPES, f'{where} unknown type {item["type"]}'
    assert item['difficulty'] in (1, 2, 3), f'{where} difficulty must be 1-3'
    assert isinstance(item['minutes'], int) and 1 <= item['minutes'] <= 60, \
        f'{where} minutes out of range'
    assert len(item['objective']) <= 60, f'{where} objective too long'

    checks = item.get('checks')
    assert checks is None or isinstance(checks, list), f'{where} checks must be an array'
    checks = checks or []
    graded = []
    for check in checks:
        assert isinstance(check, dict), f'{where} check must be an object'
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
        if kind != 'self_assessed':
            graded.append(check)

    if item['type'] == 'reflect':
        assert isinstance(item.get('reference'), str) and item['reference'].strip(), \
            f'{where} reflect needs a reference'
        assert not graded, f'{where} reflect must not carry graded checks'
    else:
        assert graded, f'{where} needs at least one graded check'
        if item['type'] in SANDBOX_TYPES:
            assert isinstance(item.get('starter'), str), f'{where} needs starter code'

    rubric = item.get('llm_rubric')
    assert rubric is None or isinstance(rubric, dict), f'{where} llm_rubric must be an object'
    rubric = rubric or {}
    assert isinstance(rubric.get('enabled', False), bool), f'{where} llm_rubric.enabled must be bool'

    if lang in ('en', 'es'):
        for key in ('objective', 'prompt', 'explanation', 'reference'):
            value = item.get(key)
            if isinstance(value, str) and value:
                assert not CJK.search(value), f'{where} {key} still contains Chinese'


def run_checks():
    manifest, corpus = load_exercises()
    assert manifest.get('languages') == LANGUAGES, 'manifest.languages must be zh,en,es'
    assert manifest.get('version') == 1, 'manifest.version must be 1'
    assert isinstance(manifest.get('packages'), list), 'manifest.packages must be an array'
    base_ids = None
    for (chapter_id, lang), items in corpus.items():
        for item in items:
            validate_item(item, lang)
        ids = [item['id'] for item in items]
        assert len(set(ids)) == len(ids), f'{chapter_id}/{lang} has duplicate ids'
        if lang == 'zh' and base_ids is None:
            base_ids = (chapter_id, set(ids))
    assert base_ids is not None, 'no zh exercises found'
    assert base_ids[1], 'at least one zh exercise required'
    seen = set()
    for chapter_id, _ in corpus:
        zh_items = {item['id']: item for item in corpus[(chapter_id, 'zh')]}
        zh = set(zh_items)
        for lang in ('en', 'es'):
            other = {item['id']: item for item in corpus[(chapter_id, lang)]}
            assert zh == set(other), \
                f'{chapter_id}/{lang} id set diverges: {sorted(zh ^ set(other))}'
            # The frontend dispatches on exercise.type, so a translated twin that
            # disagrees on type or difficulty renders the wrong interaction.
            for item in corpus[(chapter_id, 'zh')]:
                twin = other[item['id']]
                assert twin['type'] == item['type'], \
                    f'{item["id"]} type differs between zh and {lang}: ' \
                    f'{item["type"]} vs {twin["type"]}'
                assert twin['difficulty'] == item['difficulty'], \
                    f'{item["id"]} difficulty differs between zh and {lang}: ' \
                    f'{item["difficulty"]} vs {twin["difficulty"]}'
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