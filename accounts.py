"""Email/password accounts, stored in PostgreSQL (SQLite is supported for tests)."""
from contextlib import contextmanager
import hashlib
import hmac
import logging
import secrets
import sqlite3
import threading
import time
from pathlib import Path

try:
    import psycopg
except ImportError:
    psycopg = None

LOGGER = logging.getLogger(__name__)

SCRYPT_N = 2 ** 14
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_DKLEN = 32
SCRYPT_MAXMEM = 64 * 1024 * 1024

ACCOUNTS_SCHEMA = '''
CREATE TABLE IF NOT EXISTS accounts(
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'reader',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  last_login_at BIGINT
)
'''

# Verifying against a real hash for unknown addresses keeps the failure path's
# timing close to a wrong password; a fast "no such user" is an account oracle.
DUMMY_HASH = None


def normalize_email(value):
    return str(value or '').strip().lower()[:254]


def hash_password(password):
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(
        password.encode('utf-8'), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P,
        maxmem=SCRYPT_MAXMEM, dklen=SCRYPT_DKLEN,
    )
    return f'scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${salt.hex()}${digest.hex()}'


def verify_password(password, encoded):
    try:
        algorithm, n, r, p, salt, expected = str(encoded).split('$')
        if algorithm != 'scrypt':
            return False
        raw_expected = bytes.fromhex(expected)
        digest = hashlib.scrypt(
            password.encode('utf-8'), salt=bytes.fromhex(salt), n=int(n), r=int(r), p=int(p),
            maxmem=SCRYPT_MAXMEM, dklen=len(raw_expected),
        )
        return hmac.compare_digest(digest, raw_expected)
    except (TypeError, ValueError, OverflowError):
        return False


def _dummy_hash():
    global DUMMY_HASH
    if DUMMY_HASH is None:
        DUMMY_HASH = hash_password(secrets.token_urlsafe(24))
    return DUMMY_HASH


class AccountsStore:
    """Account rows plus a seeded administrator; one connection per operation."""

    def __init__(self, dsn, admin_email='', admin_password='', admin_name='管理员'):
        dsn = str(dsn or '').strip()
        if dsn.startswith(('postgresql://', 'postgres://')):
            self.backend = 'postgres'
            self.dsn = dsn
            self.sqlite_path = None
        elif dsn.startswith('sqlite:///'):
            self.backend = 'sqlite'
            self.dsn = None
            self.sqlite_path = Path(dsn[len('sqlite:///'):])
        else:
            raise ValueError('DATABASE_URL must start with postgresql://, postgres:// or sqlite:///')
        self.admin_email = normalize_email(admin_email)
        self.admin_password = str(admin_password or '')
        self.admin_name = str(admin_name or '管理员')[:100]
        self._ready = False
        self._lock = threading.Lock()

    def _q(self, sql):
        return sql.replace('?', '%s') if self.backend == 'postgres' else sql

    @contextmanager
    def _db(self):
        if self.backend == 'postgres':
            if psycopg is None:
                raise RuntimeError('psycopg is required for a PostgreSQL DATABASE_URL')
            from psycopg.rows import dict_row
            conn = psycopg.connect(self.dsn, connect_timeout=5, row_factory=dict_row)
        else:
            self.sqlite_path.parent.mkdir(parents=True, exist_ok=True)
            conn = sqlite3.connect(self.sqlite_path, timeout=15)
            conn.row_factory = sqlite3.Row
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def ensure_ready(self):
        if self._ready:
            return
        with self._lock:
            if self._ready:
                return
            with self._db() as conn:
                conn.execute(self._q(ACCOUNTS_SCHEMA))
                if self.admin_email and self.admin_password:
                    now = int(time.time())
                    conn.execute(
                        self._q('''INSERT INTO accounts(id,email,password_hash,display_name,role,is_active,created_at,updated_at)
                           VALUES(?,?,?,?,?,1,?,?)
                           ON CONFLICT(email) DO UPDATE SET role='admin', is_active=1, updated_at=excluded.updated_at'''),
                        (secrets.token_hex(16), self.admin_email, hash_password(self.admin_password),
                         self.admin_name, 'admin', now, now),
                    )
            self._ready = True

    def authenticate(self, email, password):
        self.ensure_ready()
        email = normalize_email(email)
        if not email or not password or len(password) > 200:
            return None
        with self._db() as conn:
            row = conn.execute(
                self._q('SELECT id,email,password_hash,display_name,role,is_active FROM accounts WHERE email=?'),
                (email,),
            ).fetchone()
            if not row:
                verify_password(password, _dummy_hash())
                return None
            account = dict(row)
            if not verify_password(password, account['password_hash']) or not int(account['is_active']):
                return None
            now = int(time.time())
            conn.execute(
                self._q('UPDATE accounts SET last_login_at=?, updated_at=? WHERE id=?'),
                (now, now, account['id']),
            )
        account['last_login_at'] = now
        account['role'] = 'admin' if account['role'] == 'admin' else 'reader'
        return account

    def has_account(self, email):
        self.ensure_ready()
        with self._db() as conn:
            row = conn.execute(
                self._q('SELECT 1 FROM accounts WHERE email=?'), (normalize_email(email),)
            ).fetchone()
        return row is not None


class LoginLimiter:
    """Small in-process failure window for the login endpoint."""

    def __init__(self, limit=10, window=60):
        self.limit = limit
        self.window = window
        self.failures = {}
        self.lock = threading.Lock()

    def _recent(self, key, now):
        values = [stamp for stamp in self.failures.get(key, ()) if now - stamp < self.window]
        if values:
            self.failures[key] = values
        else:
            self.failures.pop(key, None)
        return values

    def blocked(self, key):
        now = time.monotonic()
        with self.lock:
            return len(self._recent(key, now)) >= self.limit

    def fail(self, key):
        now = time.monotonic()
        with self.lock:
            self.failures[key] = self._recent(key, now) + [now]

    def clear(self, key):
        with self.lock:
            self.failures.pop(key, None)
