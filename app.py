"""Reading community API and static site; OAuth credentials never leave this process."""
from contextlib import asynccontextmanager, closing, contextmanager
from datetime import datetime, timedelta
import hashlib
import hmac
import httpx
import json
import logging
import os
import secrets
import shutil
import sqlite3
import threading
import time
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

from authlib.integrations.starlette_client import OAuth, OAuthError
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse
from typing import Any

from pydantic import BaseModel, Field, ValidationError
from starlette.middleware.sessions import SessionMiddleware
from starlette.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
LOGGER = logging.getLogger(__name__)

ANALYTICS_SCHEMA = '''
CREATE TABLE IF NOT EXISTS analytics_page_daily(day TEXT NOT NULL, page TEXT NOT NULL, pv INTEGER NOT NULL DEFAULT 0 CHECK(pv >= 0), PRIMARY KEY(day, page));
CREATE TABLE IF NOT EXISTS analytics_visitor_daily(day TEXT NOT NULL, page TEXT NOT NULL, visitor_hash TEXT NOT NULL, PRIMARY KEY(day, page, visitor_hash));
CREATE INDEX IF NOT EXISTS analytics_visitors_page_day ON analytics_visitor_daily(page, day);
CREATE TABLE IF NOT EXISTS analytics_visitor_all_time(visitor_hash TEXT PRIMARY KEY, first_day TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS analytics_site_hourly(hour TEXT PRIMARY KEY, pv INTEGER NOT NULL DEFAULT 0 CHECK(pv >= 0));
CREATE TABLE IF NOT EXISTS analytics_visitor_hourly(hour TEXT NOT NULL, visitor_hash TEXT NOT NULL, PRIMARY KEY(hour, visitor_hash));
CREATE INDEX IF NOT EXISTS analytics_visitors_hour ON analytics_visitor_hourly(hour);
'''

# The progress table's column list is one string because migrate_exercise_progress
# has to rebuild the table to change a column's type. `self_assessed` stores the
# client's three states verbatim: the learning map counts anything that is not
# 'fail' as self-assessed progress, so collapsing 'fail' into a truthy value
# reports work the reader explicitly said they did not understand.
EXERCISE_PROGRESS_COLUMNS = '''id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  chapter TEXT NOT NULL,
  exercise TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  passed INTEGER NOT NULL DEFAULT 0 CHECK(passed IN (0,1)),
  score REAL NOT NULL DEFAULT 0,
  self_assessed TEXT NOT NULL DEFAULT '' CHECK(self_assessed IN ('','pass','partial','fail')),
  attempts INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL,
  UNIQUE(user_id, chapter, exercise)'''

SELF_ASSESSMENT_STATES = ('', 'pass', 'partial', 'fail')

# `updated` is unix SECONDS at both ends of the sync boundary. 10**12 seconds is
# the year 33658 and 10**12 milliseconds is 2001-09-09, so any value at or above
# the floor is milliseconds for the next three centuries -- magnitude is a safe
# discriminator here even though it is not one in general.
MILLISECOND_STAMP_FLOOR = 10 ** 12


def second_stamp(value):
    """Fold a millisecond timestamp into seconds; leave a second stamp alone."""
    return value // 1000 if value >= MILLISECOND_STAMP_FLOOR else value


def self_assessment_state(value):
    """Fold an incoming self-assessment into one of the three storable states.

    The client writes 'pass' / 'partial' / 'fail' / '' and those cross the wire
    unchanged. Anything else is dropped to '' rather than rejected: a batch is
    all-or-nothing, so refusing an unknown token would also refuse to sync every
    other exercise in the same request -- and the token cannot be mapped onto a
    state anyway, because the two-state build read every assessment back as
    'graded', which cannot be told apart from a genuine 'pass'. Claiming a pass
    the learner never gave is the one error they cannot notice, so the claim is
    discarded instead.
    """
    return value if value in SELF_ASSESSMENT_STATES else ''


def migrate_exercise_progress(conn):
    """Rebuild `exercise_progress` when it still carries the two-state column.

    `CREATE TABLE IF NOT EXISTS` leaves an existing table alone, so a database
    written before the three-state fix still declares
    `self_assessed INTEGER CHECK(self_assessed IN (0,1))`. The test is on the
    declared column type, not on stored data: a legacy row cannot be inverted
    back into three states, because 1 stands for 'pass', 'partial' and 'fail'
    alike, so both 0 and 1 migrate to '' (not self-assessed). Mapping 1 to
    'pass' would preserve the original defect for every existing reader, while
    '' is recoverable -- the learner states it again on the device that still
    has it, and passed/score/code/attempts/updated carry over untouched.
    """
    columns = {row['name']: row['type'] for row in conn.execute('PRAGMA table_info(exercise_progress)')}
    if columns.get('self_assessed') == 'TEXT': return
    # `executescript` is safe here because it runs this script's own
    # BEGIN IMMEDIATE/COMMIT: sqlite3 commits any pending outer transaction
    # before executing the script and runs the DDL outside `with conn`, so the
    # enclosing transaction cannot be left half-open and the rebuild is atomic in
    # its own right. The dependency to avoid is the reverse order -- writing a
    # row through `conn.execute` first and *then* calling this would commit that
    # row at the implicit commit and mix it into the rebuild, so a failure below
    # would leave the row durable against the old table. Call this before any
    # row-level work in the same `with db()` block, which is what create_app does.
    conn.executescript(f'''
    BEGIN IMMEDIATE;
    CREATE TABLE exercise_progress_migrated({EXERCISE_PROGRESS_COLUMNS});
    INSERT INTO exercise_progress_migrated(id,user_id,chapter,exercise,code,passed,score,self_assessed,attempts,updated)
      SELECT id,user_id,chapter,exercise,code,passed,score,'',attempts,updated FROM exercise_progress;
    DROP TABLE exercise_progress;
    ALTER TABLE exercise_progress_migrated RENAME TO exercise_progress;
    CREATE INDEX IF NOT EXISTS exercise_progress_user ON exercise_progress(user_id, updated);
    COMMIT;''')

class Entry(BaseModel):
    kind: str
    text: str = Field(default='', max_length=2000)
    quote: str = Field(default='', max_length=2000)
    block: int = Field(default=0, ge=0, le=100000)
    start: int = Field(default=0, ge=0, le=1000000)
    end: int = Field(default=0, ge=0, le=1000000)

class Wish(BaseModel):
    text: str = Field(max_length=2000)

class AnalyticsView(BaseModel):
    page: str = Field(min_length=1, max_length=64)
    visitor: str = Field(min_length=16, max_length=128, pattern=r'^[A-Za-z0-9_-]+$')

class ExerciseItem(BaseModel):
    chapter: str = Field(min_length=1, max_length=64)
    exercise: str = Field(min_length=1, max_length=64)
    passed: int = Field(default=0)
    score: float = Field(default=0, ge=0, le=1)
    code: str = Field(default='', max_length=20000)
    selfAssessed: str = Field(default='', max_length=16)
    attempts: int = Field(default=0, ge=0)
    updated: int = Field(default=0, ge=0)

class ExerciseProgress(BaseModel):
    """A sync batch. `max_length` is a ceiling on one request body, not a limit on
    how much progress a reader may hold: the corpus plans 100+ exercises and a
    reader who has worked through them has to be able to say so in one request."""
    items: list[ExerciseItem] = Field(default_factory=list, max_length=1000)

class ExerciseGrade(BaseModel):
    exercise: str = Field(min_length=1, max_length=64)
    answer: str = Field(default='', max_length=8000)
    criteria: str = Field(default='', max_length=2000)


def create_app(data_dir=None, analytics_runtime_dir=None):
    folder = Path(data_dir or os.getenv('DATA_DIR', ROOT / '.data'))
    folder.mkdir(parents=True, exist_ok=True)
    db_path = folder / 'reading.sqlite3'
    persistent_analytics_path = folder / 'analytics.sqlite3'
    previous_analytics_path = folder / 'analytics.previous.sqlite3'
    if analytics_runtime_dir:
        analytics_runtime = Path(analytics_runtime_dir)
    elif data_dir is not None:
        analytics_runtime = folder / '.analytics-runtime'
    else:
        analytics_runtime = Path(os.getenv('ANALYTICS_RUNTIME_DIR', '/tmp/purplebook-analytics'))
    analytics_runtime.mkdir(parents=True, exist_ok=True)
    analytics_path = analytics_runtime / 'analytics.sqlite3'
    last_snapshot_path = analytics_runtime / 'analytics.last-snapshot.sqlite3'
    analytics_snapshot_lock = threading.Lock()
    analytics_repair_lock = threading.Lock()
    analytics_snapshot_state = {'generation': 0, 'persisted': 0, 'last': 0.0}
    @contextmanager
    def db():
        conn = sqlite3.connect(db_path, timeout=15)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys=ON')
        try:
            with conn: yield conn
        finally:
            conn.close()
    with db() as conn:
        conn.executescript('''
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, sub TEXT UNIQUE NOT NULL, name TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS entries(id TEXT PRIMARY KEY, chapter TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), kind TEXT NOT NULL, text TEXT NOT NULL, quote TEXT NOT NULL, block INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, created INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS entries_chapter ON entries(chapter, created);
        CREATE INDEX IF NOT EXISTS entries_user_time ON entries(user_id, created);
        CREATE TABLE IF NOT EXISTS wishes(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), text TEXT NOT NULL, created INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS wishes_user_time ON wishes(user_id, created);
        CREATE TABLE IF NOT EXISTS exercise_progress_writes(id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), created INTEGER NOT NULL);
        CREATE INDEX IF NOT EXISTS exercise_progress_writes_user ON exercise_progress_writes(user_id, created);
        ''')
        # IF NOT EXISTS cannot widen an existing column, so the schema above is
        # only the shape a fresh database gets; deployed ones are rebuilt here.
        conn.execute(f'CREATE TABLE IF NOT EXISTS exercise_progress({EXERCISE_PROGRESS_COLUMNS})')
        conn.execute('CREATE INDEX IF NOT EXISTS exercise_progress_user ON exercise_progress(user_id, updated)')
        migrate_exercise_progress(conn)

    @contextmanager
    def analytics_db():
        conn = sqlite3.connect(analytics_path, timeout=5)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA busy_timeout=5000')
        try:
            with conn: yield conn
        finally:
            conn.close()

    def analytics_corruption(error):
        message = str(error).lower()
        return any(marker in message for marker in ('malformed', 'file is not a database', 'database disk image'))

    def check_analytics_database(path):
        # `with sqlite3.connect(...)` only commits; it leaves the file handle open,
        # and Windows refuses to replace or delete a file that is still held open.
        with closing(sqlite3.connect(path, timeout=5)) as conn, conn:
            result = conn.execute('PRAGMA quick_check').fetchone()[0]
        if result != 'ok': raise sqlite3.DatabaseError(result)

    def remove_runtime_database():
        for sidecar in ('', '-wal', '-shm', '-journal'):
            path = Path(str(analytics_path) + sidecar)
            if path.exists(): path.unlink()

    def copy_sqlite_database(source, destination):
        temporary = analytics_runtime / f'.restore-{secrets.token_hex(6)}.sqlite3'
        try:
            uri = f'file:{source.resolve()}?mode=ro'
            with closing(sqlite3.connect(uri, uri=True, timeout=10)) as source_db, source_db, \
                    closing(sqlite3.connect(temporary)) as target_db, target_db:
                source_db.backup(target_db)
            check_analytics_database(temporary)
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary.replace(destination)
        finally:
            if temporary.exists(): temporary.unlink()

    def quarantine_persistent_database(source, error):
        suffix = f'{int(time.time())}-{secrets.token_hex(4)}'
        backup = folder / f'{source.stem}.corrupt-{suffix}.sqlite3'
        for sidecar in ('', '-wal', '-shm', '-journal'):
            path = Path(str(source) + sidecar)
            if path.exists(): path.replace(Path(str(backup) + sidecar))
        LOGGER.error('Quarantined corrupted analytics snapshot at %s: %s', backup, error)

    def restore_analytics_database():
        remove_runtime_database()
        for source in (persistent_analytics_path, previous_analytics_path):
            if not source.exists(): continue
            try:
                copy_sqlite_database(source, analytics_path)
                LOGGER.info('Restored analytics runtime database from %s', source)
                return True
            except sqlite3.DatabaseError as error:
                if not analytics_corruption(error): raise
                quarantine_persistent_database(source, error)
        return False

    def initialize_analytics_database():
        with analytics_db() as conn:
            result = conn.execute('PRAGMA quick_check').fetchone()[0]
            if result != 'ok': raise sqlite3.DatabaseError(result)
            # SQLite runs on the container's local filesystem. Consistent database
            # snapshots are copied to the Studio's object-backed persistent mount.
            conn.execute('PRAGMA journal_mode=WAL').fetchone()
            conn.execute('PRAGMA synchronous=FULL')
            conn.executescript(ANALYTICS_SCHEMA)
            conn.execute('''
                INSERT OR IGNORE INTO analytics_visitor_all_time(visitor_hash,first_day)
                SELECT visitor_hash,MIN(day) FROM analytics_visitor_daily
                WHERE page='__site__' GROUP BY visitor_hash
            ''')

    def quarantine_runtime_database(error):
        suffix = f'{int(time.time())}-{secrets.token_hex(4)}'
        backup = folder / f'analytics.corrupt-{suffix}.sqlite3'
        if analytics_path.exists():
            temporary = folder / f'.analytics-corrupt-{secrets.token_hex(6)}.tmp'
            shutil.copyfile(analytics_path, temporary)
            temporary.replace(backup)
        remove_runtime_database()
        LOGGER.error('Quarantined corrupted analytics runtime database at %s: %s', backup, error)

    def durable_copy(source, destination):
        temporary = folder / f'.{destination.name}-{secrets.token_hex(6)}.tmp'
        try:
            with source.open('rb') as input_file, temporary.open('wb') as output_file:
                shutil.copyfileobj(input_file, output_file, 1024 * 1024)
                output_file.flush()
                os.fsync(output_file.fileno())
            temporary.replace(destination)
        finally:
            if temporary.exists(): temporary.unlink()

    def snapshot_analytics_database(force=False):
        with analytics_snapshot_lock:
            generation = analytics_snapshot_state['generation']
            if generation == analytics_snapshot_state['persisted'] and persistent_analytics_path.exists(): return False
            if not force and time.monotonic() - analytics_snapshot_state['last'] < 15: return False
            snapshot = analytics_runtime / f'.snapshot-{secrets.token_hex(6)}.sqlite3'
            try:
                with closing(sqlite3.connect(analytics_path, timeout=5)) as source_db, source_db, \
                        closing(sqlite3.connect(snapshot)) as target_db, target_db:
                    source_db.backup(target_db)
                check_analytics_database(snapshot)
                if last_snapshot_path.exists(): durable_copy(last_snapshot_path, previous_analytics_path)
                durable_copy(snapshot, persistent_analytics_path)
                snapshot.replace(last_snapshot_path)
                analytics_snapshot_state['persisted'] = generation
                analytics_snapshot_state['last'] = time.monotonic()
                return True
            finally:
                if snapshot.exists(): snapshot.unlink()

    restored = restore_analytics_database()
    try:
        initialize_analytics_database()
    except sqlite3.DatabaseError as error:
        if not analytics_corruption(error): raise
        quarantine_runtime_database(error)
        restored = restore_analytics_database()
        if not restored: remove_runtime_database()
        initialize_analytics_database()
    analytics_snapshot_state['generation'] = 1
    try:
        snapshot_analytics_database(force=True)
        # Persist the first real view immediately after a container starts.
        analytics_snapshot_state['last'] = 0.0
    except (OSError, sqlite3.DatabaseError):
        LOGGER.exception('Could not persist the initial analytics snapshot')
    key_path = folder / 'session.key'
    if not key_path.exists():
        try:
            with key_path.open('x') as f: f.write(secrets.token_hex(32))
            key_path.chmod(0o600)
        except FileExistsError: pass
    base = os.getenv('APP_BASE_URL') or ('https://' + os.environ['STUDIO_HOST'] if os.getenv('STUDIO_HOST') else 'http://127.0.0.1:7860')
    parsed = urlparse(base)
    if parsed.scheme not in ('https', 'http') or not parsed.netloc or parsed.path not in ('', '/'):
        raise RuntimeError('APP_BASE_URL must be an origin without a path')
    if parsed.scheme != 'https' and parsed.hostname not in ('127.0.0.1', 'localhost'):
        raise RuntimeError('Public OAuth deployments require HTTPS')
    base = base.rstrip('/')

    @asynccontextmanager
    async def lifespan(_app):
        yield
        try:
            snapshot_analytics_database(force=True)
        except (OSError, sqlite3.DatabaseError):
            LOGGER.exception('Could not persist analytics during shutdown')

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    session_secret = os.getenv('SESSION_SECRET') or key_path.read_text()
    app.add_middleware(SessionMiddleware, secret_key=session_secret, session_cookie='purplebook_session', max_age=7*86400, same_site='lax', https_only=parsed.scheme=='https')
    oauth = OAuth()
    enabled = bool(os.getenv('OAUTH_CLIENT_ID') and os.getenv('OAUTH_CLIENT_SECRET'))
    if enabled:
        # Studio can inject an internal issuer alias. Use the verified public
        # ModelScope discovery endpoint so redirects remain browser-accessible.
        provider = 'https://www.modelscope.cn'
        oauth.register(name='modelscope', client_id=os.environ['OAUTH_CLIENT_ID'], client_secret=os.environ['OAUTH_CLIENT_SECRET'], server_metadata_url=provider+'/.well-known/openid-configuration', client_kwargs={'scope':'openid profile'})
    raw = (ROOT / 'assets/content.js').read_text().split('=',1)[1].strip().rstrip(';')
    book_data = json.loads(raw)
    # Keep notes attached to their original article when display numbers change.
    chapters = {c['id']: c.get('discussionId', c['id']) for c in book_data['chapters'] if c.get('status') != 'pending'}
    # A progress row is only meaningful for an exercise the reader can actually open,
    # so the index is filtered by the same open-chapter map: a pending chapter is not
    # writable progress, only invisible content.
    exercise_raw = (ROOT / 'assets/exercises.js').read_text(encoding='utf-8').split('=',1)[1].strip().rstrip(';')
    exercise_data = json.loads(exercise_raw)
    exercise_index = {cid: {item['id'] for item in chapter['exercises']['zh']} for cid, chapter in exercise_data['chapters'].items()}
    exercise_index = {cid: ids for cid, ids in exercise_index.items() if cid in chapters}
    exercise_ids = set().union(*exercise_index.values()) if exercise_index else set()
    admins = set(filter(None, os.getenv('MODERATOR_SUBS','').split(',')))
    analytics_pages = {'home','contents','paths','practice','contribute'} | {c['id'] for c in book_data['chapters']}
    analytics_titles = {'home':'首页','contents':'全书目录','paths':'阅读路径','practice':'真实任务库','contribute':'社区共建'}
    analytics_titles.update({c['id']:c['title'] for c in book_data['chapters']})
    analytics_timezone = ZoneInfo('Asia/Shanghai')
    analytics_lock = threading.Lock()
    analytics_cleanup_day = {'value': ''}

    def repair_analytics_database(original_error):
        if not analytics_corruption(original_error): raise original_error
        with analytics_repair_lock:
            try:
                check_analytics_database(analytics_path)
                return
            except sqlite3.DatabaseError as error:
                if not analytics_corruption(error): raise
                current_error = error
            quarantine_runtime_database(current_error)
            restored = restore_analytics_database()
            if not restored: remove_runtime_database()
            initialize_analytics_database()
            with analytics_snapshot_lock:
                analytics_snapshot_state['generation'] += 1
            snapshot_analytics_database(force=True)

    def use_analytics_database(operation):
        try:
            return operation()
        except sqlite3.DatabaseError as error:
            if not analytics_corruption(error):
                raise HTTPException(503, '统计服务暂时不可用，请稍后重试') from error
            try:
                repair_analytics_database(error)
                return operation()
            except sqlite3.DatabaseError as retry_error:
                raise HTTPException(503, '统计服务暂时不可用，请稍后重试') from retry_error

    def mark_analytics_dirty():
        with analytics_snapshot_lock:
            analytics_snapshot_state['generation'] += 1
        try:
            snapshot_analytics_database()
        except (OSError, sqlite3.DatabaseError):
            LOGGER.exception('Could not persist the analytics snapshot; a later view will retry')

    def user(request):
        sid = request.session.get('sid')
        if not sid: return None
        with db() as conn:
            row = conn.execute('SELECT users.* FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.id=? AND expires>?', (sid,int(time.time()))).fetchone()
        return dict(row) if row else None
    def public_user(u):
        return {'id':u['id'],'name':u['name'],'moderator':u['sub'] in admins} if u else None
    def require_user(request):
        u=user(request)
        if not u: raise HTTPException(401,'请先使用魔搭账号登录')
        csrf=request.headers.get('x-csrf-token','')
        if request.headers.get('origin') != base or not csrf or not secrets.compare_digest(csrf, request.session.get('csrf','')):
            raise HTTPException(403,'页面已过期，请刷新后重试')
        return u
    def check_chapter(chapter):
        if chapter not in chapters: raise HTTPException(404,'章节不存在或尚未开放')
        return chapters[chapter]
    def require_same_origin(request):
        if request.headers.get('origin') != base:
            raise HTTPException(403,'请求来源无效')
    def analytics_range(days,start,end):
        today=datetime.now(analytics_timezone).date()
        if start or end:
            if not start or not end: raise HTTPException(422,'请选择完整的开始和结束日期')
            try:
                first=datetime.strptime(start,'%Y-%m-%d').date()
                last=datetime.strptime(end,'%Y-%m-%d').date()
            except ValueError:
                raise HTTPException(422,'日期格式无效')
        else:
            last=today;first=today-timedelta(days=days-1)
        span=(last-first).days+1
        if first>last or last>today: raise HTTPException(422,'日期范围无效')
        if span>90: raise HTTPException(422,'一次最多查询 90 天')
        if first<today-timedelta(days=179): raise HTTPException(422,'只能查询最近 180 天的数据')
        return today,first,last,span

    @app.middleware('http')
    async def response_headers(request, call_next):
        response = await call_next(request)
        response.headers['X-Content-Type-Options']='nosniff'
        response.headers['Referrer-Policy']='strict-origin-when-cross-origin'
        if request.url.path.startswith(('/api/','/auth/')):
            response.headers['Cache-Control']='no-store'
        return response

    @app.get('/api/session')
    def session(request: Request):
        request.session.setdefault('csrf',secrets.token_urlsafe(32))
        return {'user':public_user(user(request)), 'csrf':request.session['csrf'], 'loginEnabled':enabled}

    @app.post('/api/analytics/view',status_code=204)
    def record_analytics_view(view: AnalyticsView, request: Request):
        require_same_origin(request)
        if view.page not in analytics_pages: raise HTTPException(422,'页面不存在')
        current=datetime.now(analytics_timezone)
        today=current.date()
        day=today.isoformat()
        hour=current.strftime('%Y-%m-%dT%H')
        visitor_hash=hmac.new(session_secret.encode(),view.visitor.encode(),hashlib.sha256).hexdigest()
        def write_view():
            with analytics_db() as conn:
                conn.execute('BEGIN IMMEDIATE')
                conn.execute('INSERT INTO analytics_page_daily(day,page,pv) VALUES (?,?,1) ON CONFLICT(day,page) DO UPDATE SET pv=pv+1',(day,view.page))
                conn.execute('INSERT OR IGNORE INTO analytics_visitor_daily(day,page,visitor_hash) VALUES (?,?,?)',(day,view.page,visitor_hash))
                conn.execute('INSERT OR IGNORE INTO analytics_visitor_daily(day,page,visitor_hash) VALUES (?,?,?)',(day,'__site__',visitor_hash))
                conn.execute('INSERT OR IGNORE INTO analytics_visitor_all_time(visitor_hash,first_day) VALUES (?,?)',(visitor_hash,day))
                conn.execute('INSERT INTO analytics_site_hourly(hour,pv) VALUES (?,1) ON CONFLICT(hour) DO UPDATE SET pv=pv+1',(hour,))
                conn.execute('INSERT OR IGNORE INTO analytics_visitor_hourly(hour,visitor_hash) VALUES (?,?)',(hour,visitor_hash))
                with analytics_lock:
                    cleanup=analytics_cleanup_day['value']!=day
                    if cleanup: analytics_cleanup_day['value']=day
                if cleanup:
                    cutoff=(today-timedelta(days=179)).isoformat()
                    conn.execute('DELETE FROM analytics_visitor_daily WHERE day<?',(cutoff,))
                    hourly_cutoff=f'{(today-timedelta(days=89)).isoformat()}T00'
                    conn.execute('DELETE FROM analytics_site_hourly WHERE hour<?',(hourly_cutoff,))
                    conn.execute('DELETE FROM analytics_visitor_hourly WHERE hour<?',(hourly_cutoff,))
        use_analytics_database(write_view)
        mark_analytics_dirty()
        return Response(status_code=204)

    @app.get('/api/analytics/summary')
    def analytics_summary(days: int = Query(7,ge=1,le=90), start: str = '', end: str = ''):
        today,first,last,span=analytics_range(days,start,end)
        first_text,last_text=first.isoformat(),last.isoformat()
        previous_last=first-timedelta(days=1);previous_first=previous_last-timedelta(days=span-1)
        retention_start=today-timedelta(days=179)
        def totals(conn,range_start,range_end):
            bounds=(range_start.isoformat(),range_end.isoformat())
            pv=conn.execute('SELECT COALESCE(SUM(pv),0) total FROM analytics_page_daily WHERE day BETWEEN ? AND ?',bounds).fetchone()['total']
            uv=conn.execute('SELECT COUNT(DISTINCT visitor_hash) total FROM analytics_visitor_daily WHERE page=? AND day BETWEEN ? AND ?',('__site__',*bounds)).fetchone()['total']
            return {'pv':pv,'uv':uv}
        def read_summary():
            with analytics_db() as conn:
                selected=totals(conn,first,last)
                today_totals=totals(conn,today,today)
                previous=totals(conn,previous_first,previous_last) if previous_first>=retention_start else None
                pv_rows={row['day']:row['total'] for row in conn.execute('SELECT day,SUM(pv) total FROM analytics_page_daily WHERE day BETWEEN ? AND ? GROUP BY day',(first_text,last_text))}
                uv_rows={row['day']:row['total'] for row in conn.execute('SELECT day,COUNT(DISTINCT visitor_hash) total FROM analytics_visitor_daily WHERE page=? AND day BETWEEN ? AND ? GROUP BY day',('__site__',first_text,last_text))}
                page_pv={row['page']:row['total'] for row in conn.execute('SELECT page,SUM(pv) total FROM analytics_page_daily WHERE day BETWEEN ? AND ? GROUP BY page ORDER BY total DESC',(first_text,last_text))}
                page_uv={row['page']:row['total'] for row in conn.execute('SELECT page,COUNT(DISTINCT visitor_hash) total FROM analytics_visitor_daily WHERE page!=? AND day BETWEEN ? AND ? GROUP BY page',('__site__',first_text,last_text))}
                lifetime_pv=conn.execute('SELECT COALESCE(SUM(pv),0) total FROM analytics_page_daily').fetchone()['total']
                lifetime_uv=conn.execute('SELECT COUNT(*) total FROM analytics_visitor_all_time').fetchone()['total']
                lifetime_since=conn.execute('SELECT MIN(day) first_day FROM analytics_page_daily').fetchone()['first_day']
            return selected,today_totals,previous,pv_rows,uv_rows,page_pv,page_uv,{'pv':lifetime_pv,'uv':lifetime_uv,'since':lifetime_since}
        selected,today_totals,previous,pv_rows,uv_rows,page_pv,page_uv,lifetime=use_analytics_database(read_summary)
        daily=[]
        cursor=first
        while cursor<=last:
            value=cursor.isoformat();daily.append({'day':value,'pv':pv_rows.get(value,0),'uv':uv_rows.get(value,0)});cursor+=timedelta(days=1)
        pages=[{'page':page,'title':analytics_titles.get(page,page),'pv':pv,'uv':page_uv.get(page,0),'share':round(pv*100/selected['pv'],1) if selected['pv'] else 0} for page,pv in page_pv.items()]
        return {'range':{'start':first_text,'end':last_text,'days':span,'timezone':'Asia/Shanghai'},'lifetime':lifetime,'today':today_totals,'totals':selected,'previous':previous,'daily':daily,'pages':pages,'updatedAt':datetime.now(analytics_timezone).isoformat(timespec='seconds')}

    @app.get('/api/analytics/hourly')
    def analytics_hourly(date: str = ''):
        current=datetime.now(analytics_timezone)
        today=current.date()
        try:
            selected=datetime.strptime(date,'%Y-%m-%d').date() if date else today
        except ValueError as error:
            raise HTTPException(422,'日期格式应为 YYYY-MM-DD') from error
        earliest=today-timedelta(days=89)
        if selected>today: raise HTTPException(422,'不能查询未来日期')
        if selected<earliest: raise HTTPException(422,'小时数据仅保留最近 90 天')
        day=selected.isoformat()
        first_hour=f'{day}T00';last_hour=f'{day}T23'
        def read_hourly():
            with analytics_db() as conn:
                pv_rows={row['hour']:row['pv'] for row in conn.execute('SELECT hour,pv FROM analytics_site_hourly WHERE hour BETWEEN ? AND ?',(first_hour,last_hour))}
                uv_rows={row['hour']:row['total'] for row in conn.execute('SELECT hour,COUNT(*) total FROM analytics_visitor_hourly WHERE hour BETWEEN ? AND ? GROUP BY hour',(first_hour,last_hour))}
                total_pv=conn.execute('SELECT COALESCE(SUM(pv),0) total FROM analytics_site_hourly WHERE hour BETWEEN ? AND ?',(first_hour,last_hour)).fetchone()['total']
                total_uv=conn.execute('SELECT COUNT(DISTINCT visitor_hash) total FROM analytics_visitor_hourly WHERE hour BETWEEN ? AND ?',(first_hour,last_hour)).fetchone()['total']
                available_since=conn.execute('SELECT MIN(hour) first_hour FROM analytics_site_hourly').fetchone()['first_hour']
            return pv_rows,uv_rows,total_pv,total_uv,available_since
        pv_rows,uv_rows,total_pv,total_uv,available_since=use_analytics_database(read_hourly)
        current_hour=current.strftime('%Y-%m-%dT%H')
        hours=[]
        for value in range(24):
            key=f'{day}T{value:02d}'
            available=bool(available_since and key>=available_since and key<=current_hour)
            hours.append({'hour':f'{value:02d}:00','pv':pv_rows.get(key,0) if available else None,'uv':uv_rows.get(key,0) if available else None})
        return {
            'date':day,
            'timezone':'Asia/Shanghai',
            'retentionDays':90,
            'availableSince':f'{available_since}:00:00+08:00' if available_since else None,
            'totals':{'pv':total_pv,'uv':total_uv},
            'hours':hours,
            'updatedAt':current.isoformat(timespec='seconds'),
        }

    @app.get('/auth/login')
    async def login(request: Request, return_to: str = '#home'):
        if not enabled: raise HTTPException(503,'魔搭登录尚未配置')
        # Only a local chapter/home hash can be used as the return destination.
        import re
        request.session['return_to'] = return_to if re.fullmatch(r'#[a-zA-Z0-9_/?=&%-]{1,180}', return_to) else '#home'
        return await oauth.modelscope.authorize_redirect(request, base+'/auth/callback')

    @app.get('/auth/callback')
    async def callback(request: Request):
        if not enabled: raise HTTPException(503,'魔搭登录尚未配置')
        try:
            token = await oauth.modelscope.authorize_access_token(request)
            info = token.get('userinfo')
            if not info or not info.get('sub'): raise ValueError('Missing validated identity')
        except (OAuthError, ValueError):
            return RedirectResponse('/?login=failed#home',status_code=303)
        sub=str(info['sub'])
        name=str(info.get('name') or info.get('preferred_username') or '魔搭读者')[:100]
        now=int(time.time()); sid=secrets.token_urlsafe(32)
        with db() as conn:
            conn.execute('INSERT INTO users VALUES (?,?,?) ON CONFLICT(sub) DO UPDATE SET name=excluded.name',(secrets.token_hex(16),sub,name))
            uid=conn.execute('SELECT id FROM users WHERE sub=?',(sub,)).fetchone()['id']
            conn.execute('DELETE FROM sessions WHERE expires<=? OR id=?',(now,request.session.get('sid','')))
            conn.execute('INSERT INTO sessions VALUES (?,?,?)',(sid,uid,now+7*86400))
        target=request.session.get('return_to','#home')
        request.session.clear()
        request.session.update(sid=sid,csrf=secrets.token_urlsafe(32))
        return RedirectResponse('/'+target,status_code=303)

    @app.post('/api/logout')
    def logout(request: Request):
        require_user(request)
        with db() as conn: conn.execute('DELETE FROM sessions WHERE id=?',(request.session.get('sid'),))
        request.session.clear()
        return {'ok':True}

    @app.get('/api/chapters/{chapter}/entries')
    def list_entries(chapter: str, request: Request, before: int = 0):
        storage_chapter=check_chapter(chapter); u=user(request); uid=u['id'] if u else ''
        # Rowid cursor remains stable even when multiple entries share a timestamp.
        with db() as conn:
            rows=conn.execute('SELECT e.rowid cursor,e.*,u.name FROM entries e JOIN users u ON u.id=e.user_id WHERE e.chapter=? AND (e.kind!=\'highlight\' OR e.user_id=?) AND (?=0 OR e.rowid<?) ORDER BY e.rowid DESC LIMIT 101',(storage_chapter,uid,before,before)).fetchall()
        items=[]
        for row in rows[:100]:
            item=dict(row); item['chapter']=chapter; item['mine']=item['user_id']==uid
            item['canDelete']=item['mine'] or bool(u and u['sub'] in admins)
            item.pop('user_id'); items.append(item)
        return {'items':items,'next':items[-1]['cursor'] if len(rows)>100 else None}

    @app.post('/api/chapters/{chapter}/entries',status_code=201)
    def add_entry(chapter: str, entry: Entry, request: Request):
        u=require_user(request); chapter=check_chapter(chapter)
        if entry.kind not in ('highlight','annotation','comment'): raise HTTPException(422,'不支持的笔记类型')
        if entry.kind!='highlight' and not entry.text.strip(): raise HTTPException(422,'请填写内容')
        if entry.kind!='comment' and (not entry.quote.strip() or entry.end<=entry.start): raise HTTPException(422,'请先选择正文中的文字')
        now=int(time.time()); eid=secrets.token_hex(16)
        with db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            count=conn.execute('SELECT count(*) FROM entries WHERE user_id=? AND created>?',(u['id'],now-60)).fetchone()[0]
            if count>=10: raise HTTPException(429,'操作太频繁，请稍后再试')
            if entry.kind=='highlight':
                existing=conn.execute('SELECT id FROM entries WHERE chapter=? AND user_id=? AND kind=? AND block=? AND start=? AND end=? AND quote=?',(chapter,u['id'],entry.kind,entry.block,entry.start,entry.end,entry.quote)).fetchone()
                if existing: return {'id':existing['id']}
            conn.execute('INSERT INTO entries VALUES (?,?,?,?,?,?,?,?,?,?)',(eid,chapter,u['id'],entry.kind,entry.text.strip(),entry.quote,entry.block,entry.start,entry.end,now))
        return {'id':eid}

    @app.delete('/api/entries/{entry_id}')
    def delete_entry(entry_id: str, request: Request):
        u=require_user(request)
        with db() as conn:
            row=conn.execute('SELECT user_id FROM entries WHERE id=?',(entry_id,)).fetchone()
            if not row: raise HTTPException(404,'内容已删除')
            if row['user_id']!=u['id'] and u['sub'] not in admins: raise HTTPException(403,'只能删除自己发表的内容')
            conn.execute('DELETE FROM entries WHERE id=?',(entry_id,))
        return {'ok':True}

    @app.get('/api/wishes')
    def list_wishes(request: Request, before: int = 0):
        u=user(request)
        with db() as conn:
            rows=conn.execute('SELECT w.rowid cursor,w.*,u.name FROM wishes w JOIN users u ON u.id=w.user_id WHERE (?=0 OR w.rowid<?) ORDER BY w.rowid DESC LIMIT 21',(before,before)).fetchall()
        items=[]
        for row in rows[:20]:
            item=dict(row)
            item['canDelete']=bool(u and (item['user_id']==u['id'] or u['sub'] in admins))
            item.pop('user_id'); items.append(item)
        return {'items':items,'next':items[-1]['cursor'] if len(rows)>20 else None}

    @app.post('/api/wishes',status_code=201)
    def add_wish(wish: Wish, request: Request):
        u=require_user(request)
        text=wish.text.strip()
        if not text: raise HTTPException(422,'请写下希望补充的内容')
        now=int(time.time()); wid=secrets.token_hex(16)
        with db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            count=conn.execute('SELECT count(*) FROM wishes WHERE user_id=? AND created>?',(u['id'],now-60)).fetchone()[0]
            if count>=5: raise HTTPException(429,'愿望发送太频繁，请稍后再试')
            conn.execute('INSERT INTO wishes VALUES (?,?,?,?)',(wid,u['id'],text,now))
        return {'id':wid}

    @app.delete('/api/wishes/{wish_id}')
    def delete_wish(wish_id: str, request: Request):
        u=require_user(request)
        with db() as conn:
            row=conn.execute('SELECT user_id FROM wishes WHERE id=?',(wish_id,)).fetchone()
            if not row: raise HTTPException(404,'这条愿望已删除')
            if row['user_id']!=u['id'] and u['sub'] not in admins: raise HTTPException(403,'只能删除自己发表的愿望')
            conn.execute('DELETE FROM wishes WHERE id=?',(wish_id,))
        return {'ok':True}

    def grading_unavailable(detail):
        # Grading is a bonus layer: it degrades to the reference answer plus a
        # self-assessment instead of failing the exercise, so the fallback flag has
        # to travel in the body -- an HTTPException would only carry `detail`.
        return JSONResponse(status_code=503, content={'detail':detail, 'fallback':True}, headers={'x-sils-fallback':'1'})

    @app.get('/api/exercises/progress')
    def list_exercise_progress(request: Request):
        u=user(request)
        if not u: return {'items':[]}
        with db() as conn:
            rows=conn.execute('SELECT chapter,exercise,passed,score,code,self_assessed,attempts,updated FROM exercise_progress WHERE user_id=? ORDER BY updated DESC',(u['id'],)).fetchall()
        items=[dict(row) for row in rows]
        # Both columns go back exactly as stored. selfAssessed keeps its three
        # states because the client's chapterSummary counts every value except
        # 'fail' as self-assessed progress, and `updated` is folded from the
        # milliseconds an older client stamped into seconds so the client can
        # compare it against its own clock.
        for item in items:
            item['selfAssessed']=item.pop('self_assessed')
            item['updated']=second_stamp(item['updated'])
        return {'items':items}

    @app.post('/api/exercises/progress',status_code=201)
    def save_exercise_progress(payload: ExerciseProgress, request: Request):
        u=require_user(request)
        now=int(time.time()); saved=0
        with db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            # Writes are counted, not rows: progress is upserted, so a reader who
            # resends the same exercise collapses into one row and a row count would
            # never trip. The log is pruned in the same transaction that reads it.
            #
            # The quota counts REQUESTS, and deliberately not rows: charging for
            # row count made the ceiling a function of how much progress a reader
            # had accumulated. Past 20 rows every sync was refused, the refusal
            # changed nothing on the client, so the next sync sent the same rows
            # and was refused too -- a deadlock that could not clear itself and
            # grew more certain with the corpus. Rows are bounded separately by
            # ExerciseProgress's cap, which is a ceiling on one request body.
            #
            # An empty batch is not a write and is not logged: the caller changed
            # nothing, so charging it would let a client burn a reader's quota by
            # re-syncing someone who has never opened an exercise.
            if payload.items:
                conn.execute('DELETE FROM exercise_progress_writes WHERE created<?',(now-60,))
                count=conn.execute('SELECT count(*) FROM exercise_progress_writes WHERE user_id=? AND created>?',(u['id'],now-60)).fetchone()[0]
                if count>=20: raise HTTPException(429,'操作太频繁，请稍后再试')
                conn.execute('INSERT INTO exercise_progress_writes VALUES (?,?,?)',(secrets.token_hex(16),u['id'],now))
            for item in payload.items:
                if item.chapter not in exercise_index or item.exercise not in exercise_index[item.chapter]:
                    raise HTTPException(422,'练习不存在或尚未开放')
                # passed and score only ever ratchet up, exactly like the client's
                # merge: a device replaying a stale snapshot must not un-pass work the
                # server already accepted, and a client's own push-back carries the
                # merged values rather than a regressing one.
                #
                # self_assessed is the opposite kind of value and is deliberately
                # NOT ratcheted. passed/score are accumulative achievements -- a pass
                # is never revoked -- so MAX is their rule. A self-assessment is the
                # learner's current statement about their own understanding, and it
                # legitimately moves in both directions: 'fail' becomes 'pass' after
                # a re-read, 'pass' becomes 'fail' after a bad day. Any merge rule
                # the server invented here would be wrong twice over: the three
                # states have no order ('fail' is not "less than" 'pass', and not
                # "greater" than 'partial'), and the payload has already been
                # arbitrated. merge() ran on the client before this request existed,
                # timestamp arbitration decided that side, and the push-back is
                # snapshot() reading the bucket merge() just wrote -- so the value
                # arriving here IS the merged result. Re-deciding it server-side
                # would apply a second, different rule to an already-decided value.
                # Adding a `updated >= stored.updated` guard on top of that was
                # tried and rejected: it looks safer, but a device whose clock lags
                # would have its fresh 'fail' discarded in favour of the server's
                # older 'pass', and merge() would then adopt that 'pass' locally --
                # trading the reported bug for the same false progress by another
                # route. Faithful storage plus the client's own arbitration is the
                # only rule that cannot manufacture a pass.
                conn.execute('''INSERT INTO exercise_progress VALUES (?,?,?,?,?,?,?,?,?,?)
                                ON CONFLICT(user_id,chapter,exercise) DO UPDATE SET
                                code=excluded.code,passed=MAX(exercise_progress.passed,excluded.passed),
                                score=MAX(exercise_progress.score,excluded.score),
                                self_assessed=excluded.self_assessed,
                                attempts=excluded.attempts,updated=excluded.updated''',
                             (secrets.token_hex(16),u['id'],item.chapter,item.exercise,item.code,item.passed,item.score,
                              self_assessment_state(item.selfAssessed),item.attempts,second_stamp(item.updated) or now))
                saved+=1
        return {'saved':saved}

    @app.post('/api/exercises/grade')
    def grade_exercise(payload: ExerciseGrade):
        if payload.exercise not in exercise_ids: raise HTTPException(422,'练习不存在或尚未开放')
        key=os.getenv('EXERCISE_LLM_KEY'); base=os.getenv('EXERCISE_LLM_BASE_URL')
        if not key or not base: return grading_unavailable('LLM 评分未启用')
        model=os.getenv('EXERCISE_LLM_MODEL','gpt-4o-mini')
        prompt=('你是评分助手。按给定标准给答案打分，只输出 JSON。\n'
                f'标准：{payload.criteria}\n答案：{payload.answer}\n'
                '输出格式：{"score": 0 到 1 的小数, "feedback": "一句话点评"}')
        try:
            response=httpx.post(base.rstrip('/')+'/chat/completions',
                headers={'Authorization':f'Bearer {key}'},
                json={'model':model,'temperature':0,'messages':[{'role':'user','content':prompt}]},timeout=20)
            if response.status_code//100!=2: raise RuntimeError(f'LLM 返回 {response.status_code}')
            content=response.json()['choices'][0]['message']['content']
        except Exception:
            LOGGER.exception('Exercise grading unavailable')
            return grading_unavailable('LLM 评分暂时不可用')
        try:
            verdict=json.loads(content)
            # The prompt asks for JSON and real models comply with the letter far
            # less often than they comply with the spirit: a bare number, a bare
            # array or a null all come back from "只输出 JSON". `.get` on those
            # raises AttributeError, which is not a ValueError and used to escape
            # every `except` here and surface as a 500 -- the learner lost the
            # reference answer over a formatting detail. Type is checked first so
            # every unparsable verdict takes the same degradation path.
            if not isinstance(verdict,dict): raise ValueError('verdict is not a JSON object')
            score=max(0.0,min(1.0,float(verdict.get('score',0))))
            # feedback is prose the learner reads. A model that answers with an
            # object would otherwise hand them Python's repr, so only a real
            # string is carried over.
            feedback=verdict.get('feedback','')
            feedback=feedback[:500] if isinstance(feedback,str) else ''
        except (ValueError, TypeError, AttributeError):
            LOGGER.exception('Exercise grading returned an unparsable verdict')
            return grading_unavailable('评分结果无法解析')
        return {'score':score,'feedback':feedback}

    @app.get('/')
    def index(): return FileResponse(ROOT/'index.html',headers={'Cache-Control':'no-cache'})
    @app.get('/analytics')
    def analytics_page(): return FileResponse(ROOT/'assets/analytics.html',headers={'Cache-Control':'no-store'})
    @app.get('/favicon.svg')
    def favicon(): return FileResponse(ROOT/'favicon.svg')
    @app.get('/deployment.json')
    def deployment():
        if not (ROOT/'deployment.json').exists(): raise HTTPException(404)
        return FileResponse(ROOT/'deployment.json')
    for directory in ('assets','content','chapters'):
        app.mount('/'+directory,StaticFiles(directory=ROOT/directory),name=directory)
    for filename in ('CONTRIBUTING.md','README.md','README.zh-CN.md','LICENSE'):
        def make_document(path):
            def document(): return FileResponse(path)
            return document
        app.add_api_route('/'+filename,make_document(ROOT/filename),methods=['GET'])

    app.state.db=db
    app.state.analytics_db=analytics_db
    app.state.analytics_path=analytics_path
    app.state.persistent_analytics_path=persistent_analytics_path
    app.state.snapshot_analytics=snapshot_analytics_database
    app.state.oauth=oauth
    return app

app=create_app()
