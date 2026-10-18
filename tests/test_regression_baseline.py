"""Baseline invariants: the reading community must keep working untouched."""
import json
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent


def book_data():
    raw = (ROOT / 'assets' / 'content.js').read_text(encoding='utf-8')
    return json.loads(raw.split('=', 1)[1].strip().rstrip(';'))


def test_chapter_payload_shape_unchanged():
    data = book_data()
    assert data['chapterCount'] == 35
    for chapter in data['chapters']:
        for key in ('id', 'number', 'title', 'sourceUrl', 'editUrl', 'minutes',
                    'status', 'headings', 'html', 'imageCount', 'attachmentCount',
                    'discussionId'):
            assert key in chapter, f'{chapter.get("id")} lost {key}'
        assert not chapter['html'].lower().count('<script')


def test_i18n_editions_still_complete():
    chapter_ids = [chapter['id'] for chapter in book_data()['chapters']]
    for code in ('en', 'es'):
        raw = (ROOT / 'assets' / 'content-i18n' / f'{code}.js').read_text(encoding='utf-8')
        assert f'window.MS_ARTICLE.{code}' in raw, f'{code} edition lost or mismatched its global'
        for chapter_id in chapter_ids:
            assert f'"{chapter_id}"' in raw, f'{code} edition lost {chapter_id}'
        assert len(raw) > 100_000, f'{code} edition looks truncated'


@pytest.fixture
def site(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_BASE_URL', 'http://127.0.0.1:7860')
    monkeypatch.delenv('OAUTH_CLIENT_ID', raising=False)
    monkeypatch.delenv('OAUTH_CLIENT_SECRET', raising=False)
    from app import create_app
    return create_app(tmp_path), tmp_path


def test_existing_endpoints_untouched(site):
    client = TestClient(site[0])
    assert client.get('/').status_code == 200
    assert client.get('/api/session').status_code == 200
    assert client.get('/api/analytics/summary').status_code == 200
    assert client.get('/api/chapters/chapter-1/entries').status_code == 200
    assert client.get('/api/chapters/chapter-24/entries').status_code == 404
    assert client.get('/api/wishes').status_code == 200


def test_locale_key_parity():
    def keys(path):
        import re
        return set(re.findall(r"^\s*'([^']+)':", path.read_text(encoding='utf-8'), re.M))
    base = ROOT / 'assets' / 'locale'
    zh = keys(base / 'zh.js')
    # Floor on the match count: if the quote style ever changes, every file
    # would return an empty set and the parity check would pass vacuously.
    assert len(zh) > 100, f'locale key regex matched only {len(zh)} keys -- parser is broken'
    for code in ('en', 'es'):
        other = keys(base / f'{code}.js')
        assert other == zh, f'{code}.js key set diverges: {sorted(zh ^ other)[:10]}'
