import base64
import json
import logging
import sqlite3
import threading
import time
import pytest
from fastapi.testclient import TestClient
from itsdangerous import TimestampSigner
from pydantic import BaseModel, ValidationError, field_validator
from app import EXERCISE_PROGRESS_COLUMNS, GRADE_CALL_LIMIT, create_app, unreadable_row_reasons

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

REAL_CONNECT = sqlite3.connect


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


def test_a_chapter_filter_narrows_the_pull(site):
    """The panel asks for one chapter at a time.

    A row carries up to 20000 characters of the learner's own code and there is
    no pagination, so an unfiltered pull is the whole corpus on every chapter
    entry -- free at 9 exercises, hundreds of kilobytes at 100.
    """
    chapters = sorted(IDS)[:2]
    client = reader(site)
    for chapter in chapters:
        assert client.post(PROGRESS, json={'items': [
            {'chapter': chapter, 'exercise': IDS[chapter][0], 'passed': 1, 'score': 1, 'code': f'# {chapter}'},
        ]}).status_code == 201
    everything = client.get(PROGRESS).json()['items']
    assert len(everything) == 2, 'the unfiltered read must still return everything'
    only = client.get(PROGRESS, params={'chapter': chapters[0]}).json()['items']
    assert [item['chapter'] for item in only] == [chapters[0]]
    assert only[0]['code'] == f'# {chapters[0]}'
    # A chapter with nothing recorded answers empty rather than everything.
    assert client.get(PROGRESS, params={'chapter': sorted(IDS)[-1]}).json()['items'] == []


def test_a_chapter_filter_never_widens_the_pull(site):
    """An id the corpus does not hold matches no rows. Answering with the whole
    table instead would be worse than useless: the caller asked a narrow
    question and would merge everything back."""
    client = reader(site)
    client.post(PROGRESS, json={'items': [
        {'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'passed': 1, 'score': 1, 'code': 'print(1)'},
    ]})
    for chapter in ['chapter-999', "'; DROP TABLE exercise_progress; --"]:
        response = client.get(PROGRESS, params={'chapter': chapter})
        assert response.status_code == 200
        assert response.json()['items'] == [], f'{chapter!r} returned the whole table'
    # An over-long value is refused outright rather than compared. The panel
    # always sends `chapter-N` from the address bar, so this is reachable only
    # by something hand-crafting the URL -- and a 422 says so, where an empty
    # list would read as "you have no progress".
    assert client.get(PROGRESS, params={'chapter': 'x' * 200}).status_code == 422
    # An empty filter is the same request as no filter, which is what the
    # optional parameter means.
    assert client.get(PROGRESS, params={'chapter': ''}).json()['items'] == client.get(PROGRESS).json()['items']
    # The table is still there.
    assert client.get(PROGRESS).json()['items'] != []


def test_a_guest_gets_nothing_through_the_filter_either(site):
    guest = TestClient(site[0])
    response = guest.get(PROGRESS, params={'chapter': SAMPLE_CHAPTER})
    assert response.status_code == 200
    assert response.json()['items'] == []


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


def test_a_refused_call_is_recorded_against_the_caller(site, monkeypatch):
    """A refusal now consumes the quota, which is what makes the ceiling hold.

    The old rule recorded a refusal without counting it, so a caller could
    retry immediately and be measured against the same rows forever. Under
    concurrency that is not a courtesy, it is a hole: nothing stops the retries
    from all passing the check in the gap before any of them writes.

    The trade is real and worth naming: a caller who keeps knocking holds their
    own window open. That is what a rate limit is -- the window slides, and a
    caller who stops knocking is served again within the minute.

    Serial callers cannot tell the old rule from the new one: thirty graded
    calls fill the window either way. The difference shows up only under
    concurrency, which is why the burst tests below exist and why this one is
    about the ledger's shape rather than about a refusal being served.
    """
    working_model(monkeypatch)
    guest = TestClient(site[0])
    body = {'exercise': SAMPLE_ID, 'answer': 'a', 'criteria': 'c'}
    for _ in range(GRADE_CALL_LIMIT + 10):
        guest.post(GRADE, json=body)
    with site[0].state.db() as db:
        counted = db.execute('SELECT count(*) c FROM exercise_grade_calls').fetchone()['c']
        spent = db.execute("SELECT count(*) c FROM exercise_grade_calls WHERE outcome='graded'").fetchone()['c']
    # Every attempt is in the window, and only the ones that passed reached the
    # model: the quota counts attempts, the bill counts upstream calls.
    assert counted == GRADE_CALL_LIMIT + 10
    assert spent == GRADE_CALL_LIMIT


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


def test_a_readers_identity_is_hashed_not_stored(site, monkeypatch):
    """The signed-in bucket is hashed the same way, so the ledger is not a list
    of who reads what even though the unit is now an account."""
    working_model(monkeypatch)
    client = reader(site, 'alice')
    client.post(GRADE, json={'exercise': SAMPLE_ID, 'answer': 'a', 'criteria': 'c'})
    with site[0].state.db() as db:
        row = db.execute('SELECT visitor_hash FROM exercise_grade_calls').fetchone()
    assert len(row['visitor_hash']) == 64
    assert 'alice' not in row['visitor_hash']
    assert 'user:' not in row['visitor_hash']


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
    than the corpus itself without inventing ids."""
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
    # Sixty rows only exercise the ceiling while the corpus has fewer than sixty
    # exercises; past that the batch is the same size as the corpus, which is
    # still the property under test (the whole corpus fits in one request).
    count = max(60, len(ALL_PAIRS))
    response = client.post(PROGRESS, json={'items': rows(count)})
    assert response.status_code == 201
    assert response.json() == {'saved': count, 'skipped': 0}
    # The rows upsert onto the real ids; none is lost.
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
    """The end of the row-level bug: a full batch of good rows plus a score of
    1.7 used to be a 422 that lost the whole batch. The good rows are stored."""
    client = reader(site)
    good = [{'chapter': chapter, 'exercise': exercise, 'passed': 1, 'score': 0.5}
            for chapter, exercise in ALL_PAIRS]
    batch = list(good)
    batch.insert(4, {'chapter': SAMPLE_CHAPTER, 'exercise': SAMPLE_ID, 'score': 1.7})
    response = client.post(PROGRESS, json={'items': batch})
    assert response.status_code == 201
    assert response.json() == {'saved': len(ALL_PAIRS), 'skipped': 1}
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


# The shape this file's log tests cannot reach: ExerciseItem has no custom
# validator, so pydantic never fills `ctx` for it and 'input' is the only key
# carrying the reader's words. A model with a validator is the case the
# denylist shape cannot survive.
CTX_MARKER = 'SECRET-IN-CTX-MARKER'


class ValidatorModel(BaseModel):
    """A model whose only field is rejected by a custom validator.

    pydantic 2.14 puts the validator's own ValueError under `ctx`, and the
    error message under `msg`. Both can hold whatever the validator put there,
    which is why the production helper is an allowlist.
    """

    answer: str = ''

    @field_validator('answer')
    @classmethod
    def _reject(cls, value):
        raise ValueError(CTX_MARKER)


def test_the_rejection_reason_never_carries_the_validator_context():
    """Direct unit test of unreadable_row_reasons, on the `ctx` leak.

    The end-to-end tests above only exercise ExerciseItem, which has no custom
    validator -- so `ctx` is always empty and a denylist ('drop `input`') is
    indistinguishable from the allowlist. This builds the error dict that makes
    the difference: a validator that raises with a marker in its message puts
    the marker in `ctx` as well, and a denylist would log it.

    Verified against the denylist shape
    (`{k: v for k, v in detail.items() if k != 'input'}`): that keeps `ctx`
    and leaks CTX_MARKER, so this test fails if unreadable_row_reasons is ever
    weakened to it.
    """
    with pytest.raises(ValidationError) as caught:
        ValidatorModel.model_validate({'answer': 'the reader typed this'})
    reasons = unreadable_row_reasons(caught.value)
    assert len(reasons) == 1
    reason = reasons[0]
    # The two operational facts survive: which field, and which rule.
    assert reason['loc'] == ('answer',)
    assert reason['type'] == 'value_error'
    # Nothing else does. `input` is the reader's text; `msg` and `ctx` both
    # carry the validator's marker here.
    assert CTX_MARKER not in str(reason)
    assert 'the reader typed this' not in str(reason)
    assert set(reason) <= {'type', 'loc'}
    # The marker really is in the unfiltered error, so the assertion above is
    # not passing because the string never existed.
    assert CTX_MARKER in str(caught.value.errors())


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


# --- Review round 4: the grading ceiling is a ceiling on a script, not on a
# classroom behind one NAT -------------------------------------------------

def test_two_readers_behind_one_address_do_not_share_the_quota(site, monkeypatch):
    """The bug this section exists for: `distinct visitor_hash = 1` for a
    classroom. One reader working through the exercises used to lock out
    everyone else behind the same NAT, which is the failure the ceiling is
    meant to prevent rather than cause."""
    calls = []
    working_model(monkeypatch, calls)
    alice, bob = reader(site, 'alice'), reader(site, 'bob')
    body = {'exercise': SAMPLE_ID, 'answer': 'a', 'criteria': 'c'}
    # Every client here comes from the same address -- TestClient's default
    # 'testclient' -- so a shared bucket would show up immediately.
    for _ in range(GRADE_CALL_LIMIT):
        assert alice.post(GRADE, json=body).status_code == 200
    assert [bob.post(GRADE, json=body).status_code for _ in range(GRADE_CALL_LIMIT)] == [200] * GRADE_CALL_LIMIT
    with site[0].state.db() as db:
        distinct = db.execute('SELECT count(DISTINCT visitor_hash) c FROM exercise_grade_calls').fetchone()['c']
    assert distinct == 2
    assert len(calls) == 2 * GRADE_CALL_LIMIT


def test_one_reader_past_the_quota_is_still_refused(site, monkeypatch):
    """Separate buckets must not mean separate limits: one reader is still one
    reader, and their own thirty is still the ceiling."""
    calls = []
    working_model(monkeypatch, calls)
    client = reader(site, 'alice')
    body = {'exercise': SAMPLE_ID, 'answer': 'a', 'criteria': 'c'}
    for _ in range(GRADE_CALL_LIMIT):
        assert client.post(GRADE, json=body).status_code == 200
    refused = client.post(GRADE, json=body)
    assert refused.status_code == 503
    assert refused.json()['fallback'] is True
    assert len(calls) == GRADE_CALL_LIMIT


def test_a_guest_past_the_quota_is_still_refused(site, monkeypatch):
    """A guest has no identity to fall back on, so the address stays their unit
    and the ceiling applies to them exactly as before."""
    calls = []
    working_model(monkeypatch, calls)
    guest = TestClient(site[0])
    body = {'exercise': SAMPLE_ID, 'answer': 'a', 'criteria': 'c'}
    for _ in range(GRADE_CALL_LIMIT):
        assert guest.post(GRADE, json=body).status_code == 200
    assert guest.post(GRADE, json=body).status_code == 503
    assert len(calls) == GRADE_CALL_LIMIT


def test_a_guest_and_a_reader_behind_one_address_are_separate(site, monkeypatch):
    """One address, two identities: the guest keeps the address bucket and the
    reader gets their own, so exhausting the guest's allowance does not spend
    the reader's."""
    calls = []
    working_model(monkeypatch, calls)
    guest, alice = TestClient(site[0]), reader(site, 'alice')
    body = {'exercise': SAMPLE_ID, 'answer': 'a', 'criteria': 'c'}
    for _ in range(GRADE_CALL_LIMIT):
        assert guest.post(GRADE, json=body).status_code == 200
    assert guest.post(GRADE, json=body).status_code == 503
    assert alice.post(GRADE, json=body).status_code == 200
    assert len(calls) == GRADE_CALL_LIMIT + 1


def test_the_signing_in_state_does_not_change_the_guest_rule(site, monkeypatch):
    """A reader is not given a fresh allowance by dropping the cookie: the
    guest bucket is a different bucket, and it is already spent."""
    working_model(monkeypatch)
    guest, alice = TestClient(site[0]), reader(site, 'alice')
    body = {'exercise': SAMPLE_ID, 'answer': 'a', 'criteria': 'c'}
    for _ in range(GRADE_CALL_LIMIT + 1):
        guest.post(GRADE, json=body)
    assert alice.post(GRADE, json=body).status_code == 200


# --- Review round 4: the quota has to hold when the callers arrive together
# -------------------------------------------------------------------------

BURST = 40


def concurrent_burst(site, monkeypatch, burst=BURST):
    """Fire `burst` grading calls that all leave at the same instant.

    The barrier is the point. Without it the threads arrive spread out and each
    one sees the previous one's ledger row, which is why a serial client always
    saw exactly the limit and why every existing test was green against code
    that a script could beat by 2.7x.
    """
    calls = []
    working_model(monkeypatch, calls)
    body = {'exercise': SAMPLE_ID, 'answer': 'a', 'criteria': 'c'}
    statuses = []
    barrier = threading.Barrier(burst)
    lock = threading.Lock()

    def hit():
        # One client per thread: TestClient shares a portal per instance, and
        # the point of the test is to have genuinely independent callers.
        client = TestClient(site[0])
        barrier.wait()
        code = client.post(GRADE, json=body).status_code
        with lock:
            statuses.append(code)

    threads = [threading.Thread(target=hit) for _ in range(burst)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return calls, statuses


def test_a_concurrent_burst_cannot_exceed_the_quota(site, monkeypatch):
    """The number that matters: how many calls actually reached the model.

    Check-then-write was two transactions with the model call between them, so
    every caller in a burst measured itself against a count that none of them
    had yet updated. Measured against that code, a burst of 40 produced 40
    upstream calls for a limit of 30, and a burst of 80 produced 80 -- the
    ceiling that exists to stop a script from draining someone else's key was
    worth less than half of what it claimed.
    """
    calls, statuses = concurrent_burst(site, monkeypatch)
    assert len(statuses) == BURST
    assert len(calls) <= GRADE_CALL_LIMIT, 'upstream calls exceeded the quota: %d' % len(calls)
    assert statuses.count(200) == len(calls), 'only the calls that reached the model may answer 200'
    assert statuses.count(503) == BURST - len(calls)


def test_a_burst_still_serves_the_first_callers(site, monkeypatch):
    """Atomicity must not become a queue that refuses everyone: the limit is a
    ceiling, not a switch."""
    calls, statuses = concurrent_burst(site, monkeypatch)
    assert statuses.count(200) == GRADE_CALL_LIMIT


def test_every_burst_call_is_recorded_at_most_once(site, monkeypatch):
    """Both halves of the merge, asserted as the two numbers they actually are.

    The upstream count is an equality, because that is what the ceiling
    promises: a burst spends the limit and not one call more. Asserting
    `rows == BURST` instead asserted something the implementation deliberately
    does not promise. A claim that cannot be written -- SQLITE_READONLY under a
    saturated WAL -- is NOT recorded, because a call that cannot be counted
    cannot be charged a slot either, and the caller is degraded to 503 instead
    of reaching the model unmetered. The ledger is therefore an upper bound on
    attempts, and under a burst it is routinely one or two rows short of the
    attempt count. Asserting equality there tested the absence of the fallback
    rather than the ceiling, and failed about one run in four.

    What is still exact is the pairing: every call that reached the model has a
    settled 'graded' row, every refusal is a row of its own, and no caller
    appears twice. That is the property the merge introduced.
    """
    calls, statuses = concurrent_burst(site, monkeypatch)
    with site[0].state.db() as db:
        rows = db.execute('SELECT count(*) c FROM exercise_grade_calls').fetchone()['c']
        duplicates = db.execute('SELECT count(*) c FROM (SELECT id FROM exercise_grade_calls GROUP BY id HAVING count(*)>1)').fetchone()['c']
        graded = db.execute("SELECT count(*) c FROM exercise_grade_calls WHERE outcome='graded'").fetchone()['c']
        refused = db.execute("SELECT count(*) c FROM exercise_grade_calls WHERE outcome='refused'").fetchone()['c']
    assert len(calls) == GRADE_CALL_LIMIT, 'a burst must spend exactly the ceiling: %d' % len(calls)
    assert statuses.count(200) == len(calls), 'only the calls that reached the model may answer 200'
    assert rows <= BURST, 'the ledger must not invent attempts: %d' % rows
    assert rows >= GRADE_CALL_LIMIT, 'every call that reached the model claimed a row first'
    assert duplicates == 0
    # No row is left dangling in 'claimed': every recorded attempt was settled
    # into one of the two terminal outcomes.
    assert graded + refused == rows
    assert graded == len(calls)
    # Every refusal was served as a 503. Any 503 beyond that count is a caller
    # the ledger could not record, which is the fallback doing its job.
    assert refused <= statuses.count(503)


class _Connection:
    """What app.db() needs from a connection, so a test can break one part.

    The proxy opens the same file the app uses -- the path is taken from the
    call arguments -- so the schema is really there and only the one statement
    under test fails.
    """

    def __init__(self, path, *args, **kwargs):
        # Captured before any monkeypatching: app.sqlite3 IS this module's
        # sqlite3, so patching connect to return a proxy would otherwise make
        # the proxy's own connect call recurse into itself.
        self._inner = REAL_CONNECT(path, *args, **kwargs)

    # app.db() assigns row_factory on the object connect() returned, so an
    # attribute stored on the proxy would leave the real connection using
    # sqlite3's default row tuples. Every app query indexes rows by name, and
    # the failure would be a TypeError from inside the test double -- which
    # looks exactly like a production bug and sends the next reader looking in
    # app.py instead of here. Forwarded, not copied, so the assignment and any
    # later read agree with the connection that actually runs the query.
    @property
    def row_factory(self):
        return self._inner.row_factory

    @row_factory.setter
    def row_factory(self, value):
        self._inner.row_factory = value

    @property
    def isolation_level(self):
        return self._inner.isolation_level

    @isolation_level.setter
    def isolation_level(self, value):
        self._inner.isolation_level = value

    @property
    def in_transaction(self):
        return self._inner.in_transaction

    def execute(self, statement, *rest):
        return self._inner.execute(statement, *rest)

    def executemany(self, statement, *rest):
        return self._inner.executemany(statement, *rest)

    def executescript(self, statement):
        return self._inner.executescript(statement)

    def commit(self):
        return self._inner.commit()

    def rollback(self):
        return self._inner.rollback()

    def close(self):
        self._inner.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self._inner.__exit__(*exc)

    def _write(self, statement):
        raise NotImplementedError


class RefusesWrites(_Connection):
    """Every transaction fails the way a saturated WAL does."""

    def execute(self, statement, *rest):
        if statement.lstrip().upper().startswith(('BEGIN', 'INSERT', 'UPDATE', 'DELETE')):
            self._write(statement)
        return self._inner.execute(statement, *rest)

    def _write(self, statement):
        raise sqlite3.OperationalError('attempt to write a readonly database')


class FailsSettle(_Connection):
    """The claim succeeds; the later UPDATE that settles it does not."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.writes = 0

    def execute(self, statement, *rest):
        if statement.lstrip().upper().startswith(('BEGIN', 'INSERT', 'UPDATE', 'DELETE')):
            self.writes += 1
            if statement.lstrip().upper().startswith('UPDATE'):
                self._write(statement)
        return self._inner.execute(statement, *rest)

    def _write(self, statement):
        raise sqlite3.OperationalError('attempt to write a readonly database')


def test_a_call_the_ledger_cannot_record_is_not_graded(site, monkeypatch):
    """A caller that cannot be counted must not reach the model.

    Under load SQLite refuses a write with SQLITE_READONLY rather than
    SQLITE_BUSY -- a WAL recovery race, not lock contention -- so the
    connection's timeout does not apply and the write fails at once. Measured
    here, it surfaced as a 500 on the one endpoint whose contract is that it
    never fails a learner. An unrecorded call is an unmetered call, which is
    what this ledger exists to prevent, so it degrades instead.
    """
    calls = []
    working_model(monkeypatch, calls)
    monkeypatch.setattr('app.sqlite3.connect', lambda *a, **k: RefusesWrites(*a, **k))
    response = TestClient(site[0]).post(GRADE, json={'exercise': SAMPLE_ID, 'answer': 'a', 'criteria': 'c'})
    assert response.status_code == 503
    assert response.json()['fallback'] is True
    assert calls == [], 'a call the ledger cannot record must not reach the model'


def test_a_call_the_ledger_cannot_settle_still_answers(site, monkeypatch, caplog):
    """The mirror image: once the model has answered, the learner gets the
    score even if the bookkeeping write fails. The row stays 'claimed', which
    still consumed the quota -- the safe direction to be short in."""
    caplog.set_level(logging.INFO, logger='app')
    calls = []
    working_model(monkeypatch, calls)
    monkeypatch.setattr('app.sqlite3.connect', lambda *a, **k: FailsSettle(*a, **k))
    response = TestClient(site[0]).post(GRADE, json={'exercise': SAMPLE_ID, 'answer': 'a', 'criteria': 'c'})
    assert response.status_code == 200
    assert response.json() == {'score': 0.5, 'feedback': 'ok'}
    assert 'Could not settle a grading call in the ledger' in captured_log(caplog)


