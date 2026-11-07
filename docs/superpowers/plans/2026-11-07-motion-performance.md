# 流畅度、缺陷与分层动效 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不引入任何新依赖的前提下，为 SILS 建立分层动效系统、消除实测到的传输与布局瓶颈，并收口已知缺陷。

**Architecture:** 后端只做传输（按路径选择是否压缩、版本化资源长缓存、webp MIME）；前端把 22 个阻塞脚本改为 defer + 按需注入；新增 `assets/motion.css` + `assets/motion.js` 作为唯一动效层，路由切换走 View Transitions、内容入场走 IntersectionObserver；缺陷侧消除章节渲染的强制同步布局与图片无尺寸造成的 CLS，并给三个写端点加 503 兜底。

**Tech Stack:** Python 3.10/3.13 · FastAPI + Starlette 1.8（`GZipMiddleware`）· 原生 ES5 风格 IIFE JS（无构建、无打包器）· pytest（`fastapi.testclient`）· node:test + `node:vm` 手写 DOM · Playwright（浏览器 E2E）

**Spec:** [docs/superpowers/specs/2026-11-07-motion-performance-design.md](../specs/2026-11-07-motion-performance-design.md)

## Global Constraints

- 零新增依赖：不引入 GSAP、不引入 jsdom、不新建 `package.json`；node 测试只允许 `node:` 内置模块与现有 `scripts/test-exercise-ui-harness.cjs` 的 vm 模式。
- 动效只允许改变 `transform` 与 `opacity`；禁止对 `width/height/top/left/margin/padding` 做过渡或动画。
- 路由过渡期间主线程不得出现 > 50 ms 长任务；不得为重播动画引入强制同步布局。
- 面向读者的文案一律走 i18n key，且 `assets/locale/zh.js`、`en.js`、`es.js` 三份必须同时补齐；技术细节只进 `console`。
- 不改 SQLite 连接生命周期（`db()` 仍是一次操作一个连接）；不改正文文字、不改版块结构。
- 不改变任何 API 的路径、状态码语义与响应体形状，只允许新增响应头。
- Windows 本地跑 Python 测试必须带 `PYTHONUTF8=1`。
- 每个任务结束时：`PYTHONUTF8=1 .venv/Scripts/python.exe -m pytest tests -q` 必须 ≥ 123 passed，且本任务新增测试全绿；`node scripts/check-site.mjs` 必须 PASS。
- 提交信息沿用仓库风格：`perf:` / `feat:` / `fix:` / `style:` / `test:` / `docs:`。

## 对 spec 的四处修订（执行时按本节为准）

1. **reveal 目标不再靠手写 `[data-reveal]`**：由 `motion.js` 维护选择器清单（`#articleBody h2`、`#homePaths article`、`#sceneGrid .scene`，外加任何已带 `[data-reveal]` 的元素）。理由：这三处标记全部由 `paper.js` 用 `innerHTML` 模板生成，手写属性会散落在构建产物与模板字符串里。
2. **不支持 View Transitions 的退化路径改用 WAAPI 一次性动画**（`element.animate`），不用 class 重播。理由：class 重播需要 `void el.offsetWidth` 触发重排，与 Task 7 的目标直接冲突。
3. **`check-site.mjs:64-67` 与 `scripts/test-exercise-wiring.cjs:76-85` 的契约必须反转**：它们当前断言 6 个练习模块写在 `index.html` 里且早于 `paper.js`；练习包改为按需注入后，这条断言会变成阻塞项。Task 5 负责改契约，不是绕过。
4. **`scripts/version-assets.mjs` 扩展**：注入用的脚本路径写在 `assets/i18n.js` 与 `assets/paper.js` 的字符串数组里，必须一并打 `?v=`，否则按需注入的资源拿不到长缓存。

---

### Task 1: 传输层——按路径选择压缩、版本化资源长缓存、webp MIME

**Files:**
- Modify: `app.py:1-32`（import 区）、`app.py:442`（中间件注册）、`app.py:577-584`（`response_headers`）
- Test: `tests/test_static_delivery.py`（新建）

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `app.SELECTIVE_BINARY_SUFFIXES: tuple[str, ...]` — 不做压缩的后缀白名单
  - `app.SelectiveEncoding` — ASGI 中间件类，构造签名 `SelectiveEncoding(app)`
  - `app.SHORT_CACHE_PATHS: frozenset[str]` — 无内容哈希、走短缓存的路径
  - 响应头契约：2xx 且路由未自行设定 `Cache-Control` 时，带 `?v=` 的静态资源请求返回 `Cache-Control: public, max-age=31536000, immutable`；`SHORT_CACHE_PATHS` 优先于 `?v=`；无哈希的 `/assets|/content|/chapters` 返回 `REVALIDATE`。路由自设的策略（`/` 的 `no-cache`、`/analytics` 的 `no-store`）永不被查询参数覆盖。

- [ ] **Step 1: 写失败测试**

创建 `tests/test_static_delivery.py`：

```python
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
```

- [ ] **Step 2: 运行，确认失败**

Run: `PYTHONUTF8=1 .venv/Scripts/python.exe -m pytest tests/test_static_delivery.py -q`
Expected: FAIL —`KeyError: 'content-encoding'`（未压缩）与 `KeyError: 'cache-control'`（静态资源无该头）。

- [ ] **Step 3: 加 import 与模块级常量**

`app.py` 第 2 行后补 `import mimetypes`（保持字母序，插在 `logging` 与 `os` 之间）：

```python
import logging
import mimetypes
import os
```

第 26 行 `from starlette.middleware.sessions import SessionMiddleware` 之前补一行：

```python
from starlette.middleware.gzip import GZipMiddleware
```

`app.py:32`（`LOGGER = logging.getLogger(__name__)`）之后补：

```python
# Already-compressed payloads must not be re-deflated: it burns CPU on every
# request and the result is usually larger. Text is where gzip pays for itself.
SELECTIVE_BINARY_SUFFIXES = ('.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.avif',
                             '.woff', '.woff2', '.ttf', '.otf', '.eot',
                             '.wasm', '.mp4', '.webm', '.mp3', '.zip', '.gz', '.br')
# Assets without a content hash in the URL cannot be cached forever.
SHORT_CACHE_PATHS = frozenset(('/favicon.svg', '/deployment.json', '/CONTRIBUTING.md',
                               '/README.md', '/README.zh-CN.md', '/LICENSE'))
IMMUTABLE = 'public, max-age=31536000, immutable'
SHORT_CACHE = 'public, max-age=300, must-revalidate'

# Python's map is built from /etc/mimetypes on Linux, where webp is often absent;
# StaticFiles then serves it as octet-stream and the browser cannot sniff it.
mimetypes.add_type('image/webp', '.webp')


class SelectiveEncoding:
    """Strip accept-encoding for binary paths so GZipMiddleware passes them through."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] == 'http' and scope.get('path', '').lower().endswith(SELECTIVE_BINARY_SUFFIXES):
            scope = dict(scope)
            scope['headers'] = [(k, v) for k, v in scope['headers'] if k.lower() != b'accept-encoding']
        await self.app(scope, receive, send)
```

- [ ] **Step 4: 注册中间件**

`app.py:442`（`app.add_middleware(SessionMiddleware, ...)`）之后紧接补两行。顺序是刻意的：`add_middleware` 插到栈首，后注册者在外层，所以 `SelectiveEncoding` 必须在 `GZipMiddleware` 之后添加，才能在 gzip 看到请求头之前剥掉它。

```python
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.add_middleware(SelectiveEncoding)
```

- [ ] **Step 5: 扩展 `response_headers`**

`app.py:577-584` 整段替换为：

```python
    @app.middleware('http')
    async def response_headers(request, call_next):
        response = await call_next(request)
        response.headers['X-Content-Type-Options']='nosniff'
        response.headers['Referrer-Policy']='strict-origin-when-cross-origin'
        if request.url.path.startswith(('/api/','/auth/')):
            response.headers['Cache-Control']='no-store'
        elif 200 <= response.status_code < 300 and 'cache-control' not in response.headers:
            # A route that already chose a policy outranks any query parameter:
            # `/` is no-cache and `/analytics` is no-store, and a stray ?v= in a
            # shared link must not pin a stale shell in a browser for a year.
            if request.url.path in SHORT_CACHE_PATHS:
                response.headers['Cache-Control']=SHORT_CACHE
            elif request.query_params.get('v'):
                # version-assets.mjs stamps a SHA-256 prefix into every asset URL;
                # a changed file is a different URL, so the old copy can never be served.
                response.headers['Cache-Control']=IMMUTABLE
            elif request.url.path.startswith(('/assets/','/content/','/chapters/')):
                # An asset URL without a content hash gets no long life: with no
                # header at all, browsers apply heuristic freshness off
                # Last-Modified and can serve a stale file for days after a deploy.
                response.headers['Cache-Control']=REVALIDATE
        return response
```

模块级常量区补第四条（与 `IMMUTABLE`/`SHORT_CACHE` 并列，不要在函数体里写裸字符串）：

```python
REVALIDATE = 'public, max-age=0, must-revalidate'
```

- [ ] **Step 6: 运行，确认通过**

Run: `PYTHONUTF8=1 .venv/Scripts/python.exe -m pytest tests/test_static_delivery.py -q`
Expected: PASS（15 项）

- [ ] **Step 7: 跑全量回归**

Run: `PYTHONUTF8=1 .venv/Scripts/python.exe -m pytest tests -q`
Expected: `138 passed`（123 基线 + 15 新增），且 `tests/test_discussion.py` 的 `cache-control==no-store` 断言仍通过。

- [ ] **Step 8: 提交**

```bash
git add app.py tests/test_static_delivery.py
git commit -m "perf(transport): gzip text by path, cache versioned assets forever, type webp"
```

---

### Task 2: 三个写端点的 503 兜底

**Files:**
- Modify: `app.py:785-800`（`add_entry`）、`app.py:824-835`（`add_wish`）、`app.py:994-1067`（`save_exercise_progress`）、`app.py:847-858`（helper 区）
- Test: `tests/test_write_fallback.py`（新建）

**Interfaces:**
- Consumes: Task 1 的 `response_headers`（不冲突：`/api/` 分支优先，仍为 `no-store`）
- Produces:
  - `write_unavailable(error) -> JSONResponse` — `503` + `{'detail': ..., 'fallback': True}` + `Retry-After: 2` + `x-sils-fallback: 1`
  - 三个写端点在只读型 `sqlite3.OperationalError` 下返回 503 而非 500

- [ ] **Step 1: 写失败测试**

创建 `tests/test_write_fallback.py`：

```python
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
```

- [ ] **Step 2: 运行，确认失败**

Run: `PYTHONUTF8=1 .venv/Scripts/python.exe -m pytest tests/test_write_fallback.py -q`
Expected: FAIL —三个 `*_degrades_to_503` 用例得到 500（`TestClient` 直接把 `OperationalError` 抛出）。

- [ ] **Step 3: 加 helper**

`app.py:847-851` 的 `grading_unavailable` 之前插入（与它同形，多一个 `Retry-After`）：

```python
    def write_unavailable(error):
        # The reader's own text is never lost here: the frontend keeps the draft
        # and retries, and a 503 is the one status that says "same request, later".
        LOGGER.exception('Site database is unavailable for a write')
        return JSONResponse(status_code=503, content={'detail': '服务暂时不可用，请稍后重试', 'fallback': True},
                            headers={'Retry-After': '2', 'x-sils-fallback': '1'})
```

- [ ] **Step 4: 包住 `add_entry` 的写入**

`app.py:791-800` 替换为（`try` 只包住数据库块，`HTTPException(429)` 照常向外抛）：

```python
        now=int(time.time()); eid=secrets.token_hex(16)
        try:
            with db() as conn:
                conn.execute('BEGIN IMMEDIATE')
                count=conn.execute('SELECT count(*) FROM entries WHERE user_id=? AND created>?',(u['id'],now-60)).fetchone()[0]
                if count>=10: raise HTTPException(429,'操作太频繁，请稍后再试')
                if entry.kind=='highlight':
                    existing=conn.execute('SELECT id FROM entries WHERE chapter=? AND user_id=? AND kind=? AND block=? AND start=? AND end=? AND quote=?',(chapter,u['id'],entry.kind,entry.block,entry.start,entry.end,entry.quote)).fetchone()
                    if existing: return {'id':existing['id']}
                conn.execute('INSERT INTO entries VALUES (?,?,?,?,?,?,?,?,?,?)',(eid,chapter,u['id'],entry.kind,entry.text.strip(),entry.quote,entry.block,entry.start,entry.end,now))
        except sqlite3.OperationalError as error:
            if 'readonly' not in str(error).lower(): raise
            return write_unavailable(error)
        return {'id':eid}
```

- [ ] **Step 5: 包住 `add_wish` 的写入**

`app.py:829-835` 替换为：

```python
        now=int(time.time()); wid=secrets.token_hex(16)
        try:
            with db() as conn:
                conn.execute('BEGIN IMMEDIATE')
                count=conn.execute('SELECT count(*) FROM wishes WHERE user_id=? AND created>?',(u['id'],now-60)).fetchone()[0]
                if count>=5: raise HTTPException(429,'愿望发送太频繁，请稍后再试')
                conn.execute('INSERT INTO wishes VALUES (?,?,?,?)',(wid,u['id'],text,now))
        except sqlite3.OperationalError as error:
            if 'readonly' not in str(error).lower(): raise
            return write_unavailable(error)
        return {'id':wid}
```

- [ ] **Step 6: 包住 `save_exercise_progress` 的写入**

`app.py:998` 的 `with db() as conn:` 整块（998-1066，含中间未改动的循环与注释）缩进一级并包进 `try`，在 `return` 前补 `except`。块尾 `app.py:1067` 的 `return {'saved':saved,'skipped':skipped}` 之前加：

```python
        except sqlite3.OperationalError as error:
            if 'readonly' not in str(error).lower(): raise
            return write_unavailable(error)
```

即结构变为：

```python
        now=int(time.time()); saved=0; skipped=0
        try:
            with db() as conn:
                conn.execute('BEGIN IMMEDIATE')
                ...  # 既有 999-1066 行内容原样缩进一级，包括 1026-1029 的 ValidationError 处理
        except sqlite3.OperationalError as error:
            if 'readonly' not in str(error).lower(): raise
            return write_unavailable(error)
        return {'saved':saved,'skipped':skipped}
```

- [ ] **Step 7: 运行，确认通过**

Run: `PYTHONUTF8=1 .venv/Scripts/python.exe -m pytest tests/test_write_fallback.py -q`
Expected: PASS（5 项）

- [ ] **Step 8: 全量回归**

Run: `PYTHONUTF8=1 .venv/Scripts/python.exe -m pytest tests -q`
Expected: `143 passed`

- [ ] **Step 9: 提交**

```bash
git add app.py tests/test_write_fallback.py
git commit -m "fix(api): degrade the three write endpoints to a retryable 503 on readonly WAL"
```

### Task 2 实现后的更正（评审裁定，代码为准）

本任务的实际落地与本节原文有四处差异，均已由任务评审与复审确认正确，后续任务按此理解：

1. **测试替身必须在 `INSERT/UPDATE/DELETE` 抛错，不能拦 `BEGIN`。** 真实只读库在 `BEGIN IMMEDIATE` 是成功的。原文的 fake 让三个 503 测试认证了一个生产永不触发的失败点。
2. **兜底范围扩到 `delete_entry` 与 `delete_wish`。** 理由：读者删除自己的笔记拿到硬 500，而发表拿到可重试的 503，是同一次会话里就能撞见的矛盾，且 Task 8 的重试文案会宣传 503 行为。`logout`、登录会话写入、统计写入仍明确不在范围内。
3. **判定抽成 `readonly_write_failure(error)`**，与既有 `analytics_corruption` 同形，五个 catch 点共用；不引入装饰器或上下文包装器。`write_unavailable()` 不再接收未使用的 `error` 参数。
4. **测试数为 8 项、全量 146 passed**（原文 5 项/139 为算错）。`assert_degraded` 对五个端点逐一钉住 `detail`、`Retry-After`、`x-sils-fallback` 与 `cache-control: no-store`。

---

### Task 3: 构建期图片尺寸与首图优先级

**Files:**
- Modify: `scripts/build-content.py:25-26`（新函数）、`scripts/build-content.py:183-204`（写入尺寸 + 首图处理）
- Modify: `assets/content.js`、`content/chapters/*.md`（由构建脚本重新生成，预期 `.md` 无变化）
- Modify: `scripts/check-site.mjs:32-44`（新断言）
- Test: `tests/test_build_content.py`（新建）

**Interfaces:**
- Consumes: `assets/manuscript-20260914/*.webp` 等真实图片文件
- Produces:
  - `build-content.image_size(path) -> tuple[int, int] | None`
  - `check-site.mjs` 的 `imageSize(buffer) -> [w, h] | null`
  - 正文 `<img>` 标签新增 `width`/`height`；每章首图去掉 `loading="lazy"`、加 `fetchpriority="high"`

- [ ] **Step 1: 写失败测试**

创建 `tests/test_build_content.py`：

```python
"""构建期尺寸解析必须与真实图片头部一致——这是 CLS 修复的地基。"""
import importlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# scripts/ must be importable: build-content.py itself does
# `from chapter_markdown import to_markdown` at module level.
sys.path.insert(0, str(ROOT / 'scripts'))
image_size = importlib.import_module('build-content').image_size


def test_reads_a_real_webp():
    target = ROOT / 'assets' / 'manuscript-20260914' / 'c01-065d3d9ab0de58.webp'
    assert image_size(target) == (1880, 1090)


def test_reads_a_real_png():
    target = ROOT / 'assets' / 'reading-dada-illustrations' / '01-reading-v2.png'
    assert image_size(target) == (1672, 941)


def test_returns_none_for_a_vector_file():
    # None, not a guess: check-site.mjs turns a None into a reported gap.
    assert image_size(ROOT / 'assets' / 'brand' / 'book-mark.svg') is None


def test_returns_none_for_a_truncated_header(tmp_path):
    broken = tmp_path / 'x.webp'
    broken.write_bytes(b'RIFF\x00\x00\x00\x00WEBP')
    assert image_size(broken) is None
```

`importlib` 是必需的，不是绕弯：模块文件名为 `build-content.py`（连字符），`from build_content import ...` 无法导入。两个期望尺寸（1880x1090、1672x941）取自当前仓库真实文件的头部，已用与实现无关的方式核对过。

- [ ] **Step 2: 运行，确认失败**

Run: `PYTHONUTF8=1 .venv/Scripts/python.exe -m pytest tests/test_build_content.py -q`
Expected: FAIL —`ImportError: cannot import name 'image_size'`。

- [ ] **Step 3: 实现解析函数**

`scripts/build-content.py:25`（`def digest(value):` 之前）插入：

```python
def image_size(path):
    """Return (width, height) for a PNG or WebP, or None when the header is unreadable.

    Stdlib only, because the build must stay runnable without Pillow: normal
    builds and --check never import it. Returning None instead of raising keeps a
    single odd file from blocking the whole book, and check-site.mjs then reports
    the gap rather than trusting a guessed number.
    """
    with path.open('rb') as handle:
        head = handle.read(30)
    if head.startswith(b'\x89PNG\r\n\x1a\n') and len(head) >= 24:
        return int.from_bytes(head[16:20], 'big'), int.from_bytes(head[20:24], 'big')
    if head[:4] == b'RIFF' and head[8:12] == b'WEBP':
        fourcc = head[12:16]
        if fourcc == b'VP8X' and len(head) >= 30:
            return 1 + int.from_bytes(head[24:27], 'little'), 1 + int.from_bytes(head[27:30], 'little')
        if fourcc == b'VP8 ' and len(head) >= 30:
            return int.from_bytes(head[26:28], 'little') & 0x3FFF, int.from_bytes(head[28:30], 'little') & 0x3FFF
        if fourcc == b'VP8L' and len(head) >= 25:
            bits = int.from_bytes(head[21:25], 'little')
            return bits % 4096 + 1, (bits // 4096) % 4096 + 1
    return None
```

- [ ] **Step 4: 运行，确认通过**

Run: `PYTHONUTF8=1 .venv/Scripts/python.exe -m pytest tests/test_build_content.py -q`
Expected: PASS（4 项）

- [ ] **Step 5: 构建时写入尺寸**

`scripts/build-content.py:190-196` 的 `for attr in ('href', 'src'):` 循环之后（仍在 `for node in article.iter():` 体内，缩进一致）补：

```python
            if node.tag == 'img':
                size = image_size(ROOT / node.get('src', ''))
                if size:
                    node.set('width', str(size[0]))
                    node.set('height', str(size[1]))
```

注意插入点必须在 `to_markdown(article, number)`（第 172 行）之后——`content/chapters/*.md` 由更早的调用生成，因此正文 Markdown 不会因新增属性而变动，`--check` 仍然通过。

- [ ] **Step 6: 首图去掉 lazy、提升优先级**

`scripts/build-content.py:204`（`body = '\n'.join(dump(n) for n in article)`）之前插入：

```python
        # The chapter's first image is the LCP element. Chrome's own guidance is
        # explicit: a lazy-loaded LCP image is discovered too late, which is the
        # 245ms load delay measured on the live site.
        first_image = article.find('.//img')
        if first_image is not None:
            first_image.attrib.pop('loading', None)
            first_image.set('fetchpriority', 'high')
```

- [ ] **Step 7: 重新生成并核对**

Run: `PYTHONUTF8=1 .venv/Scripts/python.exe scripts/build-content.py`
Expected: `Built 35 chapters, 380 images, ...`
Run: `git diff --stat content/chapters`
Expected: 空输出（Markdown 未变）。若不为空，说明插入点写错，回到 Step 5 修正。

- [ ] **Step 8: 加 check-site 断言**

`scripts/check-site.mjs:21`（`let imageCount=0,attachmentCount=0;`）之前插入解析器：

```js
function imageSize(buffer){
  if(buffer.subarray(0,8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a])))
    return [buffer.readUInt32BE(16),buffer.readUInt32BE(20)];
  if(buffer.toString('latin1',0,4)==='RIFF'&&buffer.toString('latin1',8,12)==='WEBP'){
    const fourcc=buffer.toString('latin1',12,16);
    if(fourcc==='VP8X')return [1+buffer.readUIntLE(24,3),1+buffer.readUIntLE(27,3)];
    if(fourcc==='VP8 ')return [buffer.readUInt16LE(26)&0x3fff,buffer.readUInt16LE(28)&0x3fff];
    if(fourcc==='VP8L'){const bits=buffer.readUInt32LE(21);return [bits%4096+1,Math.floor(bits/4096)%4096+1];}
  }
  return null;
}
```

`scripts/check-site.mjs:42`（`checkLinks(chapter.html);`）之后插入：

```js
  for(const tag of chapter.html.matchAll(/<img\b[^>]*class="article-image"[^>]*>/g)){
    const src=/src="([^"]+)"/.exec(tag[0])[1];
    const width=/\swidth="(\d+)"/.exec(tag[0]), height=/\sheight="(\d+)"/.exec(tag[0]);
    assert(width&&height,`article image without intrinsic size: ${src}`);
    const size=imageSize(readFileSync(resolve(root,src.split('?')[0])));
    if(size)assert(Number(width[1])===size[0]&&Number(height[1])===size[1],
      `${src} declares ${width[1]}x${height[1]}, file is ${size[0]}x${size[1]}`);
  }
  const firstImage=/<img\b[^>]*class="article-image"[^>]*>/.exec(chapter.html);
  if(firstImage)assert(!/loading="lazy"/.test(firstImage[0])&&/fetchpriority="high"/.test(firstImage[0]),
    `chapter-${chapter.number} first image must stay eager and high priority`);
```

- [ ] **Step 9: 运行 check-site**

Run: `node scripts/check-site.mjs`
Expected: `PASS: 35 chapters, ...`

- [ ] **Step 10: 全量回归**

Run: `PYTHONUTF8=1 .venv/Scripts/python.exe -m pytest tests -q`
Expected: `143 passed`

- [ ] **Step 11: 提交**

```bash
git add scripts/build-content.py scripts/check-site.mjs assets/content.js tests/test_build_content.py
git commit -m "perf(reader): give every article image its intrinsic size and the first one priority"
```

---

### Task 4: defer 与按需注入原语

**Files:**
- Create: `assets/asset-loader.js`
- Modify: `index.html:133-137`
- Test: `scripts/test-asset-loading.cjs`（新建）

**Interfaces:**
- Consumes: 无
- Produces:
  - `window.AssetLoader.loadScript(src: string) -> Promise<string>` — 同一 `src` 并发/重复调用返回同一 promise；失败后清除缓存允许重试
  - `window.AssetLoader.loadSequence(srcs: string[]) -> Promise<string[]>` — 串行注入，保证执行顺序

- [ ] **Step 1: 写失败测试**

创建 `scripts/test-asset-loading.cjs`：

```js
/* The injection primitive every lazy bundle in this site rides on.
   Run with: node scripts/test-asset-loading.cjs */
'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const vm = require('node:vm);

const ROOT = resolve(__dirname, '..');
const SOURCE = readFileSync(resolve(ROOT, 'assets/asset-loader.js'), 'utf8');

let passed = 0;
const failures = [];
async function check(name, body) {
  try { await body(); passed += 1; console.log('ok  ' + name); }
  catch (error) { failures.push([name, error]); console.log('FAIL ' + name + ': ' + error.message); }
}

/* A DOM small enough to watch what the loader does, and nothing more. */
function makeDom() {
  const nodes = [];
  const head = { append(node) { nodes.push(node); return node; } };
  return {
    nodes,
    window: {},
    document: {
      head,
      createElement: tag => ({
        tag, src: '',
        remove() { const at = nodes.indexOf(this); if (at >= 0) nodes.splice(at, 1); },
        set onload(fn) { this._load = fn; }, get onload() { return this._load; },
        set onerror(fn) { this._error = fn; }, get onerror() { return this._error; },
      }),
    },
    settle(index, ok) {
      const node = nodes[index];
      if (ok) node.onload(); else node.onerror(new Error('network'));
      return node;
    },
  };
}

function boot() {
  const dom = makeDom();
  vm.runInNewContext(SOURCE, { window: dom.window, document: dom.document });
  return { dom, loader: dom.window.AssetLoader };
}

async function main() {
  await check('asset-loader.js is syntactically valid and exports AssetLoader', () => {
    assert.ok(boot().loader.loadScript, 'loadScript missing');
    assert.ok(boot().loader.loadSequence, 'loadSequence missing');
  });

  await check('one src is injected exactly once, even when requested twice', () => {
    const { dom, loader } = boot();
    const first = loader.loadScript('assets/a.js');
    const second = loader.loadScript('assets/a.js');
    assert.equal(dom.nodes.length, 1, 'a second tag was injected for the same src');
    assert.equal(first, second, 'the promise was not reused');
  });

  await check('loadSequence injects in order and resolves only after each lands', async () => {
    const { dom, loader } = boot();
    const done = [];
    const running = loader.loadSequence(['assets/a.js', 'assets/b.js']).then(list => done.push(list));
    await Promise.resolve();
    assert.equal(dom.nodes.length, 1, 'the second script started before the first finished');
    dom.settle(0, true);
    await Promise.resolve();
    assert.equal(dom.nodes.length, 2);
    assert.equal(dom.nodes[1].src, 'assets/b.js');
    dom.settle(1, true);
    await running;
    assert.deepEqual(done, [['assets/a.js', 'assets/b.js']]);
  });

  await check('a failed injection rejects and is retryable', async () => {
    const { dom, loader } = boot();
    await assert.rejects(loader.loadScript('assets/a.js').then(() => dom.settle(0, false)));
    assert.equal(dom.nodes.length, 0, 'the failed tag was left in the document');
    const again = loader.loadScript('assets/a.js');
    assert.equal(dom.nodes.length, 1, 'a retry must be allowed after failure');
    dom.settle(0, true);
    assert.equal(await again, 'assets/a.js');
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
}
main();
```

- [ ] **Step 2: 运行，确认失败**

Run: `node scripts/test-asset-loading.cjs`
Expected: FAIL —`ENOENT ... assets/asset-loader.js`（文件还不存在）。

- [ ] **Step 3: 实现注入原语**

创建 `assets/asset-loader.js`：

```js
/* Injects one script on demand and remembers the attempt.

   Dynamically added <script> tags are async by default, which would silently
   reorder the exercise bundle (exercises.js must precede exercise-map.js). So
   the only public helper that takes a list awaits each tag before adding the
   next, and the whole site shares one map keyed by src -- a route entered twice
   must not pay for the bundle twice. */
(() => {
  'use strict';
  const pending = new Map();

  function loadScript(src) {
    if (!pending.has(src)) {
      pending.set(src, new Promise((resolvePromise, rejectPromise) => {
        const tag = document.createElement('script');
        tag.src = src;
        tag.onload = () => resolvePromise(src);
        tag.onerror = () => {
          pending.delete(src);
          tag.remove();
          rejectPromise(new Error('无法加载 ' + src));
        };
        document.head.append(tag);
      }));
    }
    return pending.get(src);
  }

  async function loadSequence(srcs) {
    for (const src of srcs) await loadScript(src);
    return srcs;
  }

  window.AssetLoader = { loadScript, loadSequence };
})();
```

- [ ] **Step 4: 运行，确认通过**

Run: `node scripts/test-asset-loading.cjs`
Expected: `4 passed, 0 failed`

- [ ] **Step 5: index.html 全部脚本改为 defer**

`index.html:133-137` 整段替换为（本任务只加 `defer` 与新增的 `asset-loader.js`，**不删任何脚本**——删脚本属于 Task 5，混在一起会让本任务结束时 `check-site.mjs` 与 wiring 测试同时变红）：

```html
<script src="assets/i18n.js?v=07e6cc450b7e"></script><script src="assets/locale/zh.js?v=9d52219ea851"></script><script src="assets/content.js?v=ec9f8ed7eec5"></script>
<script defer src="assets/asset-loader.js?v=000000000000"></script><script defer src="assets/locale/en.js?v=2e5dd793001d"></script><script defer src="assets/locale/es.js?v=0101887fa89f"></script><script defer src="assets/content-i18n/en.js?v=8f8eddd20782"></script><script defer src="assets/content-i18n/es.js?v=5b84a5c8eb29"></script><script defer src="assets/language-switcher.js?v=67243aed212a"></script>
<script defer src="assets/exercises.js?v=e08be2062f82"></script><script defer src="assets/exercise-grader.js?v=3c6548035306"></script><script defer src="assets/exercise-store.js?v=60f13f8a96a2"></script><script defer src="assets/exercise-sandbox.js?v=248ef0a7613b"></script><script defer src="assets/exercise-map.js?v=93478189a6bf"></script><script defer src="assets/exercise-ui.js?v=03b76ab6967b"></script>
<script defer src="assets/katex/katex.min.js?v=10a91b479cd9"></script><script defer src="assets/book-search.js?v=7579d53dd639"></script><script defer src="assets/reader-routes.js?v=b55d8df3bc82"></script><script defer src="assets/analytics.js?v=a43d60631cb4"></script><script defer src="assets/paper.js?v=1e735b17c1d5"></script><script defer src="assets/reading.js?v=3096d5d71d92"></script><script defer src="assets/discussion.js?v=a7fbd519e30d"></script>
<script defer src="assets/wishes.js?v=412f393e94a7"></script>
```

三点不可协商：

1. `i18n.js` / `locale/zh.js` / `content.js` 保持 eager。`locale/zh.js` 顶层直接调用 `MSI18N.register`，一旦被 defer 就早于 `i18n.js` 执行，抛 `MSI18N is not defined`。
2. `asset-loader.js` 排在所有 defer 脚本之前——Task 5 的 `i18n.load` 与 `ensureExerciseBundle` 都靠它。
3. defer 脚本仍按文档顺序执行，所以 `check-site.mjs:61-67` 与 `test-exercise-wiring.cjs` 的“练习模块早于 paper.js”契约在本任务后依然成立，到 Task 5 才反转。

- [ ] **Step 6: 占位哈希换成真哈希**

Run: `node scripts/version-assets.mjs && node -e "const s=require('fs').readFileSync('index.html','utf8');const m=/assets\/asset-loader\.js\?v=([0-9a-f]{12})/.exec(s);console.log('asset-loader='+m[1])"`
Expected: 打印 12 位十六进制哈希（`asset-loader.js` 刚创建，占位的 `000000000000` 必须被替换）。

Run: `node scripts/check-site.mjs && node scripts/test-exercise-wiring.cjs && node scripts/test-asset-loading.cjs`
Expected: 全部 PASS——本任务不改变任何脚本的存在与否，只改变加载方式。

- [ ] **Step 7: 提交**

```bash
git add assets/asset-loader.js index.html scripts/test-asset-loading.cjs
git commit -m "perf(load): defer every non-essential script and add the injection primitive"
```

---

### Task 5: 语言包与练习包按需加载（含既有测试契约反转）

**Files:**
- Modify: `assets/i18n.js:78-101`
- Modify: `assets/language-switcher.js:22-26`
- Modify: `assets/paper.js:120-121`、`assets/paper.js:413-419`
- Modify: `scripts/version-assets.mjs:3`
- Modify: `scripts/check-site.mjs:55-68`
- Modify: `scripts/test-exercise-wiring.cjs:56-90,355-357`
- Test: `scripts/test-asset-loading.cjs`（扩展）、`tests/test_i18n_lazy_load.py` 不新增（纯前端，走 node 侧）

**Interfaces:**
- Consumes: Task 4 的 `window.AssetLoader.loadSequence(srcs)`
- Produces:
  - `window.MSI18N.load(code) -> Promise<string>` — 保证该语言的 UI 词典与正文译文已注册；zh 直接 resolve
  - `window.MSI18N.set(code, options) -> Promise<void>`（原为同步，现返回 promise）
  - `window.MSI18N.extraPaths: {en: string[], es: string[]}`
  - `paper.js` 内部 `EXERCISE_BUNDLE: string[]`、`ensureExerciseBundle() -> Promise<string[]>`

- [ ] **Step 1: 写失败测试（扩展 Task 4 的测试文件）**

`scripts/test-asset-loading.cjs` 的 `main()` 内 `console.log` 之前追加：

```js
  await check('i18n.js declares the lazy paths for en and es, each versioned', () => {
    const source = readFileSync(resolve(ROOT, 'assets/i18n.js'), 'utf8');
    for (const code of ['en', 'es']) {
      const pattern = new RegExp(`\\b${code}:\\s*\\[\\s*'assets/locale/${code}\\.js\\?v=[0-9a-f]{12}',\\s*'assets/content-i18n/${code}\\.js\\?v=[0-9a-f]{12}'`);
      assert.match(source, pattern, `${code} lazy paths missing or unversioned`);
    }
  });

  await check('i18n.set waits for the pack before it notifies', () => {
    const source = readFileSync(resolve(ROOT, 'assets/i18n.js'), 'utf8');
    assert.match(source, /async function set\(code, options\)/, 'set must be async');
    assert.match(source, /await load\(next\)/, 'set must await the pack');
  });

  await check('paper.js lists the exercise bundle in load order', () => {
    const source = readFileSync(resolve(ROOT, 'assets/paper.js'), 'utf8');
    const list = /const EXERCISE_BUNDLE = \[([\s\S]*?)\]/.exec(source);
    assert.ok(list, 'EXERCISE_BUNDLE is not declared in paper.js');
    const modules = [...list[1].matchAll(/'assets\/([^'?]+)\.js/g)].map(m => m[1] + '.js');
    assert.deepEqual(modules, [
      'exercises.js', 'exercise-grader.js', 'exercise-store.js',
      'exercise-sandbox.js', 'exercise-map.js', 'exercise-ui.js',
    ], 'exercises.js must stay first: exercise-map.js reads window.EXERCISE_DATA at load');
  });

  await check('index.html no longer ships the lazy bundles', () => {
    const html = readFileSync(resolve(ROOT, 'index.html'), 'utf8');
    for (const name of ['exercises.js', 'exercise-ui.js', 'locale/en.js', 'content-i18n/es.js']) {
      assert.ok(!html.includes('assets/' + name), `index.html still loads ${name}`);
    }
  });
```

- [ ] **Step 2: 运行，确认失败**

Run: `node scripts/test-asset-loading.cjs`
Expected: 新增 4 项 FAIL。

- [ ] **Step 3: i18n.js 增加异步加载**

`assets/i18n.js:78-86`（`function set`）替换为：

```js
  /* en/es dictionaries and translated prose are 3.4 MB of literals that a Chinese
     reader never needs. They are injected on demand, so `set` has to wait for
     them: notifying first would paint half-translated chrome over Chinese prose. */
  const extraPaths = {
    en: ['assets/locale/en.js?v=2e5dd793001d', 'assets/content-i18n/en.js?v=8f8eddd20782'],
    es: ['assets/locale/es.js?v=0101887fa89f', 'assets/content-i18n/es.js?v=5b84a5c8eb29']
  };
  async function load(code) {
    const next = normalize(code);
    if (!next || next === DEFAULT || dictionaries[next]) return next;
    if (!window.AssetLoader) throw new Error('asset loader is unavailable');
    await window.AssetLoader.loadSequence(extraPaths[next]);
    if (!dictionaries[next]) throw new Error('language pack registered nothing');
    return next;
  }
  async function set(code, options) {
    const next = await load(code);
    if (!next || next === current) return;
    current = next;
    if (!options || options.persist !== false) {
      try { localStorage.setItem(STORAGE_KEY, next); } catch { /* Storage can be disabled in embedded readers. */ }
    }
    notify();
  }
```

`assets/i18n.js:87-91`（`function init`）替换为：

```js
  function init() {
    const initial = stored();
    // A returning English reader gets Chinese chrome until the pack lands; that
    // is the trade for not shipping 3.4 MB to everyone. notify() runs once, after.
    if (initial && initial !== DEFAULT) { load(initial).then(code => { current = code; notify(); }, notify); }
    else notify();
  }
```

`assets/i18n.js:93-98` 的导出对象补两项（`load` 与 `extraPaths`）：

```js
  window.MSI18N = {
    register, t, has, apply, set, load, init, codes: Object.freeze(['zh', 'en', 'es']),
    get lang() { return current; },
    get extraPaths() { return extraPaths; },
    locale() { return htmlLang[current] || current; },
    on(listener) { listeners.add(listener); return () => listeners.delete(listener); }
  };
```

- [ ] **Step 4: 语言选择器处理加载态与失败**

`assets/language-switcher.js:22-26`（`buildPicker` 内 `select.addEventListener` 那段）替换为：

```js
    select.addEventListener('change', async () => {
      const wanted = select.value;
      select.disabled = true;
      select.title = '';
      try {
        await window.MSI18N.set(wanted);
      } catch {
        // Revert rather than leave the picker claiming a language the page is not in.
        select.value = window.MSI18N.lang;
        select.title = window.MSI18N.t('language.loadFailed');
      } finally {
        select.disabled = false;
      }
    });
```

- [ ] **Step 5: 补三语词条**

`assets/locale/zh.js` 内 `'common.language': '语言',` 之后加：

```js
  'language.loadFailed': '语言包加载失败，请稍后重试',
```

`assets/locale/en.js` 对应位置加：

```js
  'language.loadFailed': 'The language pack could not be loaded. Please try again.',
```

`assets/locale/es.js` 对应位置加：

```js
  'language.loadFailed': 'No se pudo cargar el paquete de idioma. Inténtalo de nuevo.',
```

- [ ] **Step 6: paper.js 接管练习包**

`assets/paper.js:120`（`function renderExerciseMap() ...`）替换为：

```js
  const EXERCISE_BUNDLE = ['assets/exercises.js?v=e08be2062f82', 'assets/exercise-grader.js?v=3c6548035306',
    'assets/exercise-store.js?v=60f13f8a96a2', 'assets/exercise-sandbox.js?v=248ef0a7613b',
    'assets/exercise-map.js?v=93478189a6bf', 'assets/exercise-ui.js?v=03b76ab6967b'];
  function ensureExerciseBundle() { return window.AssetLoader.loadSequence(EXERCISE_BUNDLE); }
  /* Startup keeps the original guard: a reader who never opens #practice must not
     pay 1.2 MB for it, so the eager call sites stay a no-op until the bundle lands. */
  function renderExerciseMap() { if (window.ExerciseMap) window.ExerciseMap.render(); }
```

`assets/paper.js:418`（`if(view==='contents')renderIndex();if(view==='paths')renderPath(sub);if(view==='practice')renderExerciseMap();`）替换为：

```js
      if(view==='contents')renderIndex();if(view==='paths')renderPath(sub);
      if(view==='practice'){
        if(window.ExerciseMap)renderExerciseMap();
        else{
          const practiceStatus=$('#exerciseMap');
          practiceStatus.textContent=t('practice.loading');
          ensureExerciseBundle().then(renderExerciseMap).catch(()=>{practiceStatus.textContent=t('practice.loadFailed');});
        }
      }
```

`assets/locale/zh.js`、`en.js`、`es.js` 各补两条 `practice.*` 词条（与既有 `practice.*` 键相邻插入）：

```js
  'practice.loading': '学习地图加载中…',
  'practice.loadFailed': '学习地图加载失败，请点击重试',
```

```js
  'practice.loading': 'Loading the learning map…',
  'practice.loadFailed': 'The learning map failed to load. Tap to retry.',
```

```js
  'practice.loading': 'Cargando el mapa de aprendizaje…',
  'practice.loadFailed': 'No se pudo cargar el mapa. Toca para reintentar.',
```

- [ ] **Step 7: version-assets.mjs 一并给注入路径打哈希**

`scripts/version-assets.mjs:3` 的循环头替换为：

```js
const pages=['../index.html','../assets/analytics.html'];
const scripts=['../assets/i18n.js','../assets/paper.js'];
const stamp=contents=>contents.replace(/(href|src)="(assets\/[^"?]+\.(?:css|js))(?:\?[^" ]*)?"/g,(_,attr,path)=>
  `${attr}="${path}?v=${hash(path)}"`);
const hash=path=>createHash('sha256').update(readFileSync(new URL('../'+path,import.meta.url))).digest('hex').slice(0,12);
for(const filename of pages){
 const page=new URL(filename,import.meta.url);
 writeFileSync(page,stamp(readFileSync(page,'utf8')));
}
/* Injected paths live inside JS string arrays. Without a hash they would get no
   Cache-Control from the immutable rule, which keys off the ?v= parameter. */
for(const filename of scripts){
 const file=new URL(filename,import.meta.url);
 const content=readFileSync(file,'utf8').replace(/'(assets\/[^'?]+\.(?:js|css))(?:\?v=[0-9a-f]{12})?'/g,(_,path)=>
  `'${path}?v=${hash(path)}'`);
 writeFileSync(file,content);
}
```

- [ ] **Step 8: 从 index.html 移除按需资源**

`index.html:134-136`（Task 4 留下的 defer 清单）中删掉这 8 个标签，只保留 eager 三件套与 `asset-loader.js`、`language-switcher.js`、`katex`、`book-search.js`、`reader-routes.js`、`analytics.js`、`paper.js`、`reading.js`、`discussion.js`、`wishes.js`：

```html
<script defer src="assets/locale/en.js?v=2e5dd793001d"></script><script defer src="assets/locale/es.js?v=0101887fa89f"></script><script defer src="assets/content-i18n/en.js?v=8f8eddd20782"></script><script defer src="assets/content-i18n/es.js?v=5b84a5c8eb29"></script>
<script defer src="assets/exercises.js?v=e08be2062f82"></script><script defer src="assets/exercise-grader.js?v=3c6548035306"></script><script defer src="assets/exercise-store.js?v=60f13f8a96a2"></script><script defer src="assets/exercise-sandbox.js?v=248ef0a7613b"></script><script defer src="assets/exercise-map.js?v=93478189a6bf"></script><script defer src="assets/exercise-ui.js?v=03b76ab6967b"></script>
```

这一步与 Step 9、Step 10 必须同批提交：单独删脚本会同时打断 `check-site.mjs` 与 wiring 测试的旧契约。

- [ ] **Step 9: 反转 check-site.mjs 的顺序契约**

`scripts/check-site.mjs:55-68`（含注释）替换为：

```js
/* The exercise bundle left index.html, so the old "listed before paper.js"
   rule is now the wrong contract. What still has to hold:
     1. the bundle is declared once, in paper.js, in dependency order;
     2. index.html does not ship it eagerly (a Chinese-only reader must not pay
        1.2 MB for a view they never open).
   Checked here because CI already runs this file. */
const indexHtml=read('index.html');
const scriptOrder=[...indexHtml.matchAll(/<script[^>]*\ssrc="assets\/([^"?]+\.js)/g)].map(m=>m[1]);
const EXERCISE_MODULES=['exercises.js','exercise-grader.js','exercise-store.js','exercise-sandbox.js','exercise-map.js','exercise-ui.js'];
for(const module of EXERCISE_MODULES){
  assert(!scriptOrder.includes(module),`index.html must not load ${module} eagerly`);
}
const bundleSource=read('assets/paper.js');
const bundleList=/const EXERCISE_BUNDLE = \[([\s\S]*?)\]/.exec(bundleSource);
assert(bundleList,'paper.js no longer declares EXERCISE_BUNDLE');
const bundle=[...bundleList[1].matchAll(/'assets\/([^'?]+)\.js/g)].map(m=>m[1]+'.js');
assert.deepEqual(bundle,EXERCISE_MODULES,'EXERCISE_BUNDLE order changed; exercises.js must stay first');
assert(scriptOrder.indexOf('asset-loader.js')<scriptOrder.indexOf('paper.js'),'asset-loader.js must load before paper.js');
```

- [ ] **Step 10: 修 wiring 测试的脚本清单**

`scripts/test-exercise-wiring.cjs:73-90`（`const ORDER = scriptOrder(INDEX);` 起，含两个 `check`）替换为：

```js
const ORDER = scriptOrder(INDEX);
/* The bundle is no longer in the page, but the wiring contract still is: the
   six modules must execute, in declared order, before anything reads
   window.ExerciseMap. A #practice visit is exactly what the old index.html
   ordering simulated, so the suite keeps running them -- from paper.js's own
   list, which is the new source of truth. */
const bundleSource = read('assets/paper.js');
const bundleList = /const EXERCISE_BUNDLE = \[([\s\S]*?)\]/.exec(bundleSource);
assert.ok(bundleList, 'paper.js no longer declares EXERCISE_BUNDLE');
const BUNDLE = [...bundleList[1].matchAll(/'assets\/([^'?]+)\.js/g)].map(m => m[1] + '.js');

async function main() {
await check('paper.js lists every exercise module exactly once, in order', () => {
  assert.deepEqual(BUNDLE, EXERCISE_MODULES);
});

await check('index.html ships none of the exercise modules', () => {
  for (const module of EXERCISE_MODULES) {
    assert.equal(ORDER.filter(name => name === module).length, 0, `${module} is still eager`);
  }
});

await check('asset-loader.js is loaded before paper.js', () => {
  const paperAt = ORDER.indexOf('paper.js');
  assert.notEqual(paperAt, -1, 'index.html no longer loads assets/paper.js');
  const at = ORDER.indexOf('asset-loader.js');
  assert.notEqual(at, -1, 'asset-loader.js is not loaded by index.html');
  assert.ok(at < paperAt, `asset-loader.js sits at ${at}, after paper.js at ${paperAt}`);
});
```

`scripts/test-exercise-wiring.cjs:357`（`const RUNNABLE = ORDER.filter(...)`）替换为：

```js
const RUNNABLE = [...ORDER.filter(name => !SKIPPED.has(name)), ...EXERCISE_MODULES];
```

（`EXERCISE_MODULES` 在该文件第 62-69 行已带 `.js` 后缀，直接展开，不要再拼后缀。）

- [ ] **Step 11: 运行，确认通过**

Run: `node scripts/version-assets.mjs && node scripts/test-asset-loading.cjs && node scripts/test-exercise-wiring.cjs && node scripts/check-site.mjs`
Expected: 全部 PASS；`test-asset-loading.cjs` 输出 `8 passed, 0 failed`。

- [ ] **Step 12: 全量回归**

Run: `PYTHONUTF8=1 .venv/Scripts/python.exe -m pytest tests -q`
Expected: `147 passed`

- [ ] **Step 13: 提交**

```bash
git add assets/i18n.js assets/language-switcher.js assets/paper.js assets/locale scripts/version-assets.mjs scripts/check-site.mjs scripts/test-exercise-wiring.cjs scripts/test-asset-loading.cjs index.html
git commit -m "perf(load): inject language packs and the exercise bundle on demand"
```

---

### Task 6: 分层动效层

**Files:**
- Create: `assets/motion.css`、`assets/motion.js`
- Modify: `index.html:8`（新增 stylesheet 链接）、`index.html:134`（已含 motion.js，Task 4）
- Modify: `assets/paper.js:394-430`（`route()` 包裹）
- Test: `scripts/test-motion.cjs`（新建）

**Interfaces:**
- Consumes: Task 4 的 defer 顺序（`motion.js` 早于 `paper.js`）
- Produces:
  - `window.Motion.reduce() -> boolean`
  - `window.Motion.transition(mutate: () => void) -> ViewTransition | undefined`
  - `window.Motion.scan(root?: Element) -> void`
  - CSS 自定义属性：`--motion-fast` `--motion-base` `--motion-slow` `--ease-out` `--ease-in-out` `--motion-rise`

- [ ] **Step 1: 写失败测试**

创建 `scripts/test-motion.cjs`：

```js
/* The motion layer's contract, checked against source rather than opinion:
   tokens exist, nothing animates a layout property, reduced motion is honoured
   in both CSS and JS, and the fallback never reintroduces a forced reflow.
   Run with: node scripts/test-motion.cjs */
'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const read = path => readFileSync(resolve(ROOT, path), 'utf8');
const CSS = read('assets/motion.css');
const JS = read('assets/motion.js');
const HTML = read('index.html');
const PAPER = read('assets/paper.js');

let passed = 0;
const failures = [];
function check(name, body) {
  try { body(); passed += 1; console.log('ok  ' + name); }
  catch (error) { failures.push([name, error]); console.log('FAIL ' + name + ': ' + error.message); }
}

const LAYOUT_PROPERTIES = ['width', 'height', 'top', 'left', 'right', 'bottom', 'margin', 'padding'];

check('motion.css declares every token exactly once', () => {
  for (const token of ['--motion-fast', '--motion-base', '--motion-slow', '--ease-out', '--ease-in-out', '--motion-rise']) {
    assert.ok(CSS.includes(token + ':'), `${token} is not declared`);
  }
});

check('no transition or animation touches a layout property', () => {
  for (const property of LAYOUT_PROPERTIES) {
    const pattern = new RegExp(`transition:[^;}]*\\b${property}\\b`, 'g');
    assert.equal((CSS.match(pattern) || []).length, 0, `motion.css transitions ${property}`);
  }
});

check('reveal styles are gated behind .motion-ready', () => {
  assert.match(CSS, /\.motion-ready \[data-reveal\]/, 'reveal rules must require the JS flag');
  assert.ok(!/^\s*\[data-reveal\]\s*\{[^}]*opacity:\s*0/m.test(CSS),
    'a bare [data-reveal]{opacity:0} would hide content when JS never runs');
});

check('prefers-reduced-motion zeroes the duration tokens', () => {
  const block = /@media \(prefers-reduced-motion: reduce\)\{([^}]*)\}/.exec(CSS);
  assert.ok(block, 'no reduced-motion block in motion.css');
  for (const token of ['--motion-fast', '--motion-base', '--motion-slow']) {
    assert.match(block[1], new RegExp(token + ':\\s*0ms'), `${token} not zeroed`);
  }
});

check('motion.js reads reduced motion through matchMedia, not a CSS hack alone', () => {
  assert.match(JS, /matchMedia\('(prefers-reduced-motion: reduce)'\)/);
});

check('motion.js skips View Transitions under reduced motion', () => {
  assert.match(JS, /if\s*\(reduce\.matches\s*\|\|\s*!document\.startViewTransition\)/);
});

check('the fallback uses WAAPI and never forces layout', () => {
  assert.match(JS, /\.animate\(/, 'fallback should be a one-shot WAAPI animation');
  assert.ok(!/void\s+\w+\.(offsetWidth|offsetHeight|clientHeight)/.test(JS),
    'restarting a class animation with a layout read is the reflow Task 7 removes');
});

check('reveal targets are the three generated lists plus any authored hook', () => {
  for (const selector of ['#articleBody h2', '#homePaths article', '#sceneGrid .scene', '[data-reveal]']) {
    assert.ok(JS.includes(selector), `motion.js does not reveal ${selector}`);
  }
});

check('scan writes the data-reveal hook the CSS gate keys off', () => {
  const body = /function scan\(root\)\s*\{([\s\S]*?)\n  \}/.exec(JS);
  assert.ok(body, 'scan() not found in motion.js');
  assert.match(body[1], /setAttribute\('data-reveal'/,
    'without the hook, CSS never hides the node and the entrance animation is a no-op');
});

check('paper.js routes every view change through Motion.transition', () => {
  assert.match(PAPER, /window\.Motion\.transition\(apply\)/);
  assert.match(PAPER, /const apply = \(\) =>/, 'route() must keep its DOM mutation in one closure');
});

check('index.html links motion.css', () => {
  assert.match(HTML, /<link rel="stylesheet" href="assets\/motion\.css\?v=[0-9a-f]{12}">/);
});

check('motion.js loads before paper.js', () => {
  const order = [...HTML.matchAll(/<script[^>]*\ssrc="assets\/([^"?]+\.js)/g)].map(m => m[1]);
  assert.notEqual(order.indexOf('motion.js'), -1, 'motion.js is not loaded');
  assert.ok(order.indexOf('motion.js') < order.indexOf('paper.js'),
    'route() calls window.Motion.transition at paper.js startup');
});

check('a mid-visit preference change reveals hidden content instead of reloading', () => {
  assert.match(JS, /reduce\.addEventListener\('change'/);
  assert.match(JS, /function revealEverything\(\)/);
  assert.ok(!/window\.location\.reload\(\)/.test(JS), 'reloading the document is not a motion fallback');
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
```

- [ ] **Step 2: 运行，确认失败**

Run: `node scripts/test-motion.cjs`
Expected: FAIL —`ENOENT ... assets/motion.css`。

- [ ] **Step 3: 写 motion.css**

创建 `assets/motion.css`：

```css
/* One motion vocabulary for the whole site. Three durations, two easings, one
   distance -- anything else is a special case that has to justify itself here.
   Only transform and opacity may animate: every other property re-lays out a
   document that is 400k words deep. */
:root{
  --motion-fast:120ms;
  --motion-base:220ms;
  --motion-slow:360ms;
  --ease-out:cubic-bezier(.22,.61,.36,1);
  --ease-in-out:cubic-bezier(.65,.05,.36,1);
  --motion-rise:10px;
}

/* Content stays visible until motion.js proves it can reveal it. */
.motion-ready [data-reveal]{
  transition:opacity var(--motion-base) var(--ease-out),transform var(--motion-base) var(--ease-out);
}
.motion-ready [data-reveal]:not(.is-revealed){
  opacity:0;
  transform:translateY(var(--motion-rise));
}

::view-transition-old(root){animation:vt-out var(--motion-fast) var(--ease-in-out) both}
::view-transition-new(root){animation:vt-in var(--motion-base) var(--ease-out) both}
@keyframes vt-out{to{opacity:0}}
@keyframes vt-in{from{opacity:0;transform:translateY(var(--motion-rise))}to{opacity:1;transform:none}}

/* Buttons, cards and nav links share the same two durations rather than each
   inventing one. */
.motion-ready .primary-button,
.motion-ready .home-button,
.motion-ready .pager-link,
.motion-ready .desktop-nav a,
.motion-ready .text-link,
.motion-ready .discussion-entry,
.motion-ready .wish-entry{
  transition:transform var(--motion-fast) var(--ease-out),
             opacity var(--motion-fast) var(--ease-out),
             box-shadow var(--motion-fast) var(--ease-out);
}
.motion-ready .primary-button:hover,
.motion-ready .home-button:hover,
.motion-ready .pager-link:hover{transform:translateY(calc(var(--motion-rise) * -0.3))}
.motion-ready .primary-button:active,
.motion-ready .home-button:active{transform:translateY(1px)}

@media (prefers-reduced-motion: reduce){
  :root{--motion-fast:0ms;--motion-base:0ms;--motion-slow:0ms;--motion-rise:0px}
  /* Same specificity as the hiding rule: a later, weaker selector would lose
     the cascade and leave reduced-motion readers staring at invisible prose. */
  .motion-ready [data-reveal]:not(.is-revealed){opacity:1;transform:none}
  .motion-ready [data-reveal]{transition:none}
  ::view-transition-old(root),::view-transition-new(root){animation:none}
  .motion-ready .primary-button:hover,
  .motion-ready .home-button:hover,
  .motion-ready .pager-link:hover{transform:none}
}
```

- [ ] **Step 4: 写 motion.js**

创建 `assets/motion.js`：

```js
/* The only motion layer in this site.

   Deliberately small: it owns the reduced-motion decision (CSS cannot make the
   IntersectionObserver and View Transition go away), it owns the reveal scan,
   and it owns the one place that knows how to swap a view. Everything else
   reads the tokens. */
(() => {
  'use strict';
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  const REVEAL_SELECTORS = ['#articleBody h2', '#homePaths article', '#sceneGrid .scene', '[data-reveal]'];
  let observer = null;
  let running = null;

  function token(name, fallback) {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  }

  function ensureObserver() {
    if (observer || reduce.matches || !('IntersectionObserver' in window)) return observer;
    observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('is-revealed');
        observer.unobserve(entry.target);
      }
    }, { rootMargin: '0px 0px -10% 0px', threshold: 0.01 });
    return observer;
  }

  function revealables(root) {
    const scope = root || document;
    const found = new Set();
    for (const selector of REVEAL_SELECTORS) {
      scope.querySelectorAll(selector).forEach(node => found.add(node));
      if (scope !== document && scope.matches(selector)) found.add(scope);
    }
    return [...found];
  }

  function scan(root) {
    if (reduce.matches || !('IntersectionObserver' in window)) return;
    const watch = ensureObserver();
    for (const node of revealables(root)) {
      if (node.dataset.revealBound === '1' || node.classList.contains('is-revealed')) continue;
      node.dataset.revealBound = '1';
      // The CSS gate keys off [data-reveal]; a node selected by #articleBody h2
      // is invisible until it is revealed only once it carries that hook.
      node.setAttribute('data-reveal', '');
      const box = node.getBoundingClientRect();
      if (box.top < window.innerHeight && box.bottom > 0) { node.classList.add('is-revealed'); continue; }
      watch.observe(node);
    }
  }

  /* A reader who turns the preference on mid-visit must see everything, not a
     page of invisible blocks. Revealing in place beats reloading the document. */
  function revealEverything() {
    if (observer) { observer.disconnect(); observer = null; }
    revealables().forEach(node => node.classList.add('is-revealed'));
  }

  function fallbackSwap() {
    const main = document.querySelector('main[data-page]:not([hidden])') || document.body;
    main.animate(
      [{ opacity: 0, transform: 'translateY(' + token('--motion-rise', '10px') + ')' }, { opacity: 1, transform: 'none' }],
      { duration: parseInt(token('--motion-base', '220ms'), 10), easing: token('--ease-out', 'ease-out'), fill: 'none' }
    );
  }

  /* Returns the ViewTransition when there is one to await, undefined when the
     mutation already happened synchronously. Callers that must sequence after
     the DOM change use `ready`. */
  function transition(mutate) {
    if (reduce.matches || !document.startViewTransition) {
      mutate();
      if (!reduce.matches) fallbackSwap();
      return undefined;
    }
    if (running && running.skipTransition) { try { running.skipTransition(); } catch { /* already finished */ } }
    running = document.startViewTransition(() => mutate());
    return running;
  }

  document.documentElement.classList.add('motion-ready');
  window.Motion = {
    reduce: () => reduce.matches,
    transition,
    scan,
    revealEverything,
  };
  // Every view swap and every lazy render gets one scan; the scan is idempotent.
  window.addEventListener('purplebook:route', () => requestAnimationFrame(() => scan()));
  reduce.addEventListener('change', () => { if (reduce.matches) revealEverything(); });
})();
```

- [ ] **Step 5: index.html 链接样式表与脚本**

`index.html:8`（`<link rel="stylesheet" href="assets/styles.css?...">`）之前插入：

```html
  <link rel="stylesheet" href="assets/motion.css">
```

`index.html` 的 defer 清单里，把 `assets/asset-loader.js` 之后插入 `motion.js`（必须在 `paper.js` 之前，`route()` 会调用 `window.Motion.transition`）：

```html
<script defer src="assets/motion.js?v=000000000000"></script>
```

- [ ] **Step 6: route() 走过渡**

`assets/paper.js` 的 `route()` 内，从 `if(!inPlace)closeDialogs();` 到 `currentView=view;` 的整段（Task 5 之后行号已移动，按这两个锚点定位）替换为。注意 practice 分支必须保留 **Task 5 写入的按需注入版本**，不要退回成一句 `renderExerciseMap()`：

```js
    const apply = () => {
      if(!inPlace)closeDialogs();
      $$('[data-page]').forEach(p=>p.hidden=p.dataset.page!==view);
      document.body.dataset.view=view;
      $$('.desktop-nav [data-route]').forEach(a=>{if(a.dataset.route===view)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');});
      $('#headerAction').textContent=view==='reader'?t('nav.backHome'):t('nav.startReading');$('#headerAction').href=view==='reader'?'#home':'#chapter-1';
      $('#mobileChapterNav').hidden=view!=='reader';
      if(view==='reader') {
        if(currentChapter?.id!==chapter.id||currentView!=='reader'||pathChanged)renderChapter(chapter);
      } else {
        if(headingObserver)headingObserver.disconnect();
        document.title=t('doc.'+view)+t('doc.suffix');
        if(view==='contents')renderIndex();if(view==='paths')renderPath(sub);
        if(view==='practice'){
          if(window.ExerciseMap)renderExerciseMap();
          else{
            const practiceStatus=$('#exerciseMap');
            practiceStatus.textContent=t('practice.loading');
            ensureExerciseBundle().then(renderExerciseMap).catch(()=>{practiceStatus.textContent=t('practice.loadFailed');});
          }
        }
      }
      currentView=view;
    };
    // A language switch re-runs in place: no transition, no flash of the old copy.
    const swap = (inPlace || !window.Motion) ? (apply(), undefined) : window.Motion.transition(apply);
```

`route()` 内紧随其后的那段（原 `assets/paper.js:421-429`，即 `if(inPlace){updateProgress();return;}` 到函数结尾）替换为：

```js
    const after = () => requestAnimationFrame(()=>{
      if(view==='reader'&&sub){const target=document.getElementById(sub);if(target){target.scrollIntoView({block:'start',behavior:'instant'});target.tabIndex=-1;target.focus({preventScroll:true});}}
      else if(!samePath)window.scrollTo({top:0,behavior:'instant'});
      if(view==='reader')ensureCurrentChapterVisible();
      updateProgress();
      if(window.Motion)window.Motion.scan();
    });
    if(inPlace){after();return;}
    const analyticsPage=view==='reader'?chapter.id:view;
    if(analyticsPage!==previousPage)window.dispatchEvent(new CustomEvent('purplebook:route',{detail:{page:analyticsPage}}));
    if(swap && swap.ready) swap.ready.then(after, after); else after();
```

- [ ] **Step 7: 运行，确认通过**

Run: `node scripts/test-motion.cjs`
Expected: `13 passed, 0 failed`

- [ ] **Step 8: 版本哈希与站点自检**

Run: `node scripts/version-assets.mjs && node scripts/check-site.mjs && node scripts/test-exercise-wiring.cjs`
Expected: 全部 PASS

- [ ] **Step 9: 扩展浏览器 E2E（spec 第 6 节要求）**

`tests/discussion-browser.cjs` 第 47 行（`assert.deepEqual(errors,[]);`）之前插入：

```js
// Motion must be invisible to a reader who asked for it to be, and must not
// leave a stale page behind when it does run. Both are cheap to assert here and
// impossible to assert from the static suites.
const reduced = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 390, height: 700 } });
const quiet = await reduced.newPage();
quiet.on('pageerror', e => errors.push('reduced: ' + e.message));
await quiet.goto(env.APP_BASE_URL + '/#home');
await quiet.evaluate(() => location.hash = '#chapter-1');
await quiet.waitForFunction(() => document.body.dataset.view === 'reader');
const animated = await quiet.evaluate(() => [...document.querySelectorAll('#articleBody h2')]
  .some(node => getComputedStyle(node).transitionDuration !== '0s'));
assert.equal(animated, false, 'reduced motion still transitions chapter sections');
const visible = await quiet.evaluate(() => [...document.querySelectorAll('#articleBody h2')]
  .every(node => getComputedStyle(node).opacity === '1'));
assert.equal(visible, true, 'reduced motion left sections invisible');
await reduced.close();
```

Run: `node tests/discussion-browser.cjs`
Expected: 全部断言通过（该脚本自带 7861 端口隔离服务，结束后清理）。

- [ ] **Step 10: 全量回归**

Run: `PYTHONUTF8=1 .venv/Scripts/python.exe -m pytest tests -q && node scripts/test-motion.cjs && node scripts/test-asset-loading.cjs`
Expected: `147 passed`；`13 passed, 0 failed`；`8 passed, 0 failed`

- [ ] **Step 11: 提交**

```bash
git add assets/motion.css assets/motion.js assets/paper.js index.html tests/discussion-browser.cjs scripts/test-motion.cjs
git commit -m "feat(motion): one token-driven motion layer for views, reveals and controls"
```

---

### Task 7: 消除章节渲染的强制同步布局

**Files:**
- Modify: `assets/paper.js:352`、`assets/paper.js:369-371`、`assets/paper.js:373-393`、`assets/paper.js:445-446`
- Test: `scripts/test-motion.cjs`（追加静态断言）

**Interfaces:**
- Consumes: Task 6 的 `window.Motion.scan()`（同一 rAF 内完成几何读取）
- Produces:
  - `measureArticle() -> void`（内部）
  - `articleHeight: number`（模块内缓存，resize 与章节切换时重算）
  - `updateProgress()` 不再读取 `offsetHeight`

- [ ] **Step 1: 写失败测试（追加到 test-motion.cjs）**

`scripts/test-motion.cjs` 的 `check('index.html links motion.css', ...)` 之后追加：

```js
check('updateProgress reads no layout property', () => {
  const body = /function updateProgress\(\)\s*\{([\s\S]*?)\n  \}/.exec(PAPER);
  assert.ok(body, 'updateProgress not found in paper.js');
  for (const read of ['offsetHeight', 'offsetWidth', 'clientHeight', 'getBoundingClientRect']) {
    assert.ok(!body[1].includes(read), `updateProgress still reads ${read}`);
  }
});

check('the article height is measured once per resize and per chapter', () => {
  assert.match(PAPER, /function measureArticle\(\)/, 'measureArticle is missing');
  assert.match(PAPER, /window\.addEventListener\('resize',\s*\(\)=>\{measureArticle\(\);updateProgress\(\);\}\)/,
    'resize must re-measure before it re-renders the bar');
  assert.match(PAPER, /measureArticle\(\);/, 'renderChapter must measure once after the DOM settles');
});

check('the heading observer is armed inside a frame, not during writes', () => {
  const tail = /if\(headingObserver\)headingObserver\.disconnect\(\);([\s\S]{0,400}?)\n  \}/.exec(PAPER);
  assert.ok(tail, 'could not find the heading observer setup');
  assert.match(tail[1], /requestAnimationFrame/, 'observer setup must be deferred out of the write phase');
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node scripts/test-motion.cjs`
Expected: 新增 3 项 FAIL。

- [ ] **Step 3: 缓存文章高度**

`assets/paper.js:388-393`（`function updateProgress`）整段替换为：

```js
  let articleTop = 0, articleHeight = 1;
  /* Reading offsetHeight inside a scroll handler forces a layout on every frame
     of a 400k-word document. The article's box only changes when the chapter
     changes or the viewport does, so those are the only two moments we measure;
     the scroll handler then does arithmetic on scrollY, which reads no layout. */
  function measureArticle() {
    const article = $('#article');
    const rect = article.getBoundingClientRect();
    articleTop = rect.top + window.scrollY;
    articleHeight = Math.max(1, article.offsetHeight - window.innerHeight);
  }
  function updateProgress() {
    if(currentView!=='reader')return;
    $('#readingProgress').style.width=Math.max(0,Math.min(100,(window.scrollY-articleTop)/articleHeight*100))+'%';
    updateActiveHeading();
  }
```

`assets/paper.js:446`（`window.addEventListener('resize',updateProgress);`）替换为：

```js
  window.addEventListener('resize',()=>{measureArticle();updateProgress();},{passive:true});
```

- [ ] **Step 4: 渲染结束后统一测量与观察**

`assets/paper.js:369-371`（`headingObserver` 那段）替换为：

```js
    if(headingObserver)headingObserver.disconnect();
    // Everything below reads geometry. Doing it after the writes above, in one
    // frame, is what keeps renderChapter from forcing a layout per heading.
    requestAnimationFrame(()=>{
      headingObserver=new IntersectionObserver(updateActiveHeading,{rootMargin:'-12% 0px -65% 0px',threshold:0});
      chapter.headings.filter(h=>h.text.trim()).forEach(h=>{const target=document.getElementById(h.id);if(target)headingObserver.observe(target);});
      measureArticle();
      updateProgress();
    });
```

`assets/paper.js:352`（`$('#localToc').scrollTop=0;activeHeading='';`）替换为：

```js
    activeHeading='';
```

（`scrollTop=0` 是一次强制布局写入；`#localToc` 在 `renderChapter` 之后才被重新填充，滚动位置由 Step 4 的 rAF 统一归零。）

在 Step 4 的 `requestAnimationFrame` 体内 `measureArticle();` 之前补一行：

```js
      $('#localToc').scrollTop=0;
```

- [ ] **Step 5: 目录自动滚动移出读取路径**

`assets/paper.js:379-386`（`updateActiveHeading` 内 `if(active!==activeHeading)` 块）替换为：

```js
    if(active!==activeHeading) {
      activeHeading=active;
      requestAnimationFrame(()=>{
        const nav=$('#localToc'),link=nav.querySelector('[aria-current="location"]');
        if(link&&nav.clientHeight) {
          const bounds=nav.getBoundingClientRect(),rect=link.getBoundingClientRect();
          if(rect.top<bounds.top||rect.bottom>bounds.bottom)nav.scrollTop+=rect.top-bounds.top-(nav.clientHeight-rect.height)/2;
        }
      });
    }
```

- [ ] **Step 6: 运行，确认通过**

Run: `node scripts/test-motion.cjs && node scripts/check-site.mjs && node scripts/test-exercise-wiring.cjs`
Expected: 全部 PASS；`test-motion.cjs` 输出 `16 passed, 0 failed`

- [ ] **Step 7: 浏览器实测重排归零**

Run（本地起服务）: `PYTHONUTF8=1 .venv/Scripts/python.exe -m uvicorn app:app --host 127.0.0.1 --port 7861 --no-access-log`
然后在 Chrome DevTools 对 `http://127.0.0.1:7861/#chapter-1` 录一次 trace。
Expected: Forced reflow 总耗时 ≤ 10 ms（基线 70 ms），`renderChapter` 不再出现在重排榜首。

- [ ] **Step 8: 全量回归**

Run: `PYTHONUTF8=1 .venv/Scripts/python.exe -m pytest tests -q`
Expected: `147 passed`

- [ ] **Step 9: 提交**

```bash
git add assets/paper.js scripts/test-motion.cjs
git commit -m "perf(reader): stop forcing layout during chapter render and scroll"
```

---

### Task 8: 读者可见文案与退避重试

**Files:**
- Modify: `assets/discussion.js:45-50`（`api`）、`assets/discussion.js:143-148`
- Modify: `assets/wishes.js:8-12`（`api`）、`assets/wishes.js:41-48`
- Modify: `assets/analytics-dashboard.js`（`request` helper）
- Modify: `assets/locale/zh.js`、`en.js`、`es.js`
- Test: `scripts/test-reader-copy.cjs`（新建）

**Interfaces:**
- Consumes: Task 2 的 `503` + `Retry-After` + `fallback: true`
- Produces:
  - `friendlyStatus(status) -> string`（每个文件内各自持有，走同一批 i18n key）
  - `api()` 对 503 最多重试 2 次，退避 400ms / 800ms
  - 新增 i18n key：`error.serviceDown`、`error.retryLater`、`error.network`、`error.rateLimited`

- [ ] **Step 1: 写失败测试**

创建 `scripts/test-reader-copy.cjs`：

```js
/* No reader should ever see "Failed to fetch" or a Python exception string.
   These checks read the shipped sources, because the mapping is the contract.
   Run with: node scripts/test-reader-copy.cjs */
'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

const ROOT = resolve(__dirname, '..');
const read = path => readFileSync(resolve(ROOT, path), 'utf8');
const FILES = ['assets/discussion.js', 'assets/wishes.js', 'assets/analytics-dashboard.js'];
const KEYS = ['error.serviceDown', 'error.retryLater', 'error.network', 'error.rateLimited'];

let passed = 0;
const failures = [];
function check(name, body) {
  try { body(); passed += 1; console.log('ok  ' + name); }
  catch (error) { failures.push([name, error]); console.log('FAIL ' + name + ': ' + error.message); }
}

check('no reader-facing surface prints a raw error.message', () => {
  for (const file of FILES) {
    const offenders = [...read(file).matchAll(/\.textContent\s*=\s*error\.message|\.textContent\s*=\s*e\.message/g)];
    assert.equal(offenders.length, 0, `${file} still shows ${offenders.length} raw error strings`);
  }
});

check('each file maps status codes through friendlyStatus', () => {
  for (const file of FILES) {
    assert.match(read(file), /function friendlyStatus\(status\)/, `${file} has no friendlyStatus`);
  }
});

check('write requests back off on 503', () => {
  for (const file of ['assets/discussion.js', 'assets/wishes.js']) {
    const source = read(file);
    assert.match(source, /response\.status\s*===\s*503|status\s*===\s*503/, `${file} does not look for 503`);
    assert.match(source, /attempts|attempt/, `${file} does not count retries`);
  }
});

check('all four keys exist in all three locales', () => {
  for (const code of ['zh', 'en', 'es']) {
    const source = read(`assets/locale/${code}.js`);
    for (const key of KEYS) assert.ok(source.includes(`'${key}'`), `${code} is missing ${key}`);
  }
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exitCode = 1;
```

- [ ] **Step 2: 运行，确认失败**

Run: `node scripts/test-reader-copy.cjs`
Expected: FAIL —raw `error.message` 仍存在、`friendlyStatus` 缺失。

- [ ] **Step 3: discussion.js 的 api 与文案**

`assets/discussion.js:45-50` 替换为：

```js
  const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
  function friendlyStatus(status) {
    if (status === 503) return t('error.serviceDown');
    if (status === 429) return t('error.rateLimited');
    return t('error.retryLater');
  }
  async function api(path,options={}) {
    // A 503 from the write endpoints means "same request, later", and the draft
    // is still in the textarea, so backing off is free for the reader.
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await fetch(path,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf,...options.headers}});
      } catch {
        if (attempt < 2) { await wait(400 * (attempt + 1)); continue; }
        throw new Error(t('error.network'));
      }
      if (response.status === 503 && attempt < 2) { await wait(400 * (attempt + 1)); continue; }
      let data;try{data=await response.json();}catch{throw new Error(friendlyStatus(response.status));}
      if(!response.ok){if(response.status===401)refreshSession();throw new Error(typeof data.detail==='string'?data.detail:friendlyStatus(response.status));}
      return data;
    }
  }
```

`assets/discussion.js` 内其余 6 处 `status.textContent=e.message`（`:60`、`:68`、`:109`、`:121`、`:139`、`:144`）统一改为：

```js
status.textContent=t('error.retryLater')
```

其中 `:147` 的 `catch(error){status.textContent=error.message;}` 改为：

```js
  catch(error){status.textContent=error instanceof Error && error.message ? error.message : t('error.retryLater');}
```

（服务器返回的 `detail` 已是中文文案，保留；只有非 JSON 与网络失败被替换成站点文案。）

- [ ] **Step 4: wishes.js 同样处理**

`assets/wishes.js:8-12` 替换为：

```js
  const wait=ms=>new Promise(resolveWait=>setTimeout(resolveWait,ms));
  function friendlyStatus(status){
    if(status===503)return t('error.serviceDown');
    if(status===429)return t('error.rateLimited');
    return t('error.retryLater');
  }
  async function api(path,options={}){
    for(let attempt=0;;attempt+=1){
      let r;
      try{r=await fetch(path,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json','X-CSRF-Token':session.csrf}});}
      catch{if(attempt<2){await wait(400*(attempt+1));continue;}throw Error(t('error.network'));}
      if(r.status===503&&attempt<2){await wait(400*(attempt+1));continue;}
      let data;try{data=await r.json();}catch{throw Error(friendlyStatus(r.status));}
      if(!r.ok){if(r.status===401)refreshSession();throw Error(typeof data.detail==='string'?data.detail:friendlyStatus(r.status));}
      return data;
    }
  }
```

`assets/wishes.js:20`、`:28`、`:37`、`:46` 的 `=e.message` / `=error.message` 改为 `=t('error.retryLater')`。

- [ ] **Step 5: analytics-dashboard.js 同样处理**

`assets/analytics-dashboard.js:162` 与 `:172` 的 `$('#dashboardStatus').textContent=error.message;` 改为：

```js
      $('#dashboardStatus').textContent=friendlyStatus(error.status||0);
```

并在同文件 `loadSummary` 之前补：

```js
  function friendlyStatus(status){
    if(status===503)return '统计服务暂时不可用，请稍后刷新';
    if(status===401)return '请登录或刷新页面后重试';
    return '读取统计数据失败，请稍后刷新';
  }
```

（`analytics.html` 不在 i18n 覆盖范围内，保持中文串，与文件内既有文案一致。）

- [ ] **Step 6: 补三语词条**

`assets/locale/zh.js` 的 `error.*` 键区补：

```js
  'error.serviceDown': '服务暂时不可用，正在自动重试…',
  'error.retryLater': '操作没有成功，请稍后重试',
  'error.network': '网络连接失败，请检查网络后重试',
  'error.rateLimited': '操作太频繁，请稍后再试',
```

`assets/locale/en.js`：

```js
  'error.serviceDown': 'The service is briefly unavailable. Retrying…',
  'error.retryLater': 'That did not go through. Please try again.',
  'error.network': 'Network connection failed. Check your connection and retry.',
  'error.rateLimited': 'Too many actions. Please wait a moment.',
```

`assets/locale/es.js`：

```js
  'error.serviceDown': 'El servicio no está disponible por un momento. Reintentando…',
  'error.retryLater': 'La acción no se completó. Inténtalo de nuevo.',
  'error.network': 'Falló la conexión de red. Revísala y reintenta.',
  'error.rateLimited': 'Demasiadas acciones. Espera un momento.',
```

- [ ] **Step 7: 运行，确认通过**

Run: `node scripts/test-reader-copy.cjs`
Expected: `4 passed, 0 failed`

- [ ] **Step 8: 全量回归**

Run: `PYTHONUTF8=1 .venv/Scripts/python.exe -m pytest tests -q && node scripts/check-site.mjs && node scripts/test-exercise-wiring.cjs && node scripts/test-exercise-ui.cjs`
Expected: 全部 PASS

- [ ] **Step 9: 提交**

```bash
git add assets/discussion.js assets/wishes.js assets/analytics-dashboard.js assets/locale scripts/test-reader-copy.cjs
git commit -m "fix(reader): back off on 503 and stop showing readers raw errors"
```

---

### Task 9: 收尾清理（死文件、表单 name、资源版本）

**Files:**
- Delete: `assets/app.js`
- Modify: `assets/language-switcher.js:13-16`
- Modify: `scripts/check-site.mjs:60-68`（追加 eager 清单断言）
- Test: `scripts/test-motion.cjs`（追加 2 项）

**Interfaces:**
- Consumes: Task 4/6 的 index.html 脚本清单
- Produces: `index.html` 中不存在 `assets/app.js` 引用；每个 `language-select` 具备 `name`

- [ ] **Step 1: 写失败测试**

`scripts/test-motion.cjs` 末尾 `console.log` 之前追加：

```js
check('the dead app.js is gone', () => {
  assert.ok(!HTML.includes('assets/app.js'), 'index.html still references app.js');
  let exists = true;
  try { read('assets/app.js'); } catch { exists = false; }
  assert.ok(!exists, 'assets/app.js still on disk');
});

check('every generated language picker is a named control', () => {
  assert.match(read('assets/language-switcher.js'), /select\.name\s*=/, 'the picker has no name');
});

check('index.html ships nothing eager beyond the three essentials', () => {
  const eager = [...HTML.matchAll(/<script(?![^>]*\bdefer\b)[^>]*\ssrc="([^"]+)"/g)].map(m => m[1]);
  assert.deepEqual(eager.map(name => name.split('?')[0]).sort(), [
    'assets/content.js', 'assets/i18n.js', 'assets/locale/zh.js',
  ].sort());
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node scripts/test-motion.cjs`
Expected: 新增 3 项 FAIL。

- [ ] **Step 3: 给语言选择器补 name**

`assets/language-switcher.js:13`（`const select = document.createElement('select');`）之后插入：

```js
    select.name = 'language';
```

- [ ] **Step 4: 删除死文件**

Run: `git rm assets/app.js`
Expected: `rm 'assets/app.js'`

- [ ] **Step 5: check-site 增加 eager 清单守卫**

`scripts/check-site.mjs:68`（`assert(scriptOrder.indexOf('motion.js')<...)`）之后追加：

```js
const eager=[...indexHtml.matchAll(/<script(?![^>]*\bdefer\b)[^>]*\ssrc="([^"]+)"/g)].map(m=>m[1].split('?')[0]);
assert.deepEqual(eager.sort(),['assets/content.js','assets/i18n.js','assets/locale/zh.js'].sort(),
  'index.html gained an eager script; anything beyond the three essentials must be defer or lazy');
```

- [ ] **Step 6: 运行，确认通过**

Run: `node scripts/test-motion.cjs && node scripts/check-site.mjs`
Expected: `19 passed, 0 failed`；check-site PASS

- [ ] **Step 7: 全量回归**

Run: `PYTHONUTF8=1 .venv/Scripts/python.exe -m pytest tests -q`
Expected: `147 passed`

- [ ] **Step 8: 提交**

```bash
git add assets/language-switcher.js scripts/check-site.mjs scripts/test-motion.cjs
git commit -m "chore: drop the unreferenced app.js and name the language control"
```

---

### Task 10: 度量、部署与文档

**Files:**
- Modify: `AUTH-AND-DISCUSSION.md:89-97`（已知问题段落）
- Modify: `docs/plans/2026-11-07-motion-performance-ledger.md`（新建，实测数据留档）
- Server: `/data/ms-cookbook`（同步 + 重启）

**Interfaces:**
- Consumes: Task 1-9 的全部产出
- Produces: 前后对比表、服务器与本地源码哈希一致、线上实测通过

- [ ] **Step 1: 记录优化前基线**

在本地 `http://127.0.0.1:7861` 与生产 `http://120.53.222.178:8899` 各录一次 `#chapter-1` trace，把 LCP / load delay / CLS / 强制重排 / 请求数 / 传输字节填进 `docs/plans/2026-11-07-motion-performance-ledger.md` 的"优化前"列。基线数值以 spec 第 2 节实测表为准，不得凭记忆填写。

- [ ] **Step 2: 更新已知问题文档**

`AUTH-AND-DISCUSSION.md:89-97` 段落末尾的 `**当前状态：未修。**` 改为：

```markdown
**当前状态：已加兜底，未改根因。** 三个端点在只读型 `sqlite3.OperationalError` 下返回 `503` + `Retry-After: 2` + `fallback: true`，读者已输入内容保留在前端并自动重试两次（400ms、800ms）；其他 `OperationalError`（如 `database is locked`）仍按原路径抛出。真正的修法——消除短生命周期连接——仍未执行，因为那会改变"一次操作一个连接"的既有约定。回归由 `tests/test_write_fallback.py` 守住。
```

并在"验证"小节补一行：

```markdown
node scripts/test-motion.cjs && node scripts/test-asset-loading.cjs && node scripts/test-reader-copy.cjs
```

- [ ] **Step 3: 全量本地验证**

Run:
```bash
PYTHONUTF8=1 .venv/Scripts/python.exe -m pytest tests -q
node scripts/check-site.mjs
node scripts/test-motion.cjs
node scripts/test-asset-loading.cjs
node scripts/test-reader-copy.cjs
node scripts/test-exercise-wiring.cjs
node scripts/test-exercise-ui.cjs
node --check assets/discussion.js && node --check assets/wishes.js && node --check assets/motion.js && node --check assets/asset-loader.js
```
Expected: 全部 PASS，无语法错误。

- [ ] **Step 4: 浏览器实测（本地）**

对 `http://127.0.0.1:7861` 逐项确认并在留档表里打勾：
- 首页 → `#chapter-1` → `#contents` → `#practice` 四次切换均有淡入位移，且控制台 0 error
- DevTools 设 `prefers-reduced-motion: reduce` 后重载：路由切换无动画、正文 h2 立即可见
- `#practice` 首次进入才出现 6 个练习模块请求；二次进入不再重复请求
- 切到 English：`locale/en.js` 与 `content-i18n/en.js` 此刻才下载；切回中文不再重新下载
- 断网重试：DevTools offline 下提交评论，看到自动重试与最终中文提示，无 `Failed to fetch`

- [ ] **Step 5: 同步服务器**

Run:
```bash
ssh -o BatchMode=yes shenmian 'cd /data/ms-cookbook && cp -p ecosystem.config.js backups/ecosystem.config.js.$(date +%Y%m%d-%H%M%S)' 
```
然后按 Task 1-9 的改动文件清单打包同步（沿用本仓库既有做法：`tar` 排除 `.git .venv .data __pycache__ .pytest_cache .workbuddy .commandcode .superpowers logs backups ecosystem.config.js deployment.json`），并在服务器上重跑：
```bash
ssh -o BatchMode=yes shenmian 'cd /data/ms-cookbook && .venv/bin/python -m pytest tests -q && node scripts/check-site.mjs && node scripts/test-motion.cjs && node scripts/test-asset-loading.cjs && node scripts/test-reader-copy.cjs'
```
Expected: 与本地同样的通过数。

- [ ] **Step 6: 重启并核对线上**

Run: `ssh -o BatchMode=yes shenmian 'cd /data/ms-cookbook && pm2 restart ms-cookbook --update-env >/dev/null && sleep 4 && pm2 list --no-color | grep ms-cookbook'`
Expected: `online`，无重启计数增长。

再用 curl 核对响应头：
```bash
curl -sI -H 'Accept-Encoding: gzip' 'http://120.53.222.178:8899/assets/paper.js?v=1e735b17c1d5' | tr -d '\r' | grep -iE 'content-encoding|cache-control'
curl -sI -H 'Accept-Encoding: gzip' 'http://120.53.222.178:8899/assets/manuscript-20260914/c01-065d3d9ab0de58.webp' | tr -d '\r' | grep -iE 'content-type|content-encoding'
```
Expected: 第一条同时出现 `content-encoding: gzip` 与 `cache-control: public, max-age=31536000, immutable`；第二条 `content-type: image/webp` 且**没有** `content-encoding`。

- [ ] **Step 7: 线上浏览器实测**

对 `http://120.53.222.178:8899` 重复 Step 4 的全部检查项，并录一次 `#chapter-1` trace 填入留档表"优化后（生产）"列。逐项对照 spec 第 5 节目标值；任一未达标必须写明实测值与原因，不得只写"已优化"。

- [ ] **Step 8: 源码一致性核对**

按本仓库既有做法对本地与服务器 900 个源码文件逐一 SHA-256 比对（排除 `.git .venv .data __pycache__ .pytest_cache logs backups ecosystem.config.js run.sh` 等运行时文件）。
Expected: `differing: []`、`remote-only: []`。

- [ ] **Step 9: 提交**

```bash
git add AUTH-AND-DISCUSSION.md docs/plans/2026-11-07-motion-performance-ledger.md
git commit -m "docs: record the motion and performance work with before/after measurements"
```

---

## 完成判据

- `PYTHONUTF8=1 .venv/Scripts/python.exe -m pytest tests -q` ≥ 147 passed，本地与服务器一致
- `node scripts/check-site.mjs` 及 4 个新增 node 套件全绿
- spec 第 5 节 8 项指标逐项达标（或留档说明未达标原因）
- 生产 `#chapter-1` trace 无 > 50 ms 长任务、控制台 0 error、`prefers-reduced-motion` 下无动画
- 本地与服务器源码逐文件哈希一致
