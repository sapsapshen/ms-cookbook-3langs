import time

import pytest
from fastapi.testclient import TestClient

from accounts import AccountsStore, hash_password, verify_password
from app import create_app

BASE = 'http://127.0.0.1:7860'
ADMIN_EMAIL = 'admin@example.com'
ADMIN_PASSWORD = 'correct-horse-battery-staple'


def sqlite_url(path):
    return 'sqlite:///' + path.as_posix()


@pytest.fixture
def site(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_BASE_URL', BASE)
    monkeypatch.delenv('OAUTH_CLIENT_ID', raising=False)
    monkeypatch.delenv('OAUTH_CLIENT_SECRET', raising=False)
    monkeypatch.setenv('DATABASE_URL', sqlite_url(tmp_path / 'accounts.sqlite3'))
    monkeypatch.setenv('LOCAL_ADMIN_EMAIL', ADMIN_EMAIL)
    monkeypatch.setenv('LOCAL_ADMIN_PASSWORD', ADMIN_PASSWORD)
    monkeypatch.setenv('LOCAL_ADMIN_NAME', '管理员')
    return create_app(tmp_path), tmp_path


def login(client, email=ADMIN_EMAIL, password=ADMIN_PASSWORD, return_to='#home'):
    return client.post('/api/auth/login', json={
        'email': email, 'password': password, 'return_to': return_to,
    }, headers={'origin': BASE})


def test_password_hash_roundtrip():
    encoded = hash_password(ADMIN_PASSWORD)
    assert encoded.startswith('scrypt$')
    assert verify_password(ADMIN_PASSWORD, encoded)
    assert not verify_password('wrong', encoded)
    assert not verify_password(ADMIN_PASSWORD, 'not-a-hash')


def test_seeded_admin_can_login_and_is_moderator(site):
    client = TestClient(site[0], base_url=BASE)
    state = client.get('/api/session').json()
    assert state['loginEnabled'] is True
    assert state['localLoginEnabled'] is True
    page = client.get('/auth/login?return_to=%23chapter-1')
    assert page.status_code == 200
    assert 'loginEmail' in page.text
    response = login(client, return_to='#chapter-1')
    assert response.status_code == 200
    assert response.json()['return_to'] == '/#chapter-1'
    current = client.get('/api/session').json()
    assert current['user']['name'] == '管理员'
    assert current['user']['moderator'] is True
    assert current['csrf']


def test_login_rejects_wrong_password_origin_and_missing_fields(site):
    client = TestClient(site[0], base_url=BASE)
    assert client.post('/api/auth/login', json={
        'email': ADMIN_EMAIL, 'password': ADMIN_PASSWORD, 'return_to': '#home',
    }, headers={'origin': 'https://evil.example'}).status_code == 403
    assert login(client, password='wrong').status_code == 401
    assert client.post('/api/auth/login', json={
        'email': '', 'password': '', 'return_to': '#home',
    }, headers={'origin': BASE}).status_code == 422


def test_login_is_rate_limited(site):
    client = TestClient(site[0], base_url=BASE)
    for _ in range(10):
        assert login(client, password='wrong').status_code == 401
    assert login(client, password='wrong').status_code == 429
    assert login(client).status_code == 429


def test_session_survives_restart_and_admin_can_delete_another_users_entry(site):
    app, path = site
    with app.state.db() as db:
        db.execute(
            'INSERT INTO users(id,sub,name,role) VALUES (?,?,?,?)',
            ('bob', 'sub-bob', 'bob', 'reader'),
        )
        db.execute(
            'INSERT INTO entries VALUES (?,?,?,?,?,?,?,?,?,?)',
            ('bob-entry', 'chapter-1', 'bob', 'comment', 'hello', '', 0, 0, 0, int(time.time())),
        )
    client = TestClient(app, base_url=BASE)
    assert login(client).status_code == 200
    page = client.get('/api/chapters/chapter-1/entries').json()
    item = next(entry for entry in page['items'] if entry['id'] == 'bob-entry')
    assert item['canDelete'] is True
    csrf = client.get('/api/session').json()['csrf']
    response = client.delete('/api/entries/bob-entry', headers={'x-csrf-token': csrf, 'origin': BASE})
    assert response.status_code == 200

    cookie = client.cookies.get('purplebook_session')
    restarted = TestClient(create_app(path), base_url=BASE)
    restarted.cookies.set('purplebook_session', cookie)
    assert restarted.get('/api/session').json()['user']['moderator'] is True


def test_seed_does_not_reset_an_existing_password(site, monkeypatch):
    original = site[1]
    monkeypatch.setenv('DATABASE_URL', sqlite_url(original / 'accounts.sqlite3'))
    monkeypatch.setenv('LOCAL_ADMIN_PASSWORD', 'different-password')
    restarted = TestClient(create_app(original), base_url=BASE)
    assert login(restarted, password=ADMIN_PASSWORD).status_code == 200
    assert login(restarted, password='different-password').status_code == 401


def test_inactive_account_cannot_login(tmp_path):
    store = AccountsStore(
        sqlite_url(tmp_path / 'accounts.sqlite3'),
        admin_email=ADMIN_EMAIL, admin_password=ADMIN_PASSWORD,
    )
    store.ensure_ready()
    assert store.authenticate(ADMIN_EMAIL, ADMIN_PASSWORD)['role'] == 'admin'
    with store._db() as db:
        db.execute('UPDATE accounts SET is_active=0')
    assert store.authenticate(ADMIN_EMAIL, ADMIN_PASSWORD) is None
