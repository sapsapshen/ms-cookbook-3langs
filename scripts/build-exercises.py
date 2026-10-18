"""Build EXERCISE_DATA from the reviewable exercise corpus.

Usage: python3 scripts/build-exercises.py
       python3 scripts/build-exercises.py --check
Validation lives in scripts/test_exercises.py and is reused here so the build
can never emit data the corpus validator rejects.
"""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_exercises import ROOT, run_checks, book_chapters

OUTPUT = ROOT / 'assets' / 'exercises.js'


def build(check=False):
    try:
        _emit(check)
    except AssertionError as error:
        raise SystemExit(f'FAIL: {error}')


def _emit(check=False):
    manifest, corpus = run_checks()
    books = book_chapters()
    chapters = {}
    for entry in manifest['chapters']:
        chapter_id = entry['chapter']
        book = books[chapter_id]
        exercises = {}
        for lang in manifest['languages']:
            exercises[lang] = [
                {k: v for k, v in item.items() if not k.startswith('_')}
                for item in corpus[(chapter_id, lang)]
            ]
        counts = {lang: len(items) for lang, items in exercises.items()}
        assert len(set(counts.values())) == 1, f'{chapter_id} language counts diverge: {counts}'
        minutes = sum(int(item['minutes']) for item in exercises['zh'])
        chapters[chapter_id] = {
            'chapter': chapter_id,
            'number': book['number'],
            'partIndex': book['partIndex'],
            'count': counts['zh'],
            'minutes': minutes,
            'exercises': exercises,
        }
    payload = {
        'title': manifest['title'],
        'version': manifest['version'],
        'languages': manifest['languages'],
        'packages': manifest.get('packages', []),
        'exerciseCount': sum(c['count'] for c in chapters.values()),
        'chapters': chapters,
    }
    output = 'window.EXERCISE_DATA = ' + json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + ';\n'
    if check:
        if not OUTPUT.exists() or OUTPUT.read_text(encoding='utf-8') != output:
            raise SystemExit('assets/exercises.js is out of date. Run python3 scripts/build-exercises.py.')
        print(f'Verified {payload["exerciseCount"]} exercises across {len(chapters)} chapters')
        return
    OUTPUT.write_text(output, encoding='utf-8')
    print(f'Built {payload["exerciseCount"]} exercises across {len(chapters)} chapters')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true', help='Validate without writing')
    build(check=parser.parse_args().check)
