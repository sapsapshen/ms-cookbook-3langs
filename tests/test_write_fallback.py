"""写端点遇到 WAL 只读失效时降级为可重试的 503，而不是 500。

The fake below is the whole point of this file: a real read-only SQLite
connection SUCCEEDS at `BEGIN IMMEDIATE` and only fails when the write
statement itself runs. A fake that raised at `BEGIN` would certify a failure
point production never reaches, and an implementation that wrapped only the
`BEGIN` line would pass every test here while still returning 500 in
production -- so the fake fails on INSERT/UPDATE/DELETE and lets BEGIN through.
"""
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
# Real, open corpus ids; a bogus chapter/exercise is silently skipped rather
# than written, which would hide the very code path these tests target.
CHAPTER = 'chapter-1'
EXERCISES = ('ch01-ex01', 'ch01-ex02')


@pytest.fixture
def site(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_BASE_URL', BASE)
    for name in ('OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET', 'DATABASE_URL',
                 'LOCAL_ADMIN_EMAIL', 'LOCAL_ADMIN_PASSWORD'):
        monkeypatch.delenv(name, raising=False)
    return create_app(tmp_path), tmp_path


def reader(site, uid='alice', raise_server_exceptions=True):
    app, path = site
    with app.state.db() as db:
        db.execute('INSERT OR IGNORE INTO users(id,sub,name,role) VALUES (?,?,?,?)', (uid, 'sub-' + uid, uid, 'reader'))
        db.execute('INSERT OR REPLACE INTO sessions VALUES (?,?,?)', ('session-' + uid, uid, int(time.time()) + 1000))
    client = TestClient(app, base_url=BASE, raise_server_exceptions=raise_server_exceptions)
    payload = base64.b64encode(json.dumps({'sid': 'session-' + uid, 'csrf': 'test-csrf'}).encode())
    client.cookies.set('purplebook_session', TimestampSigner((path / 'session.key').read_text()).sign(payload).decode())
    client.headers.update({'origin': BASE, 'x-csrf-token': 'test-csrf'})
    return client


def stored_rows(site, table):
    """Read the on-disk table with an untouched connection.

    Used to prove a failed batch rolled back rather than partially committed:
    the fake's inner connection is a distinct handle, so an uncommitted row is
    invisible here the same way it is invisible to the next real request.
    """
    with REAL_CONNECT(str(site[1] / 'reading.sqlite3')) as conn:
        conn.row_factory = sqlite3.Row
        return conn.execute(f'SELECT * FROM {table}').fetchall()


class ReadOnlyDatabase:
    """Fails writes the way a saturated WAL does, while reads keep working.

    A genuinely read-only connection succeeds at `BEGIN IMMEDIATE` and fails at
    the write statement, so this fake does the same: BEGIN falls through to the
    real inner connection and only INSERT/UPDATE/DELETE raise. `after` lets a
    test allow the first n writes through, which is how the mid-loop failure
    point of `save_exercise_progress` -- one row already saved -- gets exercised.
    `message` is overridable so a subclass can raise a non-readonly error.
    """

    failing = ('INSERT', 'UPDATE', 'DELETE')
    message = 'attempt to write a readonly database'

    def __init__(self, path, *args, after=0, **kwargs):
        self._inner = REAL_CONNECT(path, *args, **kwargs)
        self._after = after

    @property
    def row_factory(self):
        return self._inner.row_factory

    @row_factory.setter
    def row_factory(self, value):
        self._inner.row_factory = value

    def execute(self, statement, *rest):
        if statement.lstrip().upper().startswith(self.failing):
            if self._after <= 0:
                raise sqlite3.OperationalError(self.message)
            self._after -= 1
        return self._inner.execute(statement, *rest)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return self._inner.__exit__(*exc)

    def close(self):
        self._inner.close()


class LockedDatabase(ReadOnlyDatabase):
    """A different OperationalError, which must NOT be swallowed."""

    message = 'database is locked'


def break_writes(monkeypatch, cls=ReadOnlyDatabase, **kwargs):
    monkeypatch.setattr('app.sqlite3.connect', lambda *a, **k: cls(*a, **k, **kwargs))


def assert_degraded(response):
    """The full retryable-503 contract, asserted on every covered endpoint.

    Every header is checked explicitly: dropping `Retry-After`, the
    `x-sils-fallback` marker or Task 1's `no-store` on `/api/`, or blanking the
    human-readable `detail`, must fail a test.
    """
    body = response.json()
    assert response.status_code == 503
    assert body['fallback'] is True
    assert isinstance(body['detail'], str) and body['detail']
    assert response.headers['retry-after'] == '2'
    assert response.headers['x-sils-fallback'] == '1'
    assert response.headers['cache-control'] == 'no-store'


def test_entry_write_degrades_to_503(site, monkeypatch):
    client = reader(site)
    break_writes(monkeypatch)
    response = client.post(f'/api/chapters/{CHAPTER}/entries',
                           json={'kind': 'comment', 'text': '占位内容'})
    assert_degraded(response)


def test_wish_write_degrades_to_503(site, monkeypatch):
    client = reader(site)
    break_writes(monkeypatch)
    response = client.post('/api/wishes', json={'text': '希望补充评测章节'})
    assert_degraded(response)


def test_progress_write_degrades_to_503(site, monkeypatch):
    client = reader(site)
    break_writes(monkeypatch)
    response = client.post('/api/exercises/progress', json={'items': [
        {'chapter': CHAPTER, 'exercise': EXERCISES[0], 'code': 'x', 'passed': True,
         'score': 1, 'attempts': 1, 'updated': int(time.time())}]})
    assert_degraded(response)


def test_delete_entry_degrades_to_503(site, monkeypatch):
    client = reader(site)
    created = client.post(f'/api/chapters/{CHAPTER}/entries',
                          json={'kind': 'comment', 'text': '待删除'})
    assert created.status_code == 201
    break_writes(monkeypatch)
    response = client.delete(f"/api/entries/{created.json()['id']}")
    assert_degraded(response)


def test_delete_wish_degrades_to_503(site, monkeypatch):
    client = reader(site)
    created = client.post('/api/wishes', json={'text': '待删除的愿望'})
    assert created.status_code == 201
    break_writes(monkeypatch)
    response = client.delete(f"/api/wishes/{created.json()['id']}")
    assert_degraded(response)


def test_progress_failure_after_a_saved_row_rolls_back(site, monkeypatch):
    """A batch that already committed one row mid-loop, then hit the read-only
    wall on the second, must roll the whole transaction back and degrade -- not
    partially commit. `after=3` lets the quota-log write and the first progress
    row through, so `saved` reaches 1 before the failing statement."""
    client = reader(site)
    break_writes(monkeypatch, after=3)
    response = client.post('/api/exercises/progress', json={'items': [
        {'chapter': CHAPTER, 'exercise': EXERCISES[0], 'code': 'a', 'passed': True,
         'score': 1, 'attempts': 1, 'updated': int(time.time())},
        {'chapter': CHAPTER, 'exercise': EXERCISES[1], 'code': 'b', 'passed': True,
         'score': 1, 'attempts': 1, 'updated': int(time.time())}]})
    assert_degraded(response)
    assert stored_rows(site, 'exercise_progress') == []


def test_other_operational_error_is_not_swallowed(site, monkeypatch):
    """A `database is locked` OperationalError is not the read-only WAL failure,
    so it must still surface as a 500 -- on the wish endpoint and, crucially, on
    the progress endpoint whose per-row state would be damaged by a swallowed lock.
    """
    quiet = reader(site, raise_server_exceptions=False)
    break_writes(monkeypatch, LockedDatabase)
    assert quiet.post('/api/wishes', json={'text': '锁冲突不该被降级'}).status_code == 500
    assert quiet.post('/api/exercises/progress', json={'items': [
        {'chapter': CHAPTER, 'exercise': EXERCISES[0], 'code': 'x', 'passed': True,
         'score': 1, 'attempts': 1, 'updated': int(time.time())}]}).status_code == 500


def test_rate_limit_still_wins_over_fallback(site, monkeypatch):
    """The count query runs before the failing write, so an over-quota reader gets
    429 even with the database read-only -- the limiter outranks the fallback.
    """
    client = reader(site)
    for _ in range(5):
        assert client.post('/api/wishes', json={'text': '频率测试'}).status_code == 201
    break_writes(monkeypatch)
    assert client.post('/api/wishes', json={'text': '频率测试'}).status_code == 429
