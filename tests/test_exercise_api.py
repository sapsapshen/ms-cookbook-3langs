import base64
import json
import logging
import sqlite3
import time
import pytest
from fastapi.testclient import TestClient
from itsdangerous import TimestampSigner
from app import EXERCISE_PROGRESS_COLUMNS, GRADE_CALL_LIMIT, create_app

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
    """An id the corpus does not hold is not storable, but it is only that one
    row that is unstorable: it is skipped and counted, never a refusal of the
    batch."""
    client = reader(site)
    response = client.post(PROGRESS, json={'items': [
        {'chapter': 'chapter-999', 'exercise': 'ch999-ex01', 'passed': 1},
    ]})
    assert response.status_code == 201
    assert response.json() == {'saved': 0, 'skipped': 1}
    assert client.get(PROGRESS).json()['items'] == []


def test_pending_chapter_is_rejected(site):
    client = reader(site)
    response = client.post(PROGRESS, json={'items': [
        {'chapter': 'chapter-24', 'exercise': 'ch24-ex01', 'passed': 1},
    ]})
    assert response.status_code == 201
    assert response.json()['skipped'] == 1


def test_oversized_code_is_rejected(site):
    client = reader(site)
    response = client.post(PROGRESS, json={'items': [
        {'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'code': 'x' * 20001},
    ]})
    assert response.status_code == 201
    assert response.json()['skipped'] == 1
    assert client.get(PROGRESS).json()['items'] == []


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


def grading_reply(content, site, monkeypatch, status_code=200):
    """Point the endpoint at a model that answers with exactly `content`."""
    monkeypatch.setenv('EXERCISE_LLM_KEY', 'test-key')
    monkeypatch.setenv('EXERCISE_LLM_BASE_URL', 'http://127.0.0.1:9/v1')

    class FakeResponse:
        def __init__(self):
            self.status_code = status_code

        def json(self):
            return {'choices': [{'message': {'content': content}}]}

    monkeypatch.setattr('app.httpx.post', lambda url, **kwargs: FakeResponse())
    return TestClient(site[0]).post(GRADE, json={'exercise': SAMPLE_ID, 'answer': 'my answer', 'criteria': 'be clear'})


# Everything a model can be asked for "just JSON" and answer anyway. `verdict.get`
# on any of these raises AttributeError, which is not a ValueError: before the
# isinstance check each one escaped the handler and became a 500, so the learner
# lost the reference answer over a formatting detail.
NON_OBJECT_VERDICTS = ['null', '3', '"0.9"', 'true', '[{"score":0.9}]', 'not json']


@pytest.mark.parametrize('content', NON_OBJECT_VERDICTS)
def test_grading_never_500s_on_a_non_object_verdict(site, monkeypatch, content):
    """The rule is absolute: grading never blocks learning, so every failure to
    read a verdict degrades to the reference answer with fallback:true."""
    response = grading_reply(content, site, monkeypatch)
    assert response.status_code == 503, content
    assert response.json()['fallback'] is True, content


@pytest.mark.parametrize('content', ['3.5', '[]', '{"score":0.5,"feedback":"ok"} "trailing"'])
def test_grading_degrades_on_a_verdict_it_cannot_read(site, monkeypatch, content):
    response = grading_reply(content, site, monkeypatch)
    assert response.status_code == 503, content
    assert response.json()['fallback'] is True, content


@pytest.mark.parametrize('feedback', ['42', '{"a":1}', '[1,2]', 'null'])
def test_a_readable_score_survives_a_non_string_feedback(site, monkeypatch, feedback):
    """Only the prose is unreadable, and prose is optional: the score is the
    part the learner cannot produce without the site, so it is still delivered
    and the missing comment is simply absent."""
    response = grading_reply('{"score":0.5,"feedback":%s}' % feedback, site, monkeypatch)
    assert response.status_code == 200, feedback
    assert response.json() == {'score': 0.5, 'feedback': ''}


def test_object_feedback_is_not_stringified_into_python_repr(site, monkeypatch):
    """`str({'a': 1})` is "{'a': 1}" -- a Python repr, not prose, handed to the
    learner as if the model had written it. A non-string feedback is dropped."""
    response = grading_reply('{"score":0.5,"feedback":{"a":1}}', site, monkeypatch)
    assert response.status_code == 200
    assert response.json() == {'score': 0.5, 'feedback': ''}


def test_a_nested_verdict_still_grades(site, monkeypatch):
    """A well-formed object is untouched by the type guard."""
    response = grading_reply('{"score":0.6,"feedback":"clear"}', site, monkeypatch)
    assert response.status_code == 200
    assert response.json() == {'score': 0.6, 'feedback': 'clear'}


def test_a_non_2xx_upstream_is_still_a_fallback(site, monkeypatch):
    response = grading_reply('{"score":1}', site, monkeypatch, status_code=500)
    assert response.status_code == 503
    assert response.json()['fallback'] is True


def test_a_llm_error_body_without_choices_is_a_fallback(site, monkeypatch):
    """`['choices']` raises KeyError/IndexError on a 200 that carries an error
    object; those arrive before the verdict is ever parsed."""
    monkeypatch.setenv('EXERCISE_LLM_KEY', 'test-key')
    monkeypatch.setenv('EXERCISE_LLM_BASE_URL', 'http://127.0.0.1:9/v1')

    class FakeResponse:
        status_code = 200

        def json(self):
            return {'error': {'message': 'no capacity'}}

    monkeypatch.setattr('app.httpx.post', lambda url, **kwargs: FakeResponse())
    response = TestClient(site[0]).post(GRADE, json={'exercise': SAMPLE_ID, 'answer': 'a', 'criteria': 'c'})
    assert response.status_code == 503
    assert response.json()['fallback'] is True


# --- Review round 3: the endpoint that costs money is metered ---------------

def working_model(monkeypatch, calls=None):
    monkeypatch.setenv('EXERCISE_LLM_KEY', 'test-key')
    monkeypatch.setenv('EXERCISE_LLM_BASE_URL', 'http://127.0.0.1:9/v1')

    class FakeResponse:
        status_code = 200

        def json(self):
            return {'choices': [{'message': {'content': '{"score":0.5,"feedback":"ok"}'}}]}

    def fake_post(url, **kwargs):
        if calls is not None: calls.append(kwargs)
        return FakeResponse()

    monkeypatch.setattr('app.httpx.post', fake_post)


def test_grading_is_rate_limited_per_address(site, monkeypatch):
    """This endpoint is the only public write that spends money. Fifty guest
    calls used to be fifty real calls; past the limit the caller is refused
    before the model is ever contacted."""
    calls = []
    working_model(monkeypatch, calls)
    guest = TestClient(site[0])
    body = {'exercise': SAMPLE_ID, 'answer': 'a', 'criteria': 'c'}
    for _ in range(GRADE_CALL_LIMIT):
        assert guest.post(GRADE, json=body).status_code == 200
    assert len(calls) == GRADE_CALL_LIMIT
    refused = guest.post(GRADE, json=body)
    assert refused.status_code == 503
    assert refused.json()['fallback'] is True
    assert len(calls) == GRADE_CALL_LIMIT, 'the refused call must not reach the model'


def test_the_refusal_does_not_stop_the_learner(site, monkeypatch):
    """A throttled answer is still the reference answer plus a self-assessment:
    the same body shape, so the client needs no second code path."""
    working_model(monkeypatch)
    guest = TestClient(site[0])
    body = {'exercise': SAMPLE_ID, 'answer': 'a', 'criteria': 'c'}
    for _ in range(GRADE_CALL_LIMIT + 1):
        response = guest.post(GRADE, json=body)
    assert response.json()['fallback'] is True
    assert response.headers['x-sils-fallback'] == '1'


def test_a_refused_call_is_not_metered_against_the_caller(site, monkeypatch):
    """Otherwise a caller who keeps knocking would keep their own window open
    forever and could never be let back in."""
    working_model(monkeypatch)
    guest = TestClient(site[0])
    body = {'exercise': SAMPLE_ID, 'answer': 'a', 'criteria': 'c'}
    for _ in range(GRADE_CALL_LIMIT + 10):
        guest.post(GRADE, json=body)
    with site[0].state.db() as db:
        counted = db.execute("SELECT count(*) c FROM exercise_grade_calls WHERE outcome!='refused'").fetchone()['c']
    assert counted == GRADE_CALL_LIMIT


def test_a_refusal_is_still_recorded_for_audit(site, monkeypatch):
    """An operator looking at this table needs to see the attempt, not just the
    successes -- that is what an abuse pattern looks like."""
    working_model(monkeypatch)
    guest = TestClient(site[0])
    body = {'exercise': SAMPLE_ID, 'answer': 'a', 'criteria': 'c'}
    for _ in range(GRADE_CALL_LIMIT + 3):
        guest.post(GRADE, json=body)
    with site[0].state.db() as db:
        refused = db.execute("SELECT count(*) c FROM exercise_grade_calls WHERE outcome='refused'").fetchone()['c']
    assert refused == 3


def test_a_successful_call_is_audited_without_the_answer(site, monkeypatch):
    """Cost observation and abuse tracing, not a copy of what learners typed."""
    working_model(monkeypatch)
    TestClient(site[0]).post(GRADE, json={'exercise': SAMPLE_ID, 'answer': 'my private answer', 'criteria': 'c'})
    with site[0].state.db() as db:
        row = db.execute('SELECT * FROM exercise_grade_calls').fetchone()
    assert row['outcome'] == 'graded'
    assert 'answer' not in row.keys()
    assert 'criteria' not in row.keys()
    assert 'my private answer' not in str(tuple(row))


def test_the_address_is_hashed_not_stored(site, monkeypatch):
    """Same keyed hash the analytics endpoints use: the ledger compares hashes
    with each other and never needs the address itself."""
    working_model(monkeypatch)
    TestClient(site[0]).post(GRADE, json={'exercise': SAMPLE_ID, 'answer': 'a', 'criteria': 'c'})
    with site[0].state.db() as db:
        row = db.execute('SELECT visitor_hash FROM exercise_grade_calls').fetchone()
    assert len(row['visitor_hash']) == 64
    assert 'testclient' not in row['visitor_hash']


def test_a_refused_call_costs_nothing_at_the_model(site, monkeypatch):
    """The check runs before the upstream request, which is the whole point: a
    ceiling that still spends money is not a ceiling."""
    calls = []
    working_model(monkeypatch, calls)
    guest = TestClient(site[0])
    body = {'exercise': SAMPLE_ID, 'answer': 'a', 'criteria': 'c'}
    for _ in range(GRADE_CALL_LIMIT + 5):
        guest.post(GRADE, json=body)
    assert len(calls) == GRADE_CALL_LIMIT


def test_junk_ids_do_not_consume_the_grading_quota(site, monkeypatch):
    """Validation runs before the meter, so probing with invented ids is free."""
    calls = []
    working_model(monkeypatch, calls)
    guest = TestClient(site[0])
    for _ in range(GRADE_CALL_LIMIT + 5):
        assert guest.post(GRADE, json={'exercise': 'ch99-ex99', 'answer': 'a', 'criteria': 'c'}).status_code == 422
    assert calls == []
    assert guest.post(GRADE, json={'exercise': SAMPLE_ID, 'answer': 'a', 'criteria': 'c'}).status_code == 200


def test_an_unconfigured_deployment_still_answers_every_call(site):
    """Without a key there is nothing to spend, so the meter must not get in the
    way of a guest who keeps retrying."""
    guest = TestClient(site[0])
    for _ in range(GRADE_CALL_LIMIT + 10):
        response = guest.post(GRADE, json={'exercise': SAMPLE_ID, 'answer': 'a', 'criteria': 'c'})
        assert response.status_code == 503
        assert response.json()['fallback'] is True


def test_the_old_ledger_does_not_grow_without_bound(site, monkeypatch):
    """Pruned in the same transaction that writes it, like the write ledger."""
    working_model(monkeypatch)
    guest = TestClient(site[0])
    body = {'exercise': SAMPLE_ID, 'answer': 'a', 'criteria': 'c'}
    for _ in range(GRADE_CALL_LIMIT + 5):
        guest.post(GRADE, json=body)
    with site[0].state.db() as db:
        db.execute('UPDATE exercise_grade_calls SET created=0')
        db.execute("DELETE FROM exercise_grade_calls WHERE created<0")
        db.execute('INSERT INTO exercise_grade_calls VALUES (?,?,?,?)', ('stale', 'visitor', 0, 'graded'))
    guest.post(GRADE, json=body)
    with site[0].state.db() as db:
        stale = db.execute("SELECT count(*) c FROM exercise_grade_calls WHERE created=0 AND id='stale'").fetchone()['c']
    assert stale == 0


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


# --- Review round 3: the batch must not be a ceiling on how much a reader can
# sync, and one bad row must not decide the fate of the others ---------------

ALL_PAIRS = [(chapter, exercise) for chapter, exercise in ANY_EXERCISE]


def rows(count, **overrides):
    """`count` rows cycling through the real corpus, so a batch can be bigger
    than the nine exercises that exist today without inventing ids."""
    return [dict({'chapter': chapter, 'exercise': exercise, 'passed': 1, 'score': 0.5}, **overrides)
            for chapter, exercise in (ALL_PAIRS * count)[:count]]


def test_a_batch_bigger_than_the_write_quota_is_stored(site):
    """The deadlock: `count + len(items) > 20` meant a reader past 20 rows of
    progress could never sync again. 25 rows in one request used to be a 429 and
    is now stored whole."""
    client = reader(site)
    response = client.post(PROGRESS, json={'items': rows(25)})
    assert response.status_code == 201
    assert response.json() == {'saved': 25, 'skipped': 0}


def test_sixty_rows_in_one_request_are_stored(site):
    """The second ceiling: `max_length=50` answered 51 rows with a 422. The cap
    now sits far above any plausible corpus."""
    client = reader(site)
    response = client.post(PROGRESS, json={'items': rows(60)})
    assert response.status_code == 201
    assert response.json() == {'saved': 60, 'skipped': 0}
    # 60 rows over the 9 real ids upsert onto all 9; none is lost.
    assert len(client.get(PROGRESS).json()['items']) == len(ALL_PAIRS)


def test_the_quota_still_counts_requests_not_rows(site):
    """Removing the row term must not remove the limit: twenty single-row syncs
    in a minute is twenty writes, and the twenty-first is refused."""
    client = reader(site)
    body = {'items': [{'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'passed': 1}]}
    for _ in range(20):
        assert client.post(PROGRESS, json=body).status_code == 201
    assert client.post(PROGRESS, json=body).status_code == 429


def test_a_refused_sync_is_not_charged_twice(site):
    """The refusal happens inside the transaction that logs the write, so a
    reader who retries after the window opens is not penalised for the 429."""
    client = reader(site)
    body = {'items': [{'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'passed': 1}]}
    for _ in range(25):
        client.post(PROGRESS, json=body)
    with client.app.state.db() as db:
        rows_logged = db.execute('SELECT count(*) c FROM exercise_progress_writes').fetchone()['c']
    assert rows_logged == 20


def test_an_empty_batch_does_not_consume_the_quota(site):
    """`{'items': []}` writes nothing, so charging it would let a client spend a
    reader's whole minute re-syncing a reader who has never opened an exercise.
    It answers 201 with nothing saved and leaves the log empty."""
    client = reader(site)
    for _ in range(30):
        assert client.post(PROGRESS, json={'items': []}).status_code == 201
    with client.app.state.db() as db:
        rows_logged = db.execute('SELECT count(*) c FROM exercise_progress_writes').fetchone()['c']
    assert rows_logged == 0
    assert client.post(PROGRESS, json={'items': [{'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID}]}).status_code == 201






def test_a_row_with_an_out_of_range_pass_is_skipped_not_a_server_error(site):
    """passed had no range check, so 2 reached the INSERT and tripped the column
    CHECK -- a sqlite3.IntegrityError, i.e. a 500, over a reader's typo. It is a
    validation failure now, and the batch survives it."""
    client = reader(site)
    for bad in (2, -1, 99):
        response = client.post(PROGRESS, json={'items': [
            {'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'passed': bad},
        ]})
        assert response.status_code == 201, bad
        assert response.json() == {'saved': 0, 'skipped': 1}, bad
    assert client.get(PROGRESS).json()['items'] == []


def test_one_bad_score_does_not_poison_the_batch(site):
    """The end of the row-level bug: nine good rows plus a score of 1.7 used to
    be a 422 that lost all ten. The nine are stored."""
    client = reader(site)
    good = [{'chapter': chapter, 'exercise': exercise, 'passed': 1, 'score': 0.5}
            for chapter, exercise in ALL_PAIRS]
    batch = list(good)
    batch.insert(4, {'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'score': 1.7})
    response = client.post(PROGRESS, json={'items': batch})
    assert response.status_code == 201
    assert response.json() == {'saved': 9, 'skipped': 1}
    stored = {item['exercise'] for item in client.get(PROGRESS).json()['items']}
    assert stored == {exercise for _, exercise in ALL_PAIRS}


def test_a_row_that_is_not_an_object_is_skipped(site):
    """A hand-edited or half-written payload can hold a bare number where a row
    belongs. It is skipped, not a 500."""
    client = reader(site)
    response = client.post(PROGRESS, json={'items': [
        {'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'passed': 1},
        42, None, 'a string', [], {},
    ]})
    assert response.status_code == 201
    assert response.json() == {'saved': 1, 'skipped': 5}
    assert client.get(PROGRESS).json()['items'][0]['passed'] == 1


def test_every_known_row_shape_is_still_validated(site):
    """Skipping must not become a hole: the field rules the row-level pass used
    to enforce all still hold for the rows that do validate."""
    client = reader(site)
    cases = [
        {'chapter': '', 'exercise': SAMPLE_ID},
        {'chapter': SAMPLE_CHAPTER, 'exercise': ''},
        {'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'score': -0.1},
        {'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'attempts': -1},
        {'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'updated': -1},
        {'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'selfAssessed': 'x' * 17},
    ]
    response = client.post(PROGRESS, json={'items': cases})
    assert response.json() == {'saved': 0, 'skipped': len(cases)}


def test_skipping_a_row_does_not_spend_extra_quota(site):
    """A batch that stores nothing is still one request: the log row is written
    once, before the loop, so retrying costs one write and not one per row."""
    client = reader(site)
    for _ in range(20):
        assert client.post(PROGRESS, json={'items': [{'chapter': 'chapter-999', 'exercise': 'nope'}]}).status_code == 201
    assert client.post(PROGRESS, json={'items': [{'chapter': 'chapter-999', 'exercise': 'nope'}]}).status_code == 429


def test_the_batch_cap_is_a_ceiling_and_not_a_quota(site):
    """1000 is far above the corpus; a body past it is still refused as too
    large, because it is a bound on one request and nothing more."""
    client = reader(site)
    response = client.post(PROGRESS, json={'items': rows(1001)})
    assert response.status_code == 422


# --- Review round 4: a skipped row must not carry the reader's own words into
# the application log --------------------------------------------------

MARKER = 'SECRET-MARKER-XYZ'


def captured_log(caplog):
    """The records as a formatter renders them, not `getMessage()`.

    LOGGER.exception() appends a traceback, and the traceback is where a
    converted value hides. Reading only `record.getMessage()` would show a clean
    log for a leak that is really there.
    """
    formatter = logging.Formatter()
    return '\n'.join(formatter.format(record) for record in caplog.records)


@pytest.mark.parametrize('oversize', [
    {'code': '# ' + MARKER + '\n' + 'x' * 20001},
    {'selfAssessed': MARKER + 'SELF'},
])
def test_a_skipped_row_never_reaches_the_log(site, caplog, oversize):
    """pydantic's errors() carries the rejected value under 'input', so logging
    it wrote the learner's submitted code -- and their self-assessment -- into
    the application log on a trigger as ordinary as a long answer."""
    caplog.set_level(logging.INFO, logger='app')
    client = reader(site)
    response = client.post(PROGRESS, json={'items': [
        dict({'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID}, **oversize),
    ]})
    assert response.status_code == 201
    assert response.json() == {'saved': 0, 'skipped': 1}
    assert MARKER not in captured_log(caplog)


def test_the_skip_is_still_reported_to_the_operator(site, caplog):
    """Silencing the leak by deleting the log line would pass the test above.
    Operations still has to learn that rows are being dropped: the field and
    the rule that rejected it are enough, and neither is the reader's."""
    caplog.set_level(logging.INFO, logger='app')
    client = reader(site)
    client.post(PROGRESS, json={'items': [
        {'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'code': MARKER + 'x' * 20001},
    ]})
    log = captured_log(caplog)
    assert 'Skipped an unreadable progress row' in log
    assert "'loc': ('code',)" in log
    assert 'string_too_long' in log


def test_an_unknown_exercise_row_is_logged_without_its_id(site, caplog):
    """The other skip branch. It logs a fixed sentence, so this locks in that
    the sentence stays fixed -- a row's chapter/exercise are corpus ids, not
    reader content, but the habit is what matters here."""
    caplog.set_level(logging.INFO, logger='app')
    client = reader(site)
    client.post(PROGRESS, json={'items': [{'chapter': 'chapter-999', 'exercise': MARKER}]})
    log = captured_log(caplog)
    assert 'does not exist' in log
    assert MARKER not in log


def test_a_model_reply_that_quotes_the_answer_does_not_reach_the_log(site, monkeypatch, caplog):
    """The same leak through the other new path.

    float() puts the string it could not convert into its own ValueError, and
    LOGGER.exception prints that message with its traceback. A model asked to
    grade an answer sometimes quotes that answer back -- which puts the
    learner's own words into the log, and this endpoint is the one place the
    server ever holds them.
    """
    caplog.set_level(logging.INFO, logger='app')
    echoed = json.dumps({'score': 'my answer is ' + MARKER, 'feedback': 'ok'})
    assert grading_reply(echoed, site, monkeypatch).status_code == 503
    assert 'Exercise grading returned an unparsable verdict' in captured_log(caplog)
    assert MARKER not in captured_log(caplog)


