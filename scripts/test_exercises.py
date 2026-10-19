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
# A `\uXXXX` escape left in the raw file text. The corpus stores these escaped
# on purpose inside code and quoted samples -- Python re-reads them at runtime,
# so they must survive. Latin-1 letters are never intentional: they are
# readable Spanish prose that a translator tool escaped by accident.
LITERAL_ESCAPE = re.compile(r'\\u([0-9a-fA-F]{4})')
# Hangul, Cyrillic and kana. No exercise in this book is written in those
# scripts, so an escape decoding to one is a stray fragment left by whatever
# tool produced the translation -- ch17-ex02 shipped a Korean 근거 where the
# Chinese said 主要依据. Outside CJK+ASCII, a translation field is a defect
# however it happens to be spelled.
FOREIGN_SCRIPT = re.compile(r'[Ѐ-ӿ가-힯぀-ヿ]')
# The fields a translation has to cover. `starter` and `checks` are code the
# grader runs and are byte-identical to zh by rule; `reference` is code on
# code/build exercises and prose on reflect/predict.
TRANSLATED_FIELDS = ('objective', 'prompt', 'explanation', 'reference')
# Quote pairs a translated field may use around a sample. `'` and `"` are
# listed after the typographic pairs so a Spanish «...» wins over a stray
# apostrophe.
QUOTE_PAIRS = (('“', '”'), ('«', '»'), ('`', '`'), ('"', '"'), ("'", "'"))
# What may sit inside a quoted sample besides the Chinese itself: the f-string
# placeholders and the punctuation of a code snippet. Any real word means the
# quote mixes translated prose with an untranslated fragment.
SAMPLE_SKELETON = re.compile(r'^[A-Za-z0-9_{}()\[\],.\-]*$')
# Latin-1 Supplement, minus the multiplication/division signs.
LATIN1 = {c for c in range(0xA0, 0x100)} - {0xD7, 0xF7}
REPLACEMENT_CHAR = '\ufffd'


def unescape(text):
    """Decode the literal `\\uXXXX` runs a reader sees in the raw file."""
    return LITERAL_ESCAPE.sub(lambda m: chr(int(m.group(1), 16)), text)


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
        # The self_assessed check is how a reflect exercise DECLARES that it has
        # nothing to grade. `checks: []` happens to behave identically -- the
        # grader reads graded.length === 0 and returns mode 'self-assessed' --
        # so the behaviour is not the argument. The argument is that it is a
        # shape no other exercise in the corpus uses, and it leaves a reader of
        # the data unable to tell an exercise that was deliberately not gradable
        # from one whose checks were lost in an edit: the empty array carries no
        # claim either way. One spelling, one meaning.
        assert checks, f'{where} reflect needs a self_assessed check'
        assert all(check.get('kind') == 'self_assessed' for check in checks), \
            f'{where} reflect checks must be self_assessed'
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
                # The starter is the code the learner starts from, and the rule
                # is that it is never translated: a translated starter would
                # rename the functions the checks call. Compare it byte for
                # byte rather than by shape.
                assert twin.get('starter') == item.get('starter'), \
                    f'{item["id"]} starter differs between zh and {lang}; ' \
                    'starter is code and must stay identical'
        seen |= zh
    # Compare the union of every chapter's ids against the total count, not
    # against one chapter: base_ids only holds the first zh chapter.
    total = sum(len(v) for (_, lang), v in corpus.items() if lang == 'zh')
    assert len(seen) == total, 'exercise ids repeat across chapters'
    check_untranslated_escapes(corpus)
    check_raw_text()
    return manifest, corpus


def check_untranslated_escapes(corpus):
    r"""Reject Chinese left sitting in an en/es sentence as a literal escape.

    A `\uXXXX` run is NOT the defect. Inside code or a quoted sample
    it is deliberate: the prompt tells the learner to type the Chinese literal
    and the grader compares the printed characters, so the escaped form is the
    lesson and decoding it would break grading (ch07-ex01, ch09-ex02).

    The defect is a Chinese WORD spliced into the translated sentence where no
    code sample was meant -- "Dos personas haciendo el mismo" followed by an
    escaped 动作. It slips past the CJK check in validate_item() precisely
    because the characters are still spelled as escapes, and it reaches the
    reader as literal text.

    A run is sample data, and so allowed, when either
      * the grader compares that exact string -- it occurs in `checks`,
        `starter`, or `reference` on a code/build exercise, the fields shared
        byte for byte with zh; or
      * it sits inside a quoted region that holds nothing but Chinese and
        code punctuation, and the same text occurs in the zh source of that
        field: a chapter example quoted whole, such as the two sample questions
        in ch12-ex02's explanation.
    Anything else is an untranslated fragment.

    Everything below works on the DECODED text. Reasoning about the escaped
    bytes is what made the first version of this check wrong: a closing quote
    can land inside an escape run, so every offset shifts and a half-run leaves
    a stray `\uff1` behind.
    """
    for (chapter_id, lang), items in sorted(corpus.items()):
        if lang == 'zh':
            continue
        zh_items = {item['id']: item for item in corpus[(chapter_id, 'zh')]}
        for item in items:
            where = f"{item.get('_file', '?')}:{item.get('id', '?')}"
            code_fields = unescape(json.dumps(
                [item.get('checks'), item.get('starter'),
                 item.get('reference') if item['type'] in SANDBOX_TYPES else None],
                ensure_ascii=False))
            zh_item = zh_items.get(item['id'], {})
            for key in TRANSLATED_FIELDS + ('criteria',):
                # `reference` is the reference answer: on code/build it is the
                # code the grader runs, shared with zh like starter and checks,
                # so its Chinese is sample data by definition. On reflect and
                # predict it is prose the translation has to cover.
                if key == 'reference' and item['type'] in SANDBOX_TYPES:
                    continue
                raw = translated_field(item, key)
                if not isinstance(raw, str):
                    continue
                zh_raw = translated_field(zh_item, key)
                zh_value = unescape(zh_raw) if isinstance(zh_raw, str) else ''
                text = unescape(raw)
                for run in cjk_runs(text):
                    decoded = run.group(0)
                    context = (f'{where} {key} at ...'
                               f'{text[max(0, run.start() - 40):run.end() + 40]}...')
                    # Hangul/Cyrillic/kana are not this book's script at all, so
                    # one here is a stray fragment whatever the field is.
                    assert not FOREIGN_SCRIPT.search(decoded), (
                        f'{context} holds the foreign-script fragment {decoded!r}; '
                        f'translate it into {lang}')
                    if decoded in code_fields:
                        continue  # sample data the grader compares
                    region = quoted_region(text, run.start())
                    if region is not None:
                        inner = text[region[0] + 1:region[1] - 1]
                        if (SAMPLE_SKELETON.match(CJK.sub('', inner))
                                and inner in zh_value):
                            continue  # a chapter example quoted whole
                    assert False, (
                        f'{context} holds the untranslated fragment {decoded!r}; '
                        f'translate it into {lang}')


def translated_field(item, key):
    """Read a translated field; `criteria` lives inside llm_rubric."""
    if key == 'criteria':
        return (item.get('llm_rubric') or {}).get('criteria')
    return item.get(key)


def cjk_runs(text):
    """Maximal runs of CJK (plus the CJK punctuation a sample carries).

    FOREIGN_SCRIPT is folded in so a Hangul/Cyrillic/kana fragment reaches the
    assertion in check_untranslated_escapes() instead of passing unnoticed --
    ch17-ex02 shipped a Korean 근거 in the Spanish rubric and nothing caught it.
    """
    return re.finditer(
        r'[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef'
        r'Ѐ-ӿ가-힯぀-ヿ]+', text)


def quoted_region(text, index):
    """The tightest quote pair enclosing `index`, as (start, end), else None.

    Scanned per pairing rather than across all of them: mixing them lets a
    stray apostrophe swallow the rest of the paragraph. Among the pairs that
    enclose `index` the shortest wins, so a sample inside a longer quotation
    still resolves to its own quotes.
    """
    best = None
    for opener, closer in QUOTE_PAIRS:
        pos = 0
        while True:
            start = text.find(opener, pos)
            if start < 0:
                break
            end = text.find(closer, start + 1)
            if end < 0:
                break
            if start < index < end and (best is None or end - start < best[1] - best[0]):
                best = (start, end)
            pos = end + 1
    return best


def check_raw_text():
    """Guard the bytes on disk, not just the parsed values.

    Two defects only show up here. A mojibake U+FFFD survives a JSON parse
    untouched, and an escaped Latin-1 letter parses back to a perfectly good
    `n` -- so the parsed view looks clean while the file on disk still reads
    `rese\\u00f1a` to anyone who opens it.
    """
    for lang in LANGUAGES:
        for path in sorted((EX / lang).glob('chapter-*.json')):
            raw = path.read_text(encoding='utf-8')
            where = f'{lang}/{path.name}'
            assert REPLACEMENT_CHAR not in raw, \
                f'{where} contains U+FFFD, so some character was already lost'
            for match in LITERAL_ESCAPE.finditer(raw):
                code = int(match.group(1), 16)
                assert code not in LATIN1, (
                    f'{where} escapes Latin-1 U+{code:04X} as \\u{match.group(1)}; '
                    'write the character directly so the file stays readable'
                )


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
