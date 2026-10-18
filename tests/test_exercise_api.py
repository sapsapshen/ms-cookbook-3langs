import base64
import json
import time
import pytest
from fastapi.testclient import TestClient
from itsdangerous import TimestampSigner
from app import create_app

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
