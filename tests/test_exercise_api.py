import base64
import json
import sqlite3
import time
import pytest
from fastapi.testclient import TestClient
from itsdangerous import TimestampSigner
from app import EXERCISE_PROGRESS_COLUMNS, create_app

ROOT_ID = __import__('pathlib').Path(__file__).resolve().parent.parent


def exercise_ids():
    raw = (ROOT_ID / 'assets' / 'exercises.js').read_text(encoding='utf-8')
    data = json.loads(raw.split('=', 1)[1].strip().rstrip(';'))
    ids = {}
    for chapter_id, chapter in data['chapters'].items():
        ids[chapter_id] = [item['id'] for item in chapter['exercises']['zh']]
    return ids


IDS = exercise_ids()
SAMPLE_CHAPTER = sorted(IDS)[0]
SAMPLE_ID = IDS[SAMPLE_CHAPTER][0]


@pytest.fixture
def site(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_BASE_URL', 'http://127.0.0.1:7860')
    monkeypatch.delenv('OAUTH_CLIENT_ID', raising=False)
    monkeypatch.delenv('OAUTH_CLIENT_SECRET', raising=False)
    monkeypatch.delenv('EXERCISE_LLM_KEY', raising=False)
    monkeypatch.delenv('EXERCISE_LLM_BASE_URL', raising=False)
    return create_app(tmp_path), tmp_path


def reader(site, uid='alice'):
    app, path = site
    with app.state.db() as db:
        db.execute('INSERT OR IGNORE INTO users VALUES (?,?,?)', (uid, 'sub-' + uid, uid))
        db.execute('INSERT OR REPLACE INTO sessions VALUES (?,?,?)', ('session-' + uid, uid, int(time.time()) + 1000))
    client = TestClient(app, base_url='http://127.0.0.1:7860')
    data = base64.b64encode(json.dumps({'sid': 'session-' + uid, 'csrf': 'test-csrf'}).encode())
    cookie = TimestampSigner((path / 'session.key').read_text()).sign(data).decode()
    client.cookies.set('purplebook_session', cookie)
    client.headers.update({'origin': 'http://127.0.0.1:7860', 'x-csrf-token': 'test-csrf'})
    return client


PROGRESS = '/api/exercises/progress'


def test_guest_reads_empty_progress(site):
    guest = TestClient(site[0])
    response = guest.get(PROGRESS)
    assert response.status_code == 200
    assert response.json()['items'] == []


def test_guest_cannot_write_progress(site):
    guest = TestClient(site[0])
    assert guest.post(PROGRESS, json={'items': []}).status_code == 401


def test_writer_needs_matching_origin_and_csrf(site):
    client = reader(site)
    client.headers['origin'] = 'https://evil.example'
    assert client.post(PROGRESS, json={'items': []}).status_code == 403
    client.headers['origin'] = 'http://127.0.0.1:7860'
    client.headers['x-csrf-token'] = 'wrong'
    assert client.post(PROGRESS, json={'items': []}).status_code == 403


def test_round_trip_progress(site):
    client = reader(site)
    response = client.post(PROGRESS, json={'items': [
        {'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'passed': 1, 'score': 1, 'code': 'print(1)'},
    ]})
    assert response.status_code == 201
    assert response.json()['saved'] == 1
    stored = client.get(PROGRESS).json()['items']
    assert len(stored) == 1
    assert stored[0]['exercise'] == SAMPLE_ID
    assert stored[0]['passed'] == 1
    assert stored[0]['code'] == 'print(1)'


def test_unknown_exercise_is_rejected(site):
    client = reader(site)
    response = client.post(PROGRESS, json={'items': [
        {'chapter': 'chapter-999', 'exercise': 'ch999-ex01', 'passed': 1},
    ]})
    assert response.status_code == 422
    assert client.get(PROGRESS).json()['items'] == []


def test_pending_chapter_is_rejected(site):
    client = reader(site)
    response = client.post(PROGRESS, json={'items': [
        {'chapter': 'chapter-24', 'exercise': 'ch24-ex01', 'passed': 1},
    ]})
    assert response.status_code == 422


def test_oversized_code_is_rejected(site):
    client = reader(site)
    response = client.post(PROGRESS, json={'items': [
        {'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'code': 'x' * 20001},
    ]})
    assert response.status_code == 422


def test_repeat_writes_are_rate_limited(site):
    client = reader(site)
    body = {'items': [{'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'passed': 1}]}
    for _ in range(20):
        assert client.post(PROGRESS, json=body).status_code == 201
    assert client.post(PROGRESS, json=body).status_code == 429


def test_progress_survives_a_restart(site):
    client = reader(site)
    client.post(PROGRESS, json={'items': [
        {'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'passed': 1, 'score': 0.9},
    ]})
    restarted = reader((create_app(site[1]), site[1]))
    stored = restarted.get(PROGRESS).json()['items']
    assert stored[0]['score'] == 0.9


def test_progress_is_scoped_to_the_reader(site):
    first = reader(site, 'alice')
    first.post(PROGRESS, json={'items': [
        {'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'passed': 1},
    ]})
    second = reader(site, 'bob')
    assert second.get(PROGRESS).json()['items'] == []


GRADE = '/api/exercises/grade'


def test_grading_without_a_key_falls_back(site):
    guest = TestClient(site[0])
    response = guest.post(GRADE, json={'exercise': SAMPLE_ID, 'answer': 'text', 'criteria': 'be clear'})
    assert response.status_code == 503
    assert response.json()['fallback'] is True


def test_grading_survives_a_broken_endpoint(site, monkeypatch):
    monkeypatch.setenv('EXERCISE_LLM_KEY', 'test-key')
    monkeypatch.setenv('EXERCISE_LLM_BASE_URL', 'http://127.0.0.1:9/unreachable')
    guest = TestClient(site[0])
    response = guest.post(GRADE, json={'exercise': SAMPLE_ID, 'answer': 'text', 'criteria': 'be clear'})
    assert response.status_code == 503
    assert response.json()['fallback'] is True


def test_grading_uses_a_configured_endpoint(site, monkeypatch):
    monkeypatch.setenv('EXERCISE_LLM_KEY', 'test-key')
    monkeypatch.setenv('EXERCISE_LLM_BASE_URL', 'http://127.0.0.1:9/v1')
    seen = {}

    class FakeResponse:
        status_code = 200

        def json(self):
            return {'choices': [{'message': {'content': '{"score":0.75,"feedback":"clear but shallow"}'}}]}

    def fake_post(url, **kwargs):
        seen['url'] = url
        seen['json'] = kwargs.get('json')
        return FakeResponse()

    monkeypatch.setattr('app.httpx.post', fake_post)
    guest = TestClient(site[0])
    response = guest.post(GRADE, json={'exercise': SAMPLE_ID, 'answer': 'my answer', 'criteria': 'be clear'})
    assert response.status_code == 200
    assert response.json() == {'score': 0.75, 'feedback': 'clear but shallow'}
    assert seen['url'].endswith('/chat/completions')
    assert seen['json']['model']


def test_grading_rejects_an_unknown_exercise(site):
    guest = TestClient(site[0])
    assert guest.post(GRADE, json={'exercise': 'ch99-ex99', 'answer': 'x', 'criteria': 'y'}).status_code == 422


ANY_EXERCISE = [(chapter, exercise) for chapter in sorted(IDS) for exercise in IDS[chapter]]
CHAPTER_IDS = IDS[SAMPLE_CHAPTER]


def test_every_self_assessment_state_round_trips(site):
    """The three states must survive the sync boundary byte for byte.

    The learning map counts anything that is not 'fail' as self-assessed
    progress, so the read path collapsing 'fail' into a truthy token reports a
    pass the learner never gave.
    """
    client = reader(site)
    states = ('pass', 'partial', 'fail', '')
    for (chapter, exercise), state in zip(ANY_EXERCISE, states):
        assert client.post(PROGRESS, json={'items': [
            {'chapter': chapter, 'exercise': exercise, 'passed': 0, 'score': 0, 'selfAssessed': state},
        ]}).status_code == 201
    stored = {item['exercise']: item['selfAssessed'] for item in client.get(PROGRESS).json()['items']}
    assert stored == dict(zip((exercise for _, exercise in ANY_EXERCISE), states))


def test_a_failed_self_assessment_still_reads_as_failed(site):
    """The regression this file exists for: 'fail' used to read back as 'graded',
    which chapterSummary counts as progress. 'graded' is not 'fail'."""
    client = reader(site)
    client.post(PROGRESS, json={'items': [
        {'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'passed': 0, 'score': 0, 'selfAssessed': 'fail'},
    ]})
    stored = client.get(PROGRESS).json()['items']
    assert stored[0]['selfAssessed'] == 'fail'
    assert stored[0]['selfAssessed'] != 'graded'


def test_a_self_assessment_can_be_revised_in_both_directions(site):
    """Unlike passed/score, a self-assessment is a statement about right now and
    must move both ways. Ratcheting it would make 'fail' -> 'pass' impossible."""
    client = reader(site)
    def assess(state):
        client.post(PROGRESS, json={'items': [
            {'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'passed': 0, 'score': 0, 'selfAssessed': state},
        ]})
        return client.get(PROGRESS).json()['items'][0]['selfAssessed']
    assert assess('pass') == 'pass'
    assert assess('fail') == 'fail'
    assert assess('partial') == 'partial'
    assert assess('') == ''


def test_an_unknown_self_assessment_is_dropped_rather_than_stored(site):
    """An unrecognised token cannot be mapped onto a state -- the old build read
    every assessment back as 'graded', indistinguishable from a real 'pass' -- so
    it is discarded. Rejecting it instead would fail the whole batch and strand
    every other exercise in it."""
    client = reader(site)
    assert client.post(PROGRESS, json={'items': [
        {'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'passed': 0, 'selfAssessed': 'graded'},
    ]}).status_code == 201
    assert client.get(PROGRESS).json()['items'][0]['selfAssessed'] == ''


def test_a_stored_self_assessment_satisfies_the_column_check(site):
    """The CHECK is the backstop for the fold above: whatever self_assessment_state
    lets through has to be one of the four column values."""
    client = reader(site)
    client.post(PROGRESS, json={'items': [
        {'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'selfAssessed': 'fail'},
        {'chapter': SAMPLE_CHAPTER, 'exercise': CHAPTER_IDS[1], 'selfAssessed': 'nonsense'},
    ]})
    with client.app.state.db() as db:
        rows = db.execute('SELECT self_assessed FROM exercise_progress ORDER BY exercise').fetchall()
    assert [row['self_assessed'] for row in rows] == ['fail', '']


LEGACY_TABLE = f'''CREATE TABLE exercise_progress(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  chapter TEXT NOT NULL,
  exercise TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  passed INTEGER NOT NULL DEFAULT 0 CHECK(passed IN (0,1)),
  score REAL NOT NULL DEFAULT 0,
  self_assessed INTEGER NOT NULL DEFAULT 0 CHECK(self_assessed IN (0,1)),
  attempts INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL,
  UNIQUE(user_id, chapter, exercise));
CREATE INDEX IF NOT EXISTS exercise_progress_user ON exercise_progress(user_id, updated);'''


def legacy_database(tmp_path):
    """A database written by the two-state build: same file, INTEGER column."""
    conn = sqlite3.connect(tmp_path / 'reading.sqlite3')
    conn.executescript('''
    PRAGMA journal_mode=WAL;
    CREATE TABLE users(id TEXT PRIMARY KEY, sub TEXT UNIQUE NOT NULL, name TEXT NOT NULL);
    CREATE TABLE sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);''')
    conn.executescript(LEGACY_TABLE)
    conn.execute('INSERT INTO users VALUES (?,?,?)', ('alice', 'sub-alice', 'alice'))
    conn.execute('INSERT INTO exercise_progress VALUES (?,?,?,?,?,?,?,?,?,?)',
                 ('legacy-row', 'alice', SAMPLE_CHAPTER, SAMPLE_ID, 'print(1)', 1, 0.75, 1, 4, 1750000000))
    conn.commit()
    conn.close()


def db_sql(app):
    with app.state.db() as db:
        return db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='exercise_progress'").fetchone()['sql']


def test_a_legacy_integer_column_is_rebuilt_as_text(tmp_path, monkeypatch):
    """CREATE TABLE IF NOT EXISTS cannot change a column's type, so a deployed
    database keeps the old shape until it is rebuilt."""
    monkeypatch.setenv('APP_BASE_URL', 'http://127.0.0.1:7860')
    legacy_database(tmp_path)
    app = create_app(tmp_path)
    with app.state.db() as db:
        columns = {row['name']: row['type'] for row in db.execute('PRAGMA table_info(exercise_progress)')}
    assert columns['self_assessed'] == 'TEXT'
    assert columns['passed'] == 'INTEGER'
    assert "self_assessed IN ('','pass','partial','fail')" in db_sql(app)


def test_the_migration_keeps_the_rest_of_the_row(tmp_path, monkeypatch):
    """Only self_assessed is unknowable: the legacy 1 stands for 'pass',
    'partial' and 'fail' alike, so it becomes ''. Everything else is real
    progress and has to survive the rebuild untouched."""
    monkeypatch.setenv('APP_BASE_URL', 'http://127.0.0.1:7860')
    legacy_database(tmp_path)
    client = reader((create_app(tmp_path), tmp_path))
    stored = client.get(PROGRESS).json()['items']
    assert len(stored) == 1
    assert stored[0]['selfAssessed'] == ''
    assert stored[0]['passed'] == 1
    assert stored[0]['score'] == 0.75
    assert stored[0]['code'] == 'print(1)'
    assert stored[0]['attempts'] == 4
    assert stored[0]['updated'] == 1750000000


def test_the_migration_is_idempotent(tmp_path, monkeypatch):
    """create_app runs on every boot; a second pass must not rebuild again or
    lose the rows the first pass wrote."""
    monkeypatch.setenv('APP_BASE_URL', 'http://127.0.0.1:7860')
    legacy_database(tmp_path)
    first = create_app(tmp_path)
    client = reader((first, tmp_path))
    client.post(PROGRESS, json={'items': [
        {'chapter': SAMPLE_CHAPTER, 'exercise': CHAPTER_IDS[1], 'selfAssessed': 'partial'},
    ]})
    restarted = reader((create_app(tmp_path), tmp_path))
    stored = {item['exercise']: item['selfAssessed'] for item in restarted.get(PROGRESS).json()['items']}
    assert stored == {SAMPLE_ID: '', CHAPTER_IDS[1]: 'partial'}


def test_the_new_column_accepts_a_three_state_write_after_migration(tmp_path, monkeypatch):
    """The rebuilt table has to be writable in the new shape, not just readable."""
    monkeypatch.setenv('APP_BASE_URL', 'http://127.0.0.1:7860')
    legacy_database(tmp_path)
    client = reader((create_app(tmp_path), tmp_path))
    assert client.post(PROGRESS, json={'items': [
        {'chapter': SAMPLE_CHAPTER, 'exercise': CHAPTER_IDS[2], 'selfAssessed': 'fail'},
    ]}).status_code == 201
    stored = {item['exercise']: item['selfAssessed'] for item in client.get(PROGRESS).json()['items']}
    assert stored[CHAPTER_IDS[2]] == 'fail'


def test_a_millisecond_stamp_is_folded_to_seconds(site):
    """An older client stamps Date.now(). Stored as-is it would outrank every
    real second stamp forever, so the row would win every merge and nothing the
    server held could ever come back down."""
    client = reader(site)
    client.post(PROGRESS, json={'items': [
        {'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'updated': 1750000000123},
    ]})
    assert client.get(PROGRESS).json()['items'][0]['updated'] == 1750000000


def test_a_second_stamp_is_left_alone(site):
    client = reader(site)
    client.post(PROGRESS, json={'items': [
        {'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'updated': 1750000000},
    ]})
    assert client.get(PROGRESS).json()['items'][0]['updated'] == 1750000000


def test_a_millisecond_stamp_does_not_outrank_a_newer_server_row(site):
    """The bug, end to end: device A sends milliseconds, device B sends seconds.
    Folding is what lets the genuinely newer second row win."""
    client = reader(site)
    client.post(PROGRESS, json={'items': [
        {'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'updated': 1750000000000},
    ]})
    client.post(PROGRESS, json={'items': [
        {'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'passed': 1, 'score': 0.9, 'updated': 1750000500},
    ]})
    stored = client.get(PROGRESS).json()['items'][0]
    assert stored['updated'] == 1750000500
    assert stored['passed'] == 1
    assert stored['score'] == 0.9


def test_the_server_clock_fallback_is_in_seconds(site):
    client = reader(site)
    client.post(PROGRESS, json={'items': [{'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID}]})
    stored = client.get(PROGRESS).json()['items'][0]['updated']
    assert abs(stored - int(time.time())) <= 5


def test_the_column_list_the_migration_uses_matches_the_served_table(site):
    """The DDL is a module constant shared by both paths; a drift between the
    fresh-create and the rebuild would mean deployed and new databases disagree."""
    assert EXERCISE_PROGRESS_COLUMNS in db_sql(site[0])
