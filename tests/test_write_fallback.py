"""写端点遇到 WAL 只读失效时降级为可重试的 503，而不是 500。"""
import base64
import json
import sqlite3
import time

import pytest
from fastapi.testclient import TestClient
from itsdangerous import TimestampSigner

from app import create_app

BASE = 'http://127.0.0.1:7860'
REAL_CONNECT = sqlite3.connect


@pytest.fixture
def site(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_BASE_URL', BASE)
    for name in ('OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET', 'DATABASE_URL',
                 'LOCAL_ADMIN_EMAIL', 'LOCAL_ADMIN_PASSWORD'):
        monkeypatch.delenv(name, raising=False)
    return create_app(tmp_path), tmp_path


def reader(site, uid='alice'):
    app, path = site
    with app.state.db() as db:
        db.execute('INSERT OR IGNORE INTO users(id,sub,name,role) VALUES (?,?,?,?)', (uid, 'sub-' + uid, uid, 'reader'))
        db.execute('INSERT OR REPLACE INTO sessions VALUES (?,?,?)', ('session-' + uid, uid, int(time.time()) + 1000))
    client = TestClient(app, base_url=BASE)
    payload = base64.b64encode(json.dumps({'sid': 'session-' + uid, 'csrf': 'test-csrf'}).encode())
    client.cookies.set('purplebook_session', TimestampSigner((path / 'session.key').read_text()).sign(payload).decode())
    client.headers.update({'origin': BASE, 'x-csrf-token': 'test-csrf'})
    return client


class ReadOnlyDatabase:
    """Fails writes the way a saturated WAL does, while reads keep working."""

    def __init__(self, path, *args, **kwargs):
        self._inner = REAL_CONNECT(path, *args, **kwargs)

    @property
    def row_factory(self):
        return self._inner.row_factory

    @row_factory.setter
    def row_factory(self, value):
        self._inner.row_factory = value

    def execute(self, statement, *rest):
        if statement.lstrip().upper().startswith(('BEGIN', 'INSERT', 'UPDATE', 'DELETE')):
            raise sqlite3.OperationalError('attempt to write a readonly database')
        return self._inner.execute(statement, *rest)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return self._inner.__exit__(*exc)

    def close(self):
        self._inner.close()


class LockedDatabase(ReadOnlyDatabase):
    """A different OperationalError, which must NOT be swallowed."""

    def execute(self, statement, *rest):
        if statement.lstrip().upper().startswith(('BEGIN', 'INSERT', 'UPDATE', 'DELETE')):
            raise sqlite3.OperationalError('database is locked')
        return self._inner.execute(statement, *rest)


def break_writes(site, monkeypatch, cls=ReadOnlyDatabase):
    monkeypatch.setattr('app.sqlite3.connect', lambda *a, **k: cls(*a, **k))


def test_entry_write_degrades_to_503(site, monkeypatch):
    client = reader(site)
    break_writes(site, monkeypatch)
    response = client.post('/api/chapters/chapter-1/entries',
                           json={'kind': 'comment', 'text': '占位内容'})
    assert response.status_code == 503
    assert response.json()['fallback'] is True
    assert response.headers['retry-after'] == '2'
    assert response.headers['x-sils-fallback'] == '1'


def test_wish_write_degrades_to_503(site, monkeypatch):
    client = reader(site)
    break_writes(site, monkeypatch)
    response = client.post('/api/wishes', json={'text': '希望补充评测章节'})
    assert response.status_code == 503
    assert response.json()['fallback'] is True


def test_progress_write_degrades_to_503(site, monkeypatch):
    client = reader(site)
    break_writes(site, monkeypatch)
    response = client.post('/api/exercises/progress', json={'items': [
        {'chapter': 'chapter-1', 'exercise': 'ch01-ex01', 'code': 'x', 'passed': True,
         'score': 1, 'attempts': 1, 'updated': int(time.time())}]})
    assert response.status_code == 503
    assert response.json()['fallback'] is True


def test_other_operational_error_is_not_swallowed(site, monkeypatch):
    client = reader(site)
    break_writes(site, monkeypatch, LockedDatabase)
    quiet = TestClient(site[0], base_url=BASE, raise_server_exceptions=False)
    quiet.cookies.set('purplebook_session', client.cookies['purplebook_session'])
    quiet.headers.update({'origin': BASE, 'x-csrf-token': 'test-csrf'})
    assert quiet.post('/api/wishes', json={'text': '锁冲突不该被降级'}).status_code == 500


def test_rate_limit_still_wins_over_fallback(site):
    client = reader(site)
    body = {'text': '频率测试'}
    codes = [client.post('/api/wishes', json=body).status_code for _ in range(6)]
    assert codes[:5] == [201] * 5
    assert codes[5] == 429
