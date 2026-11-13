"""传输层：压缩按路径选择、版本化资源长缓存、webp 的 MIME。"""
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import create_app

BASE = 'http://127.0.0.1:7860'


@pytest.fixture
def site(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_BASE_URL', BASE)
    for name in ('OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET', 'DATABASE_URL',
                 'LOCAL_ADMIN_EMAIL', 'LOCAL_ADMIN_PASSWORD'):
        monkeypatch.delenv(name, raising=False)
    return create_app(tmp_path)


def client(site):
    return TestClient(site, base_url=BASE)


def first_webp():
    folder = Path(__file__).resolve().parent.parent / 'assets' / 'manuscript-20260914'
    return sorted(folder.glob('*.webp'))[0].name


def test_javascript_is_gzipped(site):
    response = client(site).get('/assets/paper.js', headers={'Accept-Encoding': 'gzip'})
    assert response.headers['content-encoding'] == 'gzip'


def test_gzip_payload_round_trips(site):
    # httpx transparently decodes, so a gzip response that still parses as the
    # real script is the proof the encoder did not corrupt the body.
    gzipped = client(site).get('/assets/content.js', headers={'Accept-Encoding': 'gzip'})
    assert gzipped.headers['content-encoding'] == 'gzip'
    assert gzipped.content[:14] == b'window.BOOK_DA'
    raw = client(site).get('/assets/content.js', headers={'Accept-Encoding': 'identity'}).content
    assert gzipped.content == raw


def test_small_response_is_not_gzipped(site):
    # minimum_size=1024: compressing a few hundred bytes costs more than it saves.
    response = client(site).get('/favicon.svg', headers={'Accept-Encoding': 'gzip'})
    assert 'content-encoding' not in response.headers


def test_binary_asset_is_not_gzipped(site):
    response = client(site).get('/assets/manuscript-20260914/' + first_webp(),
                                headers={'Accept-Encoding': 'gzip'})
    assert 'content-encoding' not in response.headers
    assert response.headers['content-type'] == 'image/webp'


def test_wasm_is_not_gzipped(site):
    response = client(site).get('/assets/vendor/pyodide/pyodide.asm.wasm',
                                headers={'Accept-Encoding': 'gzip'})
    assert 'content-encoding' not in response.headers


def test_versioned_asset_is_immutable(site):
    response = client(site).get('/assets/paper.js?v=0123456789ab')
    assert response.headers['cache-control'] == 'public, max-age=31536000, immutable'


def test_unversioned_asset_must_revalidate(site):
    # Without a content hash the URL is reused across deploys, so the answer has
    # to be re-checked every time rather than guessed from Last-Modified.
    response = client(site).get('/assets/paper.js')
    assert response.headers['cache-control'] == 'public, max-age=0, must-revalidate'


def test_index_outranks_the_version_query(site):
    # A stray ?v= in a shared link must not pin the HTML shell for a year.
    response = client(site).get('/?v=0123456789ab')
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-cache'


def test_analytics_page_outranks_the_version_query(site):
    response = client(site).get('/analytics?v=0123456789ab')
    assert response.status_code == 200
    assert response.headers['cache-control'] == 'no-store'


def test_short_cache_path_outranks_the_version_query(site):
    # spec 3.1 names these paths for the short policy; ?v= must not promote them.
    response = client(site).get('/favicon.svg?v=0123456789ab')
    assert response.headers['cache-control'] == 'public, max-age=300, must-revalidate'


def test_error_response_is_not_immutable(site):
    # The ?v= branch must not hand a year of freshness to a 404.
    response = client(site).get('/assets/no-such-file.js?v=0123456789ab')
    assert response.status_code == 404
    assert 'immutable' not in response.headers.get('cache-control', '')


def test_short_cache_paths(site):
    response = client(site).get('/favicon.svg')
    assert response.headers['cache-control'] == 'public, max-age=300, must-revalidate'


def test_api_still_no_store(site):
    assert client(site).get('/api/session').headers['cache-control'] == 'no-store'


def test_error_response_under_auth_still_no_store(site):
    # The no-store branch sits outside the 2xx guard on purpose: a 503 from
    # /auth/login must not become cacheable just because it failed.
    response = client(site).get('/auth/login')
    assert response.status_code == 503
    assert response.headers['cache-control'] == 'no-store'


def test_index_still_no_cache(site):
    assert client(site).get('/').headers['cache-control'] == 'no-cache'


def test_responses_carry_baseline_security_headers(site):
    page = client(site).get('/')
    api = client(site).get('/api/session')
    for response in (page, api):
        assert response.headers['x-content-type-options'] == 'nosniff'
        assert response.headers['referrer-policy'] == 'strict-origin-when-cross-origin'
        assert response.headers['permissions-policy'] == 'camera=(), microphone=(), geolocation=(), payment=()'
