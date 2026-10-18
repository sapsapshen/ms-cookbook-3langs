# Super Intelligence Learning Space (SILS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 ms-cookbook 从静态阅读站扩展为交互式学习空间：34 章配套约 100 条练习（zh/en/es 三语），读者可在浏览器 Pyodide 沙箱中写代码、运行、获得自动判分反馈，并跟踪学习进度。

**Architecture:** 四层单向依赖。L1 练习数据（`content/exercises/`，完全独立于 `content/chapters/`，避开 i18n 块序号机制）→ L2 Pyodide Web Worker 沙箱（懒加载）→ L3 纯函数判分器（可在 Node 单测）→ L4 进度存储（浏览器本地优先 + 登录后 SQLite 同步）。判分三级降级：确定性断言 → LLM 评分（默认关闭）→ 参考答案 + 自评，任何一级失败都不阻断阅读。

**Tech Stack:** Python 3（构建与测试）、Node.js 22+（前端单测）、原生 JS（无框架无打包）、FastAPI + SQLite（服务端进度）、Pyodide 0.26.4 WASM（浏览器沙箱）、pytest / node:assert（测试）

**Spec:** `docs/superpowers/specs/2026-10-18-sils-design.md`

---

## Global Constraints

以下约束对**每个任务**都生效。这些是从现有代码读出的事实，不是建议 —— 违反会导致 CI 失败或线上 404。

| # | 约束 | 出处 |
|---|---|---|
| G1 | 章节 HTML 白名单禁止 `<button> <input> <details> <iframe> <select> <form>`；禁止任何 `on*` 属性 | `scripts/build-content.py:23,184,185` |
| G2 | 翻译管线按**块序号**索引（`{"0":"…","1":"…"}`），章内插入新块会让 `build-i18n.py --check` 序号全位移 | `scripts/build-i18n.py:170` |
| G3 | `build-content.py --check` 与 `build-i18n.py --check` 是**字节级全等**比对 | `scripts/build-content.py:173-178,214-216` |
| G4 | `app.py:256` 的 chapters 映射排除 `status=='pending'` → chapter-24 不可用 | `app.py:256` |
| G5 | 写操作必须 `require_user`（CSRF token + 同源）+ 限流 + `BEGIN IMMEDIATE` | `app.py:302-322,544-555` |
| G6 | 路由 view 白名单硬编码；新增 view 名必须改该行 | `assets/paper.js:392` |
| G7 | analytics page/title 白名单与 G6 同步 | `app.py:258-259` |
| G8 | `assets/*.js\|css` 带 `?v=<sha25612>` 缓存指纹，改动后必须跑 `node scripts/version-assets.mjs` | `scripts/version-assets.mjs` |
| G9 | Pyodide **绝不进 `index.html` 的 script 标签**，只在点击「运行」时 `importScripts` | 设计 §5.1 |
| G10 | 判分器 `assets/exercise-grader.js` 是纯函数：不碰 DOM、不发网络、不读 `window` | 设计 §6.4 |
| G11 | 练习功能任何故障都**不得阻断阅读** | 设计 §9 |
| G12 | 不可在浏览器真实运行的题（GPU/微调/TTS/外部 API/Agent 框架运行时）一律 `reflect` 型，**不写运行按钮** | 设计 §11.3 |
| G13 | 不修改：`content/source-html/**`、`content/chapters/**`、`content/manifest.json`、`scripts/build-content.py`、`scripts/build-i18n.py`、`scripts/chapter_markdown.py` | 设计 §12 |
| G14 | `analytics_pages` 中 `'practice'` 已存在，练习面板**不分独立 page**（复用 `purplebook:route`） | `app.py:258` |

**Pyodide 版本锁定：`0.26.4`。** 理由：该版本仍提供 UMD 形态的 `pyodide.js`，可在经典 Worker 中用 `importScripts` 加载。0.27+ 转向 ESM + 异步加载，会破坏 `importScripts` 路径。不要升级。

**Worker 路径基准**：Worker 文件位于 `assets/exercise-worker.js`，因此 `importScripts` 必须用 `./vendor/pyodide/pyodide.js`（解析为 `assets/vendor/pyodide/pyodide.js`），**不是** `../vendor/...`。

---

## File Structure

**新增文件及其单一职责**

| 文件 | 职责 |
|---|---|
| `content/exercises/manifest.json` | 练习集索引：语言列表、章节启用表、id 前缀表 |
| `content/exercises/{zh,en,es}/chapter-NN.json` | 单章练习数组（每语言 34 个文件，共 102 个） |
| `scripts/build-exercises.py` | 校验 + 生成 `assets/exercises.js`（含 `--check` 字节比对） |
| `scripts/test_exercises.py` | 构建期强校验的独立测试入口（含 vendor 完整性） |
| `scripts/vendor-pyodide.mjs` | 下载并校验 Pyodide 0.26.4 到 `assets/vendor/pyodide/` |
| `scripts/test-exercise-grader.cjs` | L3 判分器 Node 单测（8 种 check kind + 阈值 + 降级） |
| `scripts/test-exercise-map.cjs` | 学习地图聚合逻辑 Node 单测 |
| `assets/exercises.js` | **生成物**：`window.EXERCISE_DATA` |
| `assets/exercise-grader.js` | L3 纯函数判分器（浏览器 + Node 双导出） |
| `assets/exercise-store.js` | L4 进度存储：本地读写、内存降级、合并策略 |
| `assets/exercise-sandbox.js` | L2 主线程门面：Worker 生命周期、超时、崩溃重建 |
| `assets/exercise-worker.js` | L2 Worker 内部：加载 Pyodide、跑代码、评估 check |
| `assets/exercise-ui.js` | 章节页练习面板渲染与交互 |
| `assets/exercise-map.js` | `#practice` 学习地图渲染 |
| `assets/exercise.css` | 练习面板与学习地图样式 |
| `assets/vendor/pyodide/*` | Pyodide 0.26.4 分发文件 + `VERSION` |
| `tests/test_exercise_api.py` | L4 服务端 API 测试 |

**修改文件及改动点**

| 文件 | 改动 |
|---|---|
| `app.py:91` | `executescript` 追加 `exercise_progress` 表 |
| `app.py` 新增段（约 566 行后） | `ExerciseProgress` pydantic 模型 + 3 个端点 |
| `assets/paper.js:108,422` | 加 `renderExerciseMap()` 调用 |
| `assets/paper.js:392` | **不改**（`'practice'` 已在白名单） |
| `index.html:132-134` | 加 5 个 script + 1 个 css（**不含 pyodide**） |
| `index.html` practice 段 | 加 `<div id="exerciseMap">` 容器 |
| `scripts/check-site.mjs:50` | CSS 校验列表加 `assets/exercise.css` |
| `scripts/check-site.mjs` 尾部 | 加练习数据断言 |
| `.github/workflows/deploy-modelscope.yml` | +2 步 + paths 白名单 |
| `assets/locale/{zh,en,es}.js` | 加 `exercise.*` 词条（三份 key 集合必须一致） |
| `AUTH-AND-DISCUSSION.md` | 补练习数据与隐私说明 |
| `README.md` / `README.zh-CN.md` | 补练习功能段落 |

---

## Task 1: 建立基线与回归护栏

在任何改动前，先确认现状是绿的，并写一个能捕获「现有功能被破坏」的回归测试。

**Files:**
- Create: `tests/test_regression_baseline.py`
- Read-only 验证: 全部现有文件

**Interfaces:**
- Consumes: `app.create_app(data_dir, analytics_runtime_dir)`（`app.py:196`），`tests/test_discussion.py:10` 的 `site` fixture
- Produces: 无（纯护栏）

- [ ] **Step 1: 确认基线全绿**

```bash
cd D:/Coding/ms-cookbook
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt pytest
.venv/bin/python -m pytest tests -q
node scripts/build-content.mjs --check
python3 scripts/build-i18n.py --check
node scripts/check-site.mjs
```

Expected: pytest 全绿（`test_discussion.py` + `test_analytics.py`）；三个脚本均输出 Verified/PASS。

若任一失败，**停止并修复基线**，不要在破损基线上叠加新功能。

- [ ] **Step 2: 写回归测试**

`tests/test_regression_baseline.py`：

```python
"""Baseline invariants: the reading community must keep working untouched."""
import json
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parent.parent


def book_data():
    raw = (ROOT / 'assets' / 'content.js').read_text(encoding='utf-8')
    return json.loads(raw.split('=', 1)[1].strip().rstrip(';'))


def test_chapter_payload_shape_unchanged():
    data = book_data()
    assert data['chapterCount'] == 35
    for chapter in data['chapters']:
        for key in ('id', 'number', 'title', 'sourceUrl', 'editUrl', 'minutes',
                    'status', 'headings', 'html', 'imageCount', 'attachmentCount',
                    'discussionId'):
            assert key in chapter, f'{chapter.get("id")} lost {key}'
        assert not chapter['html'].lower().count('<script')


def test_i18n_editions_still_complete():
    for code in ('en', 'es'):
        raw = (ROOT / 'assets' / 'content-i18n' / f'{code}.js').read_text(encoding='utf-8')
        assert raw.startswith('window.'), f'{code} edition lost its global'
        assert len(raw) > 100_000, f'{code} edition looks truncated'


@pytest.fixture
def site(tmp_path, monkeypatch):
    monkeypatch.setenv('APP_BASE_URL', 'http://127.0.0.1:7860')
    monkeypatch.delenv('OAUTH_CLIENT_ID', raising=False)
    monkeypatch.delenv('OAUTH_CLIENT_SECRET', raising=False)
    from app import create_app
    return create_app(tmp_path), tmp_path


def test_existing_endpoints_untouched(site):
    client = TestClient(site[0])
    assert client.get('/').status_code == 200
    assert client.get('/api/session').status_code == 200
    assert client.get('/api/analytics/summary').status_code == 200
    assert client.get('/api/chapters/chapter-1/entries').status_code == 200
    assert client.get('/api/chapters/chapter-24/entries').status_code == 404
    assert client.get('/api/wishes').status_code == 200


def test_locale_key_parity():
    def keys(path):
        import re
        return set(re.findall(r"^\s*'([^']+)':", path.read_text(encoding='utf-8'), re.M))
    base = ROOT / 'assets' / 'locale'
    zh = keys(base / 'zh.js')
    for code in ('en', 'es'):
        other = keys(base / f'{code}.js')
        assert other == zh, f'{code}.js key set diverges: {sorted(zh ^ other)[:10]}'
```

- [ ] **Step 3: 运行**

```bash
.venv/bin/python -m pytest tests/test_regression_baseline.py -v
```

Expected: 5 passed。

若 `test_locale_key_parity` 失败，说明基线本身 locale 就不一致 —— 记录实际差异并修复，不要跳过。

- [ ] **Step 4: 提交**

```bash
git add tests/test_regression_baseline.py
git commit -m "test: add baseline regression guard before SILS work"
```

---

## Task 2: 构建脚本与 schema 校验

**Files:**
- Create: `scripts/build-exercises.py`
- Create: `content/exercises/manifest.json`
- Create: `scripts/test_exercises.py`

**Interfaces:**
- Consumes: `content/manifest.json`（取 `number` / `status` / `partIndex`）、`content/exercises/{lang}/chapter-NN.json`
- Produces: `assets/exercises.js` 赋值 `window.EXERCISE_DATA`，结构：
  ```js
  { title, version, languages:['zh','en','es'], exerciseCount,
    packages: [],
    chapters: { 'chapter-1': { chapter:'chapter-1', number:1, partIndex:0,
                               count:3, minutes:18,
                               exercises: { zh:[Exercise], en:[Exercise], es:[Exercise] } } } }
  ```
  `Exercise` 字段：`{id, chapter, type, difficulty, minutes, objective, prompt, starter, checks, llm_rubric, reference, explanation}`

- [ ] **Step 1: 写失败的测试**

`scripts/test_exercises.py`（同时是可独立运行的校验入口）：

```python
"""Exercise corpus validation. Runs standalone or under pytest."""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EX = ROOT / 'content' / 'exercises'
LANGUAGES = ['zh', 'en', 'es']

TYPES = {'code', 'predict', 'fill', 'build', 'reflect'}
SANDBOX_TYPES = {'code', 'build'}
CHECK_SPEC = {
    'assert_python': ('code',),
    'stdout_contains': ('value',),
    'stdout_equals': ('value',),
    'stdout_matches': ('pattern',),
    'var_equals': ('name', 'value'),
    'var_in_range': ('name', 'min', 'max'),
    'output_choice': ('correct',),
    'self_assessed': (),
}
CJK = re.compile(r'[一-鿿　-〿＀-￯]')


def book_chapters():
    data = json.loads((ROOT / 'content' / 'manifest.json').read_text(encoding='utf-8'))
    return {f"chapter-{c['number']}": c for c in data['chapters']}


def load_exercises():
    manifest = json.loads((EX / 'manifest.json').read_text(encoding='utf-8'))
    books = book_chapters()
    corpus = {}
    for entry in manifest['chapters']:
        chapter_id = entry['chapter']
        book = books[chapter_id]
        assert book['status'] == 'ready', f'{chapter_id} is pending and must be excluded'
        prefix = f"ch{book['number']:02d}"
        assert entry['idPrefix'] == prefix, f'{chapter_id} idPrefix must be {prefix}'
        for lang in LANGUAGES:
            path = EX / lang / f"chapter-{book['number']:02d}.json"
            assert path.exists(), f'missing {path.relative_to(ROOT)}'
            items = json.loads(path.read_text(encoding='utf-8'))
            assert isinstance(items, list) and items, f'{path.name} must be a non-empty array'
            for item in items:
                item['_file'] = f'{lang}/{path.name}'
                item['_chapter'] = chapter_id
                item['_number'] = book['number']
            corpus[(chapter_id, lang)] = items
    return manifest, corpus


def validate_item(item, lang):
    where = f"{item['_file']}:{item['id']}"
    for key in ('id', 'chapter', 'type', 'objective', 'prompt', 'explanation'):
        assert isinstance(item.get(key), str) and item[key].strip(), f'{where} missing {key}'
    assert item['chapter'] == item['_chapter'], f'{where} chapter mismatch'
    assert item['id'].startswith(f"ch{item['_number']:02d}-ex"), f'{where} id must be chNN-exNN'
    assert item['type'] in TYPES, f'{where} unknown type {item["type"]}'
    assert item['difficulty'] in (1, 2, 3), f'{where} difficulty must be 1-3'
    assert isinstance(item['minutes'], int) and 1 <= item['minutes'] <= 60, f'{where} minutes out of range'
    assert len(item['objective']) <= 60, f'{where} objective too long'

    checks = item.get('checks') or []
    assert isinstance(checks, list), f'{where} checks must be an array'
    graded = [c for c in checks if c.get('kind') != 'self_assessed']
    for check in checks:
        kind = check.get('kind')
        assert kind in CHECK_SPEC, f'{where} unknown check kind {kind}'
        for field in CHECK_SPEC[kind]:
            assert field in check, f'{where} check {kind} missing {field}'
        assert isinstance(check.get('weight'), (int, float)) and check['weight'] >= 1, \
            f'{where} check {kind} weight must be a number >= 1'
        if kind == 'assert_python':
            compile(check['code'], '<check>', 'exec')
        if kind == 'stdout_matches':
            re.compile(check['pattern'])
        if kind == 'output_choice':
            assert isinstance(check['correct'], list) and check['correct'], \
                f'{where} output_choice.correct must be a non-empty array'

    if item['type'] == 'reflect':
        assert isinstance(item.get('reference'), str) and item['reference'].strip(), \
            f'{where} reflect needs a reference'
        assert not graded, f'{where} reflect must not carry graded checks'
    else:
        assert graded, f'{where} needs at least one graded check'
        if item['type'] in SANDBOX_TYPES:
            assert isinstance(item.get('starter'), str), f'{where} needs starter code'

    rubric = item.get('llm_rubric') or {}
    assert isinstance(rubric.get('enabled', False), bool), f'{where} llm_rubric.enabled must be bool'

    if lang in ('en', 'es'):
        for key in ('objective', 'prompt', 'explanation', 'reference'):
            value = item.get(key)
            if isinstance(value, str) and value:
                assert not CJK.search(value), f'{where} {key} still contains Chinese'


def run_checks():
    manifest, corpus = load_exercises()
    assert manifest['languages'] == LANGUAGES, 'manifest.languages must be zh,en,es'
    assert manifest['version'] == 1
    assert isinstance(manifest.get('packages'), list)
    base_ids = None
    for (chapter_id, lang), items in corpus.items():
        ids = [item['id'] for item in items]
        assert len(set(ids)) == len(ids), f'{chapter_id}/{lang} has duplicate ids'
        for item in items:
            validate_item(item, lang)
        if lang == 'zh' and base_ids is None:
            base_ids = (chapter_id, set(ids))
    assert base_ids is not None, 'no zh exercises found'
    assert base_ids[1], 'at least one zh exercise required'
    seen = set()
    for chapter_id, _ in corpus:
        zh = {item['id'] for item in corpus[(chapter_id, 'zh')]}
        for lang in ('en', 'es'):
            other = {item['id'] for item in corpus[(chapter_id, lang)]}
            assert zh == other, f'{chapter_id}/{lang} id set diverges: {sorted(zh ^ other)}'
        seen |= zh
    # Compare the union of every chapter's ids against the total count, not
    # against one chapter: base_ids only holds the first zh chapter.
    total = sum(len(v) for (_, lang), v in corpus.items() if lang == 'zh')
    assert len(seen) == total, 'exercise ids repeat across chapters'
    return manifest, corpus


def test_corpus_valid():
    manifest, corpus = run_checks()
    total = sum(len(v) for (c, lang), v in corpus.items() if lang == 'zh')
    assert total >= 1


if __name__ == '__main__':
    try:
        manifest, corpus = run_checks()
    except AssertionError as error:
        print(f'FAIL: {error}', file=sys.stderr)
        sys.exit(1)
    total = sum(len(v) for (c, lang), v in corpus.items() if lang == 'zh')
    print(f'PASS: {total} exercises across {len({c for c, _ in corpus})} chapters, {len(LANGUAGES)} languages')
```

- [ ] **Step 2: 运行测试确认失败**

```bash
.venv/bin/python scripts/test_exercises.py
```

Expected: `FAIL: [Errno 2] No such file or directory` 或 KeyError `manifest.json`。

- [ ] **Step 3: 创建 manifest**

`content/exercises/manifest.json`（**先只启用 3 章**，Task 14 再展开到 34 章 —— 这样 Task 3 到 Task 13 全程可构建、可测试、可校验）：

```json
{
  "title": "ModelScope Cookbook 练习集",
  "version": 1,
  "languages": ["zh", "en", "es"],
  "packages": [],
  "chapters": [
    { "chapter": "chapter-7", "idPrefix": "ch07" },
    { "chapter": "chapter-13", "idPrefix": "ch13" },
    { "chapter": "chapter-33", "idPrefix": "ch33" }
  ]
}
```

**为何先只启用 3 章**：`build-exercises.py` 与 `scripts/test_exercises.py` 会对 manifest 里每一章要求三语内容齐备。若一开始就声明 34 章，Task 3 到 Task 13 的每一条校验命令都会因「其他 31 章缺内容」而失败，Task 7 的 API 测试和 Task 10 的 `check-site.mjs` 也拿不到 `assets/exercises.js`。Task 14 会把 `chapters` 展开到完整 34 章。

**注意：`content/manifest.json` 中 chapter-24 的 `status` 是 `pending`（G4），任何阶段都不进 `content/exercises/manifest.json`。**

- [ ] **Step 4: 写构建脚本**

`scripts/build-exercises.py`：

```python
"""Build EXERCISE_DATA from the reviewable exercise corpus.

Usage: python3 scripts/build-exercises.py
       python3 scripts/build-exercises.py --check
Validation lives in scripts/test_exercises.py and is reused here so the build
can never emit data the corpus validator rejects.
"""
from __future__ import annotations
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_exercises import ROOT, run_checks, book_chapters

OUTPUT = ROOT / 'assets' / 'exercises.js'


def build(check=False):
    manifest, corpus = run_checks()
    books = book_chapters()
    chapters = {}
    for entry in manifest['chapters']:
        chapter_id = entry['chapter']
        book = books[chapter_id]
        exercises = {}
        for lang in manifest['languages']:
            exercises[lang] = [
                {k: v for k, v in item.items() if not k.startswith('_')}
                for item in corpus[(chapter_id, lang)]
            ]
        counts = {lang: len(items) for lang, items in exercises.items()}
        assert len(set(counts.values())) == 1, f'{chapter_id} language counts diverge: {counts}'
        minutes = sum(int(item['minutes']) for item in exercises['zh'])
        chapters[chapter_id] = {
            'chapter': chapter_id,
            'number': book['number'],
            'partIndex': book['partIndex'],
            'count': counts['zh'],
            'minutes': minutes,
            'exercises': exercises,
        }
    payload = {
        'title': manifest['title'],
        'version': manifest['version'],
        'languages': manifest['languages'],
        'packages': manifest.get('packages', []),
        'exerciseCount': sum(c['count'] for c in chapters.values()),
        'chapters': chapters,
    }
    output = 'window.EXERCISE_DATA = ' + json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + ';\n'
    if check:
        if not OUTPUT.exists() or OUTPUT.read_text(encoding='utf-8') != output:
            raise SystemExit('assets/exercises.js is out of date. Run python3 scripts/build-exercises.py.')
        print(f'Verified {payload["exerciseCount"]} exercises across {len(chapters)} chapters')
        return
    OUTPUT.write_text(output, encoding='utf-8')
    print(f'Built {payload["exerciseCount"]} exercises across {len(chapters)} chapters')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true', help='Validate without writing')
    build(check=parser.parse_args().check)
```

- [ ] **Step 5: 建三语目录骨架**

```bash
cd D:/Coding/ms-cookbook
for n in 07 13 33; do
  mkdir -p content/exercises/zh content/exercises/en content/exercises/es
  printf '[]' > "content/exercises/zh/chapter-$n.json"
  cp "content/exercises/zh/chapter-$n.json" "content/exercises/en/chapter-$n.json"
  cp "content/exercises/zh/chapter-$n.json" "content/exercises/es/chapter-$n.json"
done
```

**注意**：空数组会被 `load_exercises()` 拒绝（`assert isinstance(items, list) and items`）。这是预期的 —— Task 3 会填入真实内容。在 Task 3 之前不要运行构建脚本。

- [ ] **Step 6: 确认校验器在空语料上的行为**

```bash
.venv/bin/python scripts/test_exercises.py
```

Expected: `FAIL: content/exercises/zh/chapter-07.json must be a non-empty array`（退出码 1）。这是**正确**行为，证明校验器在工作。

- [ ] **Step 7: 把 vendor 校验移入 CI 步骤**

Task 6 才会真正下载 Pyodide，所以 `test_pyodide_vendor_complete` 不能进 `scripts/test_exercises.py`（否则 Task 1 的 `pytest tests -q` 会在 vendor 缺失时失败）。把它放到 Task 6 自己的验证命令里。

在 `scripts/vendor-pyodide.mjs` 的成功输出之后，追加一段内联校验（脚本已有 `VERSION` 写入与 `wasm` 大小检查），并新增独立入口 `scripts/test_pyodide_vendor.py`：

```python
"""Vendor integrity check. Runs after scripts/vendor-pyodide.mjs has fetched."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / 'assets' / 'vendor' / 'pyodide'
PYODIDE_VERSION = '0.26.4'
VENDOR_FILES = ['pyodide.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json', 'VERSION']


def test_vendor_complete():
    for name in VENDOR_FILES:
        assert (VENDOR / name).exists(), f'missing vendor file {name}'
    assert (VENDOR / 'VERSION').read_text(encoding='utf-8').strip() == PYODIDE_VERSION
    assert (VENDOR / 'pyodide.asm.wasm').stat().st_size > 1_000_000


if __name__ == '__main__':
    test_vendor_complete()
    print(f'PASS: Pyodide {PYODIDE_VERSION} vendor complete')
```

- [ ] **Step 8: 提交**

```bash
git add scripts/build-exercises.py scripts/test_exercises.py scripts/test_pyodide_vendor.py content/exercises/manifest.json content/exercises
git commit -m "feat: add exercise corpus build script and validator"
```

---

## Task 3: 黄金样板（chapter-7 / 13 / 33，三语齐备）

schema 冻结的唯一强制质量闸门。三章覆盖简单代码题、参数构造题、综合多步题。

**Files:**
- Create: `content/exercises/zh/chapter-07.json`、`chapter-13.json`、`chapter-33.json`
- Create: `content/exercises/en/chapter-07.json`、`chapter-13.json`、`chapter-33.json`
- Create: `content/exercises/es/chapter-07.json`、`chapter-13.json`、`chapter-33.json`
- Regenerate: `assets/exercises.js`

**Interfaces:**
- Consumes: Task 2 的 `build-exercises.py`
- Produces: 冻结的 `Exercise` schema 实例；`assets/exercises.js` 含 3 章数据

- [ ] **Step 1: 写中文黄金样板**

`content/exercises/zh/chapter-07.json`：

```json
[
  {
    "id": "ch07-ex01",
    "chapter": "chapter-7",
    "type": "code",
    "difficulty": 1,
    "minutes": 5,
    "objective": "用变量和 f-string 拼接一段自我介绍",
    "prompt": "定义两个变量：`name` 存你的名字，`role` 存你想学的方向。然后打印一句话，格式为 `我是{name}，我想学{role}`。",
    "starter": "name = \"\"\nrole = \"\"\n# 在下面打印那句话\n",
    "checks": [
      { "kind": "stdout_matches", "pattern": "我是.{1,20}，我想学.{1,30}", "weight": 3 }
    ],
    "llm_rubric": { "enabled": false, "criteria": "是否真的用了两个变量而不是把内容写死在字符串里" },
    "reference": "name = \"沈愐\"\nrole = \"Agent 开发\"\nprint(f\"我是{name}，我想学{role}\")",
    "explanation": "f-string 用 {} 把变量的值嵌进字符串，不需要手写字符串拼接。注意 name 和 role 要先赋值再使用。"
  },
  {
    "id": "ch07-ex02",
    "chapter": "chapter-7",
    "type": "code",
    "difficulty": 2,
    "minutes": 8,
    "objective": "计算模型加载到显存需要的字节数",
    "prompt": "一个模型有 70 亿参数，用 fp16 精度加载（每个参数 2 字节）。算出权重总字节数，存入变量 `weight_bytes`。",
    "starter": "params_billion = 7\nbytes_per_param = 2\n# 计算并赋给 weight_bytes\n",
    "checks": [
      { "kind": "var_equals", "name": "weight_bytes", "value": 14000000000, "weight": 3 }
    ],
    "llm_rubric": { "enabled": false, "criteria": "是否理解了参数量单位是十亿" },
    "reference": "weight_bytes = params_billion * 1_000_000_000 * bytes_per_param",
    "explanation": "70 亿 = 7 × 10^9。乘以每参数 2 字节得 1.4 × 10^10 字节，约 13 GB。这只是权重，实际加载还要加 KV cache 和激活值。"
  },
  {
    "id": "ch07-ex03",
    "chapter": "chapter-7",
    "type": "predict",
    "difficulty": 1,
    "minutes": 3,
    "objective": "判断哪些代码能作为模型的第一次调用",
    "prompt": "下面哪个写法能直接得到模型输出？（多选）\n\nA. `print(model.generate(prompt))`\nB. `model.generate(prompt)` 单独一行\nC. `print(model(prompt))`\nD. `answer = model.generate(prompt)` 然后 `print(answer)`",
    "checks": [
      { "kind": "output_choice", "correct": ["A", "C", "D"], "weight": 3 }
    ],
    "llm_rubric": { "enabled": false, "criteria": "" },
    "reference": "A、C、D。B 是对的但 Jupyter 会自动显示最后一个表达式的值，在脚本环境里不会打印出来。",
    "explanation": "推理结果一定要拿到并输出。B 在 Jupyter 里看起来\"有效\"是因为最后一个单元格表达式会回显，但在 .py 脚本或服务端调用中什么都不会输出 —— 这是新手最常见的\"模型跑了但没反应\"原因。"
  }
]
```

`content/exercises/zh/chapter-13.json`：

```json
[
  {
    "id": "ch13-ex01",
    "chapter": "chapter-13",
    "type": "build",
    "difficulty": 2,
    "minutes": 10,
    "objective": "拼装 ms-swift 微调启动命令的参数",
    "prompt": "写出一个 `swift sft` 命令的参数字典（存为变量 `args`），包含：`model` 为 `Qwen/Qwen2.5-0.5B`，`dataset` 为 `['alpaca-gpt4-data.json']`，`output` 为 `output/v0-5b-lora`，`train_type` 为 `lora`，`max_length` 为 2048。最后把 `args` 拼成命令行字符串存入 `cmd`。",
    "starter": "args = {\n    \"model\": \"\",\n    \"dataset\": [],\n    \"output\": \"\",\n    \"train_type\": \"\",\n    \"max_length\": 0,\n}\n# 拼成命令行字符串存为 cmd\n",
    "checks": [
      { "kind": "assert_python", "code": "assert args['model'] == 'Qwen/Qwen2.5-0.5B'", "weight": 2 },
      { "kind": "assert_python", "code": "assert args['train_type'] == 'lora'", "weight": 2 },
      { "kind": "assert_python", "code": "assert args['max_length'] == 2048", "weight": 1 },
      { "kind": "assert_python", "code": "assert isinstance(args['dataset'], list) and args['dataset']", "weight": 1 },
      { "kind": "stdout_matches", "pattern": "swift\\s+sft.*--train_type\\s+lora", "weight": 2 }
    ],
    "llm_rubric": { "enabled": false, "criteria": "是否理解 dataset 是列表而 max_length 是整数" },
    "reference": "parts = \" \".join(f\"--{k.replace('_','-')} {v}\" for k, v in args.items())\ncmd = f\"swift sft {parts}\"",
    "explanation": "ms-swift 的命令行参数用中划线（--train-type），而 Python 字典用下划线（train_type），拼命令时要做转换。dataset 必须是列表，即使只有一个文件。"
  },
  {
    "id": "ch13-ex02",
    "chapter": "chapter-13",
    "type": "code",
    "difficulty": 3,
    "minutes": 12,
    "objective": "按占比切分训练集与验证集",
    "prompt": "给定一个样本数 `total` 和验证集占比 `val_ratio`（0 到 1 之间的小数），计算验证集样本数 `val_size` 与训练集样本数 `train_size`。要求用整除向下取整，且两者之和不超过 `total`。",
    "starter": "def split(total, val_ratio):\n    # 返回 (train_size, val_size)\n    pass\n\ntrain_size, val_size = split(1000, 0.1)\n",
    "checks": [
      { "kind": "assert_python", "code": "assert split(1000, 0.1) == (900, 100)", "weight": 3 },
      { "kind": "assert_python", "code": "assert split(101, 0.15) == (85, 15)", "weight": 2 },
      { "kind": "assert_python", "code": "assert sum(split(777, 0.33)) <= 777", "weight": 1 }
    ],
    "llm_rubric": { "enabled": false, "criteria": "是否处理了整除导致的余数，而不是四舍五入" },
    "reference": "def split(total, val_ratio):\n    val_size = int(total * val_ratio)\n    return total - val_size, val_size",
    "explanation": "val_size 用 int() 向下取整，train_size 用减法而不是再次取整 —— 这样能保证两者之和恰好等于 total，不丢样本。"
  },
  {
    "id": "ch13-ex03",
    "chapter": "chapter-13",
    "type": "reflect",
    "difficulty": 2,
    "minutes": 6,
    "objective": "判断 LoRA 超参调整的方向",
    "prompt": "微调后模型输出重复啰嗦、容易陷入同一句话。你会优先调整 `lora_rank`、`learning_rate`、`num_epochs` 里的哪一个？为什么？请写出你的判断和理由。",
    "checks": [
      { "kind": "self_assessed", "weight": 1 }
    ],
    "llm_rubric": {
      "enabled": true,
      "criteria": "是否指出 learning_rate 过高或 epochs 过多是主要原因，并说明了调整方向与替代方案"
    },
    "reference": "优先降 learning_rate（如 1e-4 → 5e-5），其次减 epochs。lora_rank 主要影响容量和显存，与输出重复关系较弱。如果还是重复，可加数据清洗去重或引入 repetition_penalty。",
    "explanation": "输出重复通常是过拟合或学习率过高的信号，不是容量不足。这题跑不了真实微调，靠推理和自查 —— 重要的是写出「为什么」而不是「调哪个」。"
  }
]
```

`content/exercises/zh/chapter-33.json`：

```json
[
  {
    "id": "ch33-ex01",
    "chapter": "chapter-33",
    "type": "build",
    "difficulty": 3,
    "minutes": 15,
    "objective": "设计产线缺陷检测的评分函数",
    "prompt": "产线巡检要判断一张图里是否合格。已知 `defects` 是检测到的缺陷框数量（整数），`area_ratio` 是缺陷面积占比（0 到 1 的小数）。写一个函数 `judge(defects, area_ratio)`：0 个缺陷返回 `\"pass\"`；1 个且面积占比不超过 0.05 返回 `\"warn\"`；其余返回 `\"fail\"`。",
    "starter": "def judge(defects, area_ratio):\n    # 返回 \"pass\" / \"warn\" / \"fail\"\n    pass\n",
    "checks": [
      { "kind": "assert_python", "code": "assert judge(0, 0.0) == 'pass'", "weight": 2 },
      { "kind": "assert_python", "code": "assert judge(1, 0.03) == 'warn'", "weight": 3 },
      { "kind": "assert_python", "code": "assert judge(1, 0.06) == 'fail'", "weight": 3 },
      { "kind": "assert_python", "code": "assert judge(2, 0.01) == 'fail'", "weight": 2 }
    ],
    "llm_rubric": { "enabled": false, "criteria": "是否用早返回让条件从最严格到最宽松排列" },
    "reference": "def judge(defects, area_ratio):\n    if defects == 0:\n        return 'pass'\n    if defects == 1 and area_ratio <= 0.05:\n        return 'warn'\n    return 'fail'",
    "explanation": "早返回（guard clause）比嵌套 if 更易读，也更容易扩展新规则。关键是没有把面积条件放到 0 缺陷的分支里 —— 0 缺陷时无论面积多少都该pass。"
  },
  {
    "id": "ch33-ex02",
    "chapter": "chapter-33",
    "type": "code",
    "difficulty": 3,
    "minutes": 12,
    "objective": "计算巡检 Agent 的评测指标",
    "prompt": "Agent 在 20 条产线样本上运行：14 条完全正确，3 条有轻微缺陷但不影响判断，3 条判断错误。写函数 `metrics(correct, minor, wrong)` 返回字典，包含：`accuracy`（correct / 总数，保留 3 位小数）、`harm_rate`（wrong / 总数，保留 3 位小数）、`acceptable`（(correct + minor) / 总数，保留 3 位小数）。",
    "starter": "def metrics(correct, minor, wrong):\n    # 返回 {'accuracy': ..., 'harm_rate': ..., 'acceptable': ...}\n    pass\n\nprint(metrics(14, 3, 3))\n",
    "checks": [
      { "kind": "assert_python", "code": "m = metrics(14,3,3)\nassert m['accuracy'] == 0.7, m", "weight": 3 },
      { "kind": "assert_python", "code": "m = metrics(14,3,3)\nassert m['harm_rate'] == 0.15, m", "weight": 2 },
      { "kind": "assert_python", "code": "m = metrics(14,3,3)\nassert m['acceptable'] == 0.85, m", "weight": 3 },
      { "kind": "assert_python", "code": "m = metrics(1,0,0)\nassert m['accuracy'] == 1.0, m", "weight": 1 }
    ],
    "llm_rubric": { "enabled": false, "criteria": "是否处理了总数为 0 的除零情况" },
    "reference": "def metrics(correct, minor, wrong):\n    total = correct + minor + wrong\n    if total == 0:\n        return {'accuracy': 0.0, 'harm_rate': 0.0, 'acceptable': 0.0}\n    return {\n        'accuracy': round(correct / total, 3),\n        'harm_rate': round(wrong / total, 3),\n        'acceptable': round((correct + minor) / total, 3),\n    }",
    "explanation": "round(x, 3) 保证返回的是 0.7 而不是 0.7000000000000001，这在评测报告里对比很重要。除零保护不能省 —— 传 0 条样本时程序应该返回 0 而不是崩溃。"
  },
  {
    "id": "ch33-ex03",
    "chapter": "chapter-33",
    "type": "reflect",
    "difficulty": 3,
    "minutes": 8,
    "objective": "设计 Agent 评测的对照实验",
    "prompt": "你改了巡检 Agent 的提示词，accuracy 从 0.70 提到 0.85。要判断这是真改进还是随机波动，你会怎么做？请写出至少两个具体步骤。",
    "checks": [
      { "kind": "self_assessed", "weight": 1 }
    ],
    "llm_rubric": {
      "enabled": true,
      "criteria": "是否提到固定随机种子、多次运行取平均或做显著性检验、且要跑在未参与调参的留出集上"
    },
    "reference": "① 固定随机种子和模型版本重跑多轮，看 0.85 是否稳定；② 在从未参与调参的留出集上验证，排除过拟合评测集；③ 若条件允许做显著性检验（配对 t 检验或 bootstrap），确认差异不是噪声。",
    "explanation": "20 条样本上 0.70→0.85 只差 3 条样本，很可能落在随机波动范围内。核心是「换一批没调过的数据再测」—— 这是发现过拟合最快的方法。"
  }
]
```

- [ ] **Step 2: 写英文版**

`content/exercises/en/chapter-07.json`（完整文件）：

```json
[
  {
    "id": "ch07-ex01",
    "chapter": "chapter-7",
    "type": "code",
    "difficulty": 1,
    "minutes": 5,
    "objective": "Build a self-introduction with variables and an f-string",
    "prompt": "Define two variables: `name` holding your name, and `role` holding what you want to learn. Then print one sentence formatted as `我是{name}，我想学{role}`.",
    "starter": "name = \"\"\nrole = \"\"\n# print the sentence below\n",
    "checks": [
      { "kind": "stdout_matches", "pattern": "我是.{1,20}，我想学.{1,30}", "weight": 3 }
    ],
    "llm_rubric": { "enabled": false, "criteria": "Did the learner really use two variables instead of hard-coding the string?" },
    "reference": "name = \"Mian\"\nrole = \"Agent development\"\nprint(f\"我是{name}，我想学{role}\")",
    "explanation": "An f-string embeds variable values with {} and avoids manual concatenation. Assign name and role before you use them."
  },
  {
    "id": "ch07-ex02",
    "chapter": "chapter-7",
    "type": "code",
    "difficulty": 2,
    "minutes": 8,
    "objective": "Compute the bytes needed to load a model into VRAM",
    "prompt": "A model has 7 billion parameters loaded at fp16 precision (2 bytes per parameter). Compute the total weight size and store it in `weight_bytes`.",
    "starter": "params_billion = 7\nbytes_per_param = 2\n# compute and assign weight_bytes\n",
    "checks": [
      { "kind": "var_equals", "name": "weight_bytes", "value": 14000000000, "weight": 3 }
    ],
    "llm_rubric": { "enabled": false, "criteria": "Does the learner understand that the parameter count is in billions?" },
    "reference": "weight_bytes = params_billion * 1_000_000_000 * bytes_per_param",
    "explanation": "7 billion = 7 x 10^9. Times 2 bytes each gives 1.4 x 10^10 bytes, about 13 GB. That is weights only; a real deployment also needs KV cache and activations."
  },
  {
    "id": "ch07-ex03",
    "chapter": "chapter-7",
    "type": "predict",
    "difficulty": 1,
    "minutes": 3,
    "objective": "Spot which code actually prints a model response",
    "prompt": "Which of these produce visible output? (multi-select)\n\nA. `print(model.generate(prompt))`\nB. `model.generate(prompt)` on its own line\nC. `print(model(prompt))`\nD. `answer = model.generate(prompt)` followed by `print(answer)`",
    "checks": [
      { "kind": "output_choice", "correct": ["A", "C", "D"], "weight": 3 }
    ],
    "llm_rubric": { "enabled": false, "criteria": "" },
    "reference": "A, C and D. B is valid Python but Jupyter echoes the last expression; a plain script prints nothing.",
    "explanation": "You have to capture the result and print it. B looks fine in Jupyter because the last cell expression is echoed, but in a .py script or a server call nothing is shown -- the most common \"the model ran but nothing happened\" cause."
  }
]
```

`content/exercises/en/chapter-13.json`：

```json
[
  {
    "id": "ch13-ex01",
    "chapter": "chapter-13",
    "type": "build",
    "difficulty": 2,
    "minutes": 10,
    "objective": "Assemble the arguments of an ms-swift fine-tuning command",
    "prompt": "Build an argument dictionary stored as `args` for a `swift sft` run: `model` = `Qwen/Qwen2.5-0.5B`, `dataset` = `['alpaca-gpt4-data.json']`, `output` = `output/v0-5b-lora`, `train_type` = `lora`, `max_length` = 2048. Then join `args` into a command-line string stored as `cmd`.",
    "starter": "args = {\n    \"model\": \"\",\n    \"dataset\": [],\n    \"output\": \"\",\n    \"train_type\": \"\",\n    \"max_length\": 0,\n}\n# join into a command string stored as cmd\n",
    "checks": [
      { "kind": "assert_python", "code": "assert args['model'] == 'Qwen/Qwen2.5-0.5B'", "weight": 2 },
      { "kind": "assert_python", "code": "assert args['train_type'] == 'lora'", "weight": 2 },
      { "kind": "assert_python", "code": "assert args['max_length'] == 2048", "weight": 1 },
      { "kind": "assert_python", "code": "assert isinstance(args['dataset'], list) and args['dataset']", "weight": 1 },
      { "kind": "stdout_matches", "pattern": "swift\\s+sft.*--train-type\\s+lora", "weight": 2 }
    ],
    "llm_rubric": { "enabled": false, "criteria": "Does the learner understand dataset is a list while max_length is an integer?" },
    "reference": "parts = \" \".join(f\"--{k.replace('_','-')} {v}\" for k, v in args.items())\ncmd = f\"swift sft {parts}\"",
    "explanation": "ms-swift uses hyphens on the command line (--train-type) while the Python dict uses underscores (train_type); converting is part of the task. dataset must be a list even with a single file."
  },
  {
    "id": "ch13-ex02",
    "chapter": "chapter-13",
    "type": "code",
    "difficulty": 3,
    "minutes": 12,
    "objective": "Split a dataset into train and validation parts",
    "prompt": "Given a sample count `total` and a validation ratio `val_ratio` (a decimal between 0 and 1), compute the validation size `val_size` and the training size `train_size`. Use floor division, and make sure the two never exceed `total` when summed.",
    "starter": "def split(total, val_ratio):\n    # return (train_size, val_size)\n    pass\n\ntrain_size, val_size = split(1000, 0.1)\n",
    "checks": [
      { "kind": "assert_python", "code": "assert split(1000, 0.1) == (900, 100)", "weight": 3 },
      { "kind": "assert_python", "code": "assert split(101, 0.15) == (85, 15)", "weight": 2 },
      { "kind": "assert_python", "code": "assert sum(split(777, 0.33)) <= 777", "weight": 1 }
    ],
    "llm_rubric": { "enabled": false, "criteria": "Did the learner handle the remainder from floor division instead of rounding?" },
    "reference": "def split(total, val_ratio):\n    val_size = int(total * val_ratio)\n    return total - val_size, val_size",
    "explanation": "val_size uses int() to floor, and train_size is derived by subtraction rather than a second floor -- so the two always sum to exactly total without dropping samples."
  },
  {
    "id": "ch13-ex03",
    "chapter": "chapter-13",
    "type": "reflect",
    "difficulty": 2,
    "minutes": 6,
    "objective": "Decide which LoRA hyperparameter to change",
    "prompt": "After fine-tuning the model repeats itself and gets stuck in one sentence. Which would you change first: `lora_rank`, `learning_rate` or `num_epochs`? Write down your choice and why.",
    "checks": [
      { "kind": "self_assessed", "weight": 1 }
    ],
    "llm_rubric": {
      "enabled": true,
      "criteria": "Does the answer identify a too-high learning rate or too many epochs as the likely cause, and state both the direction of the change and an alternative?"
    },
    "reference": "Lower the learning rate first (1e-4 -> 5e-5), then cut epochs. lora_rank mostly controls capacity and memory, so it is a weak lever here. If repetition persists, dedupe the data or add repetition_penalty.",
    "explanation": "Repetition signals overfitting or an excessive learning rate, not insufficient capacity. This one cannot actually be fine-tuned in a browser -- what matters is writing the \"why\", not just the \"what\"."
  }
]
```

`content/exercises/en/chapter-33.json`：

```json
[
  {
    "id": "ch33-ex01",
    "chapter": "chapter-33",
    "type": "build",
    "difficulty": 3,
    "minutes": 15,
    "objective": "Write the pass/fail rule for a production-line defect check",
    "prompt": "A line inspector must decide whether an image is acceptable. `defects` is the number of detected defect boxes (integer) and `area_ratio` is the defect area share (a decimal between 0 and 1). Write `judge(defects, area_ratio)`: zero defects returns `\"pass\"`; exactly one defect with an area share of at most 0.05 returns `\"warn\"`; anything else returns `\"fail\"`.",
    "starter": "def judge(defects, area_ratio):\n    # return \"pass\" / \"warn\" / \"fail\"\n    pass\n",
    "checks": [
      { "kind": "assert_python", "code": "assert judge(0, 0.0) == 'pass'", "weight": 2 },
      { "kind": "assert_python", "code": "assert judge(1, 0.03) == 'warn'", "weight": 3 },
      { "kind": "assert_python", "code": "assert judge(1, 0.06) == 'fail'", "weight": 3 },
      { "kind": "assert_python", "code": "assert judge(2, 0.01) == 'fail'", "weight": 2 }
    ],
    "llm_rubric": { "enabled": false, "criteria": "Did the learner order the branches from strictest to loosest using early returns?" },
    "reference": "def judge(defects, area_ratio):\n    if defects == 0:\n        return 'pass'\n    if defects == 1 and area_ratio <= 0.05:\n        return 'warn'\n    return 'fail'",
    "explanation": "Guard clauses read better than nesting and make new rules easy to add. The key point is not putting the area test inside the zero-defect branch -- with no defects, any area still passes."
  },
  {
    "id": "ch33-ex02",
    "chapter": "chapter-33",
    "type": "code",
    "difficulty": 3,
    "minutes": 12,
    "objective": "Compute evaluation metrics for the inspection Agent",
    "prompt": "An Agent ran over 20 production samples: 14 fully correct, 3 with minor flaws that do not change the verdict, 3 wrong. Write `metrics(correct, minor, wrong)` returning a dict with `accuracy` (correct / total, 3 decimals), `harm_rate` (wrong / total, 3 decimals) and `acceptable` ((correct + minor) / total, 3 decimals).",
    "starter": "def metrics(correct, minor, wrong):\n    # return {'accuracy': ..., 'harm_rate': ..., 'acceptable': ...}\n    pass\n\nprint(metrics(14, 3, 3))\n",
    "checks": [
      { "kind": "assert_python", "code": "m = metrics(14,3,3)\nassert m['accuracy'] == 0.7, m", "weight": 3 },
      { "kind": "assert_python", "code": "m = metrics(14,3,3)\nassert m['harm_rate'] == 0.15, m", "weight": 2 },
      { "kind": "assert_python", "code": "m = metrics(14,3,3)\nassert m['acceptable'] == 0.85, m", "weight": 3 },
      { "kind": "assert_python", "code": "m = metrics(1,0,0)\nassert m['accuracy'] == 1.0, m", "weight": 1 }
    ],
    "llm_rubric": { "enabled": false, "criteria": "Did the learner guard against a zero total?" },
    "reference": "def metrics(correct, minor, wrong):\n    total = correct + minor + wrong\n    if total == 0:\n        return {'accuracy': 0.0, 'harm_rate': 0.0, 'acceptable': 0.0}\n    return {\n        'accuracy': round(correct / total, 3),\n        'harm_rate': round(wrong / total, 3),\n        'acceptable': round((correct + minor) / total, 3),\n    }",
    "explanation": "round(x, 3) keeps the return value at 0.7 instead of 0.7000000000000001, which matters when diffing evaluation reports. The zero guard matters too: passing zero samples should return zeros, not crash."
  },
  {
    "id": "ch33-ex03",
    "chapter": "chapter-33",
    "type": "reflect",
    "difficulty": 3,
    "minutes": 8,
    "objective": "Design a controlled comparison for Agent evaluation",
    "prompt": "You changed the inspector Agent prompt and accuracy went from 0.70 to 0.85. How would you tell a real improvement from noise? Write at least two concrete steps.",
    "checks": [
      { "kind": "self_assessed", "weight": 1 }
    ],
    "llm_rubric": {
      "enabled": true,
      "criteria": "Does the answer mention fixing the seed and model version, running several trials or a significance test, and validating on a holdout set that was never used for tuning?"
    },
    "reference": "1) Fix the seed and model version, rerun several times, check whether 0.85 is stable. 2) Validate on a holdout set that was never used for tuning, to rule out overfitting the eval set. 3) If feasible, run a paired t-test or bootstrap for significance.",
    "explanation": "On 20 samples, 0.70 to 0.85 is only 3 samples -- very likely inside the noise band. The core move is to retest on data that never influenced the change; that is the fastest way to catch overfitting."
  }
]
```

- [ ] **Step 3: 写西班牙语版**

`content/exercises/es/chapter-07.json`：

```json
[
  {
    "id": "ch07-ex01",
    "chapter": "chapter-7",
    "type": "code",
    "difficulty": 1,
    "minutes": 5,
    "objective": "Construir una presentación personal con variables y una f-string",
    "prompt": "Define dos variables: `name` con tu nombre y `role` con lo que quieres aprender. Luego imprime una frase con el formato `我是{name}，我想学{role}`.",
    "starter": "name = \"\"\nrole = \"\"\n# imprime la frase abajo\n",
    "checks": [
      { "kind": "stdout_matches", "pattern": "我是.{1,20}，我想学.{1,30}", "weight": 3 }
    ],
    "llm_rubric": { "enabled": false, "criteria": "¿Se usaron realmente dos variables en lugar de escribir el texto dentro de la cadena?" },
    "reference": "name = \"Mian\"\nrole = \"desarrollo de agentes\"\nprint(f\"我是{name}，我想学{role}\")",
    "explanation": "Una f-string incrusta el valor de una variable con {} y evita concatenar a mano. Asigna name y role antes de usarlas."
  },
  {
    "id": "ch07-ex02",
    "chapter": "chapter-7",
    "type": "code",
    "difficulty": 2,
    "minutes": 8,
    "objective": "Calcular los bytes necesarios para cargar un modelo en VRAM",
    "prompt": "Un modelo tiene 7 mil millones de parámetros y se carga en precisión fp16 (2 bytes por parámetro). Calcula el tamaño total de los pesos y guárdalo en `weight_bytes`.",
    "starter": "params_billion = 7\nbytes_per_param = 2\n# calcula y asigna weight_bytes\n",
    "checks": [
      { "kind": "var_equals", "name": "weight_bytes", "value": 14000000000, "weight": 3 }
    ],
    "llm_rubric": { "enabled": false, "criteria": "¿Entiende la persona que el número de parámetros está en miles de millones?" },
    "reference": "weight_bytes = params_billion * 1_000_000_000 * bytes_per_param",
    "explanation": "7 mil millones = 7 x 10^9. Multiplicado por 2 bytes da 1,4 x 10^10 bytes, unos 13 GB. Eso son solo los pesos; un despliegue real también necesita la caché KV y las activaciones."
  },
  {
    "id": "ch07-ex03",
    "chapter": "chapter-7",
    "type": "predict",
    "difficulty": 1,
    "minutes": 3,
    "objective": "Detectar qué código muestra realmente la respuesta del modelo",
    "prompt": "¿Cuáles de estos producen salida visible? (selección múltiple)\n\nA. `print(model.generate(prompt))`\nB. `model.generate(prompt)` en una línea sola\nC. `print(model(prompt))`\nD. `answer = model.generate(prompt)` seguido de `print(answer)`",
    "checks": [
      { "kind": "output_choice", "correct": ["A", "C", "D"], "weight": 3 }
    ],
    "llm_rubric": { "enabled": false, "criteria": "" },
    "reference": "A, C y D. B es Python válido, pero Jupyter muestra la última expresión; un script normal no imprime nada.",
    "explanation": "Hay que capturar el resultado e imprimirlo. B parece funcionar en Jupyter porque se muestra la última expresión de la celda, pero en un script .py o en una llamada al servidor no aparece nada: la causa más común de \"el modelo corrió pero no pasó nada\"."
  }
]
```

`content/exercises/es/chapter-13.json`：

```json
[
  {
    "id": "ch13-ex01",
    "chapter": "chapter-13",
    "type": "build",
    "difficulty": 2,
    "minutes": 10,
    "objective": "Ensamblar los argumentos de un comando de ajuste fino de ms-swift",
    "prompt": "Construye un diccionario de argumentos llamado `args` para una ejecución `swift sft`: `model` = `Qwen/Qwen2.5-0.5B`, `dataset` = `['alpaca-gpt4-data.json']`, `output` = `output/v0-5b-lora`, `train_type` = `lora`, `max_length` = 2048. Después une `args` en una cadena de línea de comandos llamada `cmd`.",
    "starter": "args = {\n    \"model\": \"\",\n    \"dataset\": [],\n    \"output\": \"\",\n    \"train_type\": \"\",\n    \"max_length\": 0,\n}\n# únelo en una cadena de comando llamada cmd\n",
    "checks": [
      { "kind": "assert_python", "code": "assert args['model'] == 'Qwen/Qwen2.5-0.5B'", "weight": 2 },
      { "kind": "assert_python", "code": "assert args['train_type'] == 'lora'", "weight": 2 },
      { "kind": "assert_python", "code": "assert args['max_length'] == 2048", "weight": 1 },
      { "kind": "assert_python", "code": "assert isinstance(args['dataset'], list) and args['dataset']", "weight": 1 },
      { "kind": "stdout_matches", "pattern": "swift\\s+sft.*--train-type\\s+lora", "weight": 2 }
    ],
    "llm_rubric": { "enabled": false, "criteria": "¿Entiende que dataset es una lista y max_length es un entero?" },
    "reference": "parts = \" \".join(f\"--{k.replace('_','-')} {v}\" for k, v in args.items())\ncmd = f\"swift sft {parts}\"",
    "explanation": "ms-swift usa guiones en la línea de comandos (--train-type) mientras que el diccionario usa guiones bajos (train_type); convertirlo es parte del ejercicio. dataset debe ser una lista aunque tenga un solo archivo."
  },
  {
    "id": "ch13-ex02",
    "chapter": "chapter-13",
    "type": "code",
    "difficulty": 3,
    "minutes": 12,
    "objective": "Separar un conjunto de datos en entrenamiento y validación",
    "prompt": "Dado un total de muestras `total` y una proporción de validación `val_ratio` (decimal entre 0 y 1), calcula el tamaño de validación `val_size` y el de entrenamiento `train_size`. Usa división entera y asegúrate de que la suma nunca supere `total`.",
    "starter": "def split(total, val_ratio):\n    # devuelve (train_size, val_size)\n    pass\n\ntrain_size, val_size = split(1000, 0.1)\n",
    "checks": [
      { "kind": "assert_python", "code": "assert split(1000, 0.1) == (900, 100)", "weight": 3 },
      { "kind": "assert_python", "code": "assert split(101, 0.15) == (85, 15)", "weight": 2 },
      { "kind": "assert_python", "code": "assert sum(split(777, 0.33)) <= 777", "weight": 1 }
    ],
    "llm_rubric": { "enabled": false, "criteria": "¿Trató el resto de la división entera en lugar de redondear?" },
    "reference": "def split(total, val_ratio):\n    val_size = int(total * val_ratio)\n    return total - val_size, val_size",
    "explanation": "val_size usa int() para truncar y train_size se obtiene por resta en lugar de una segunda división, así la suma es exactamente total sin perder muestras."
  },
  {
    "id": "ch13-ex03",
    "chapter": "chapter-13",
    "type": "reflect",
    "difficulty": 2,
    "minutes": 6,
    "objective": "Decidir qué hiperparámetro de LoRA cambiar",
    "prompt": "Tras el ajuste fino el modelo se repite y se atasca en una misma frase. ¿Qué cambiarías primero: `lora_rank`, `learning_rate` o `num_epochs`? Escribe tu elección y el motivo.",
    "checks": [
      { "kind": "self_assessed", "weight": 1 }
    ],
    "llm_rubric": {
      "enabled": true,
      "criteria": "¿La respuesta identifica una tasa de aprendizaje demasiado alta o demasiadas épocas como causa probable, e indica la dirección del cambio y una alternativa?"
    },
    "reference": "Baja primero la tasa de aprendizaje (1e-4 -> 5e-5) y después reduce las épocas. lora_rank controla sobre todo capacidad y memoria, así que es una palanca débil aquí. Si la repetición persiste, deduplica los datos o usa repetition_penalty.",
    "explanation": "La repetición indica sobreajuste o una tasa de aprendizaje excesiva, no falta de capacidad. Este ejercicio no se puede ajustar de verdad en el navegador: lo importante es escribir el «por qué», no solo el «qué»."
  }
]
```

`content/exercises/es/chapter-33.json`：

```json
[
  {
    "id": "ch33-ex01",
    "chapter": "chapter-33",
    "type": "build",
    "difficulty": 3,
    "minutes": 15,
    "objective": "Escribir la regla de aprobado o fallo de una inspección de línea",
    "prompt": "Un inspector de línea debe decidir si una imagen es aceptable. `defects` es el número de cajas de defectos detectadas (entero) y `area_ratio` es la proporción de área defectuosa (decimal entre 0 y 1). Escribe `judge(defects, area_ratio)`: cero defectos devuelve `\"pass\"`; exactamente un defecto con proporción de área de hasta 0,05 devuelve `\"warn\"`; cualquier otro caso devuelve `\"fail\"`.",
    "starter": "def judge(defects, area_ratio):\n    # devuelve \"pass\" / \"warn\" / \"fail\"\n    pass\n",
    "checks": [
      { "kind": "assert_python", "code": "assert judge(0, 0.0) == 'pass'", "weight": 2 },
      { "kind": "assert_python", "code": "assert judge(1, 0.03) == 'warn'", "weight": 3 },
      { "kind": "assert_python", "code": "assert judge(1, 0.06) == 'fail'", "weight": 3 },
      { "kind": "assert_python", "code": "assert judge(2, 0.01) == 'fail'", "weight": 2 }
    ],
    "llm_rubric": { "enabled": false, "criteria": "¿Ordenó las ramas de la más estricta a la más flexible usando retornos tempranos?" },
    "reference": "def judge(defects, area_ratio):\n    if defects == 0:\n        return 'pass'\n    if defects == 1 and area_ratio <= 0.05:\n        return 'warn'\n    return 'fail'",
    "explanation": "Las cláusulas de salida anticipada se leen mejor que el anidamiento y facilitan añadir reglas. Lo clave es no meter la comprobación de área dentro de la rama de cero defectos: sin defectos, cualquier área pasa."
  },
  {
    "id": "ch33-ex02",
    "chapter": "chapter-33",
    "type": "code",
    "difficulty": 3,
    "minutes": 12,
    "objective": "Calcular métricas de evaluación del agente inspector",
    "prompt": "Un agente se ejecutó sobre 20 muestras de producción: 14 totalmente correctas, 3 con fallos menores que no cambian el veredicto y 3 incorrectas. Escribe `metrics(correct, minor, wrong)` que devuelva un diccionario con `accuracy` (correct / total, 3 decimales), `harm_rate` (wrong / total, 3 decimales) y `acceptable` ((correct + minor) / total, 3 decimales).",
    "starter": "def metrics(correct, minor, wrong):\n    # devuelve {'accuracy': ..., 'harm_rate': ..., 'acceptable': ...}\n    pass\n\nprint(metrics(14, 3, 3))\n",
    "checks": [
      { "kind": "assert_python", "code": "m = metrics(14,3,3)\nassert m['accuracy'] == 0.7, m", "weight": 3 },
      { "kind": "assert_python", "code": "m = metrics(14,3,3)\nassert m['harm_rate'] == 0.15, m", "weight": 2 },
      { "kind": "assert_python", "code": "m = metrics(14,3,3)\nassert m['acceptable'] == 0.85, m", "weight": 3 },
      { "kind": "assert_python", "code": "m = metrics(1,0,0)\nassert m['accuracy'] == 1.0, m", "weight": 1 }
    ],
    "llm_rubric": { "enabled": false, "criteria": "¿Protejo el caso de un total igual a cero?" },
    "reference": "def metrics(correct, minor, wrong):\n    total = correct + minor + wrong\n    if total == 0:\n        return {'accuracy': 0.0, 'harm_rate': 0.0, 'acceptable': 0.0}\n    return {\n        'accuracy': round(correct / total, 3),\n        'harm_rate': round(wrong / total, 3),\n        'acceptable': round((correct + minor) / total, 3),\n    }",
    "explanation": "round(x, 3) mantiene el resultado en 0,7 en lugar de 0,7000000000000001, lo que importa al comparar informes de evaluación. La protección contra cero también: pasar cero muestras debe devolver ceros, no romperse."
  },
  {
    "id": "ch33-ex03",
    "chapter": "chapter-33",
    "type": "reflect",
    "difficulty": 3,
    "minutes": 8,
    "objective": "Diseñar una comparación controlada para evaluar agentes",
    "prompt": "Cambiaste el prompt del agente inspector y la precisión pasó de 0,70 a 0,85. ¿Cómo sabrías si es una mejora real o ruido? Escribe al menos dos pasos concretos.",
    "checks": [
      { "kind": "self_assessed", "weight": 1 }
    ],
    "llm_rubric": {
      "enabled": true,
      "criteria": "¿La respuesta menciona fijar la semilla y la versión del modelo, hacer varias ejecuciones o una prueba de significación, y validar en un conjunto de reserva que nunca se usó para ajustar?"
    },
    "reference": "1) Fija la semilla y la versión del modelo, repite varias veces y comprueba si 0,85 es estable. 2) Valida en un conjunto de reserva que nunca se usó para ajustar, para descartar sobreajuste al conjunto de evaluación. 3) Si es posible, haz una prueba t pareada o bootstrap.",
    "explanation": "Con 20 muestras, pasar de 0,70 a 0,85 son solo 3 muestras y probablemente cae dentro del ruido. El movimiento clave es volver a medir sobre datos que no influyeron en el cambio: es la forma más rápida de detectar sobreajuste."
  }
]
```

- [ ] **Step 4: 构建并验证**

```bash
cd D:/Coding/ms-cookbook
python3 scripts/build-exercises.py
python3 scripts/build-exercises.py --check
.venv/bin/python scripts/test_exercises.py
```

Expected:
- `Built 9 exercises across 3 chapters`
- `Verified 9 exercises across 3 chapters`
- `PASS: 9 exercises across 3 chapters, 3 languages`

**这一步之后到 Task 13，构建全程可用** —— manifest 只声明 3 章，校验器只检查这 3 章的三语内容。Task 14 才会把 manifest 展开到 34 章并同时补齐 32 章的中英文西三语内容。

- [ ] **Step 5: 提交**

```bash
git add content/exercises assets/exercises.js
git commit -m "feat: add golden-sample exercises for chapters 7, 13, 33 in zh/en/es"
```

---

## Task 4: L3 判分器（纯函数，Node 单测）

**Files:**
- Create: `assets/exercise-grader.js`
- Create: `scripts/test-exercise-grader.cjs`

**Interfaces:**
- Consumes: 无（零依赖）
- Produces:
  - `ExerciseGrader.PASS_THRESHOLD` → `0.8`
  - `ExerciseGrader.evaluate(checks, outcomes)` → `{items, score, earned, total}`，`outcomes` 与 `checks` 等长，每项为 `boolean` 或 `{ok:boolean, detail:string}`
  - `ExerciseGrader.grade(exercise, input)` → `{mode, passed, score, items, selfAssessed, llm}`
  - `exercise.mode` ∈ `'deterministic' | 'llm' | 'self-assessed'`

- [ ] **Step 1: 写失败的测试**

`scripts/test-exercise-grader.cjs`：

```javascript
'use strict';
const assert = require('node:assert/strict');
const G = require('../assets/exercise-grader.js');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); }
}

console.log('ExerciseGrader');

check('exposes the 0.8 pass threshold', () => {
  assert.equal(G.PASS_THRESHOLD, 0.8);
});

check('weighted score sums earned over total', () => {
  const result = G.evaluate(
    [{ kind: 'a', weight: 3 }, { kind: 'b', weight: 1 }],
    [true, false]);
  assert.equal(result.earned, 3);
  assert.equal(result.total, 4);
  assert.equal(result.score, 0.75);
});

check('defaults a missing weight to 1', () => {
  const result = G.evaluate([{ kind: 'a' }], [true]);
  assert.equal(result.total, 1);
  assert.equal(result.score, 1);
});

check('accepts boolean and object outcomes alike', () => {
  const result = G.evaluate([{ kind: 'a', weight: 1 }, { kind: 'b', weight: 1 }], [true, { ok: true, detail: 'fine' }]);
  assert.equal(result.score, 1);
  assert.equal(result.items[1].detail, 'fine');
});

check('an empty check list scores zero rather than dividing by zero', () => {
  const result = G.evaluate([], []);
  assert.equal(result.total, 0);
  assert.equal(result.score, 0);
});

check('a failing outcome is never silently dropped', () => {
  const result = G.evaluate([{ kind: 'a', weight: 1 }, { kind: 'b', weight: 1 }], [true, false]);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[1].ok, false);
});

check('reflect exercises fall back to self assessment', () => {
  const outcome = G.grade(
    { type: 'reflect', checks: [{ kind: 'self_assessed', weight: 1 }] },
    { selfAssessment: 'pass' });
  assert.equal(outcome.mode, 'self-assessed');
  assert.equal(outcome.passed, false);
  assert.equal(outcome.selfAssessed, 'pass');
});

check('self assessment above threshold still does not count as passing', () => {
  const outcome = G.grade(
    { type: 'reflect', checks: [{ kind: 'self_assessed', weight: 1 }] },
    { selfAssessment: 'pass' });
  assert.equal(outcome.score, 0);
});

check('deterministic grade passes at or above the threshold', () => {
  const exercise = { checks: [{ kind: 'stdout_equals', weight: 4 }, { kind: 'stdout_contains', weight: 1 }] };
  const outcome = G.grade(exercise, { outcomes: [true, false] });
  assert.equal(outcome.mode, 'deterministic');
  assert.equal(outcome.score, 0.8);
  assert.equal(outcome.passed, true);
});

check('a weighted score below the threshold fails', () => {
  const exercise = { checks: [{ kind: 'stdout_equals', weight: 4 }, { kind: 'stdout_contains', weight: 1 }] };
  const outcome = G.grade(exercise, { outcomes: [true, false] });
  assert.equal(outcome.score, 0.8);
  const lower = G.grade(
    { checks: [{ kind: 'a', weight: 4 }, { kind: 'b', weight: 2 }, { kind: 'c', weight: 1 }] },
    { outcomes: [true, true, false] });
  assert.equal(lower.score < 0.8, true);
  assert.equal(lower.passed, false);
});

check('an llm rubric blends into the deterministic score', () => {
  const exercise = {
    checks: [{ kind: 'stdout_contains', weight: 1 }],
    llm_rubric: { enabled: true, criteria: 'explain the trade-off' },
  };
  const outcome = G.grade(exercise, { outcomes: [true], llm: { score: 0.5, feedback: 'partial' } });
  assert.equal(outcome.mode, 'llm');
  assert.equal(outcome.llm.feedback, 'partial');
  assert.equal(outcome.score, 0.85);
});

check('llm feedback is ignored when the rubric is disabled', () => {
  const exercise = { checks: [{ kind: 'stdout_contains', weight: 1 }], llm_rubric: { enabled: false } };
  const outcome = G.grade(exercise, { outcomes: [true], llm: { score: 0, feedback: 'nope' } });
  assert.equal(outcome.mode, 'deterministic');
  assert.equal(outcome.score, 1);
});

check('a missing llm payload degrades to deterministic without warning', () => {
  const exercise = {
    checks: [{ kind: 'stdout_contains', weight: 1 }],
    llm_rubric: { enabled: true, criteria: 'x' },
  };
  const outcome = G.grade(exercise, { outcomes: [true] });
  assert.equal(outcome.mode, 'deterministic');
  assert.equal(outcome.score, 1);
});

check('llm scores are clamped into the unit range', () => {
  const exercise = {
    checks: [{ kind: 'stdout_contains', weight: 1 }],
    llm_rubric: { enabled: true, criteria: 'x' },
  };
  assert.equal(G.grade(exercise, { outcomes: [true], llm: { score: 5 } }).score, 1);
  assert.equal(G.grade(exercise, { outcomes: [true], llm: { score: -3 } }).score, 0.7);
});

check('a non-graded exercise without checks never claims a pass', () => {
  const outcome = G.grade({ type: 'predict', checks: [] }, { outcomes: [] });
  assert.equal(outcome.passed, false);
  assert.equal(outcome.mode, 'self-assessed');
});

check('grade tolerates a missing exercise object', () => {
  const outcome = G.grade(undefined, {});
  assert.equal(outcome.passed, false);
  assert.equal(outcome.mode, 'self-assessed');
});

check('grading does not mutate the exercise it receives', () => {
  const exercise = { checks: [{ kind: 'stdout_contains', weight: 1 }] };
  const before = JSON.stringify(exercise);
  G.grade(exercise, { outcomes: [true] });
  assert.equal(JSON.stringify(exercise), before);
});

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log('\nPASS: exercise grader');
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node scripts/test-exercise-grader.cjs
```

Expected: `Cannot find module '../assets/exercise-grader.js'`。

- [ ] **Step 3: 实现判分器**

`assets/exercise-grader.js`：

```javascript
/* Pure grading logic for SILS exercises.
   No DOM, no network, no globals read: the same module runs in the browser and
   under node so the grading rules stay covered by CI without Pyodide. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ExerciseGrader = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const PASS_THRESHOLD = 0.8;
  const LLM_WEIGHT = 0.3;

  function clamp01(value) {
    if (typeof value !== 'number' || Number.isNaN(value)) return 0;
    if (value < 0) return 0;
    if (value > 1) return 1;
    return value;
  }

  function weightOf(check) {
    const value = check && check.weight;
    return typeof value === 'number' && value > 0 ? value : 1;
  }

  function outcomeOf(outcomes, index) {
    const raw = outcomes && outcomes[index];
    if (typeof raw === 'boolean') return { ok: raw, detail: '' };
    if (raw && typeof raw === 'object') {
      return { ok: raw.ok === true, detail: typeof raw.detail === 'string' ? raw.detail : '' };
    }
    return { ok: false, detail: '' };
  }

  function evaluate(checks, outcomes) {
    const list = Array.isArray(checks) ? checks : [];
    const items = list.map((check, index) => {
      const outcome = outcomeOf(outcomes, index);
      return {
        kind: (check && check.kind) || 'unknown',
        weight: weightOf(check),
        ok: outcome.ok,
        detail: outcome.detail,
      };
    });
    let earned = 0;
    let total = 0;
    for (const item of items) {
      total += item.weight;
      if (item.ok) earned += item.weight;
    }
    return { items, earned, total, score: total ? earned / total : 0 };
  }

  function gradedChecks(exercise) {
    const checks = exercise && Array.isArray(exercise.checks) ? exercise.checks : [];
    return checks.filter(check => check && check.kind !== 'self_assessed');
  }

  function grade(exercise, input) {
    const source = exercise && typeof exercise === 'object' ? exercise : {};
    const options = input && typeof input === 'object' ? input : {};
    const checks = gradedChecks(source);
    if (!checks.length) {
      return {
        mode: 'self-assessed',
        passed: false,
        score: 0,
        items: [],
        selfAssessed: options.selfAssessment || '',
        llm: null,
      };
    }
    const deterministic = evaluate(checks, options.outcomes);
    const rubric = source.llm_rubric && typeof source.llm_rubric === 'object' ? source.llm_rubric : {};
    const usable = rubric.enabled === true
      && options.llm && typeof options.llm === 'object'
      && typeof options.llm.score === 'number' && !Number.isNaN(options.llm.score);
    const score = usable
      ? deterministic.score * (1 - LLM_WEIGHT) + clamp01(options.llm.score) * LLM_WEIGHT
      : deterministic.score;
    return {
      mode: usable ? 'llm' : 'deterministic',
      passed: score >= PASS_THRESHOLD,
      score,
      items: deterministic.items,
      selfAssessed: '',
      llm: usable ? options.llm : null,
    };
  }

  return { PASS_THRESHOLD, LLM_WEIGHT, clamp01, evaluate, grade };
});
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node scripts/test-exercise-grader.cjs
```

Expected: 全部 `ok`，末行 `PASS: exercise grader`。

- [ ] **Step 5: 提交**

```bash
git add assets/exercise-grader.js scripts/test-exercise-grader.cjs
git commit -m "feat: add pure-function exercise grader with node tests"
```

---

## Task 5: L4 进度存储（浏览器本地 + 合并策略）

**Files:**
- Create: `assets/exercise-store.js`
- Create: `scripts/test-exercise-store.cjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `ExerciseStore.create({storage, now})` → store，`storage` 需实现 `getItem/setItem`（缺省用 `localStorage`），`now` 为 `() => number`
  - `store.read(chapterId, exerciseId)` → `record | null`，`record = {passed, score, attempts, code, selfAssessed, updated}`
  - `store.write(chapterId, exerciseId, patch)` → `record`，`patch` 可含 `passed/score/code/selfAssessed`，`attempts` 自动 +1
  - `store.snapshot()` → 扁平数组 `[{chapter, exercise, passed, score, attempts, code, selfAssessed, updated}]`
  - `store.merge(rows)` → `{changed, records}`，`changed` 为需要回写服务端的记录数
  - `store.chapterSummary(chapterId, exerciseIds)` → `{total, passed, selfAssessed, minutes}`
  - `store.summary(chapterIdsWithExercises)` → `{total, passed, selfAssessed, minutes}`
  - `store.available` → boolean（存储是否可用，false 时降级内存态）

- [ ] **Step 1: 写失败的测试**

`scripts/test-exercise-store.cjs`：

```javascript
'use strict';
const assert = require('node:assert/strict');
const { create } = require('../assets/exercise-store.js');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); }
}

function memoryStorage(initial) {
  const data = Object.assign(Object.create(null), initial || {});
  return {
    getItem: key => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: key => { delete data[key]; },
    _data: data,
  };
}

console.log('ExerciseStore');

check('an unknown exercise reads as null', () => {
  const store = create({ storage: memoryStorage() });
  assert.equal(store.read('chapter-1', 'ch01-ex01'), null);
});

check('write stores a record and read returns it', () => {
  const store = create({ storage: memoryStorage() });
  const written = store.write('chapter-1', 'ch01-ex01', { passed: true, score: 1 });
  assert.equal(written.passed, true);
  assert.equal(store.read('chapter-1', 'ch01-ex01').passed, true);
});

check('attempts increment on every write', () => {
  const store = create({ storage: memoryStorage() });
  store.write('chapter-1', 'ch01-ex01', { code: 'a' });
  store.write('chapter-1', 'ch01-ex01', { code: 'b' });
  assert.equal(store.read('chapter-1', 'ch01-ex01').attempts, 2);
});

check('a second write keeps the best score instead of degrading it', () => {
  const store = create({ storage: memoryStorage() });
  store.write('chapter-1', 'ch01-ex01', { passed: true, score: 1 });
  store.write('chapter-1', 'ch01-ex01', { passed: true, score: 0.8 });
  assert.equal(store.read('chapter-1', 'ch01-ex01').score, 1);
});

check('a later failure never clears an earlier pass', () => {
  const store = create({ storage: memoryStorage() });
  store.write('chapter-1', 'ch01-ex01', { passed: true });
  store.write('chapter-1', 'ch01-ex01', { passed: false });
  assert.equal(store.read('chapter-1', 'ch01-ex01').passed, true);
});

check('write always refreshes the updated stamp', () => {
  let clock = 1000;
  const store = create({ storage: memoryStorage(), now: () => (clock += 1) });
  const first = store.write('chapter-1', 'ch01-ex01', {});
  const second = store.write('chapter-1', 'ch01-ex01', {});
  assert.equal(second.updated > first.updated, true);
});

check('snapshot flattens every chapter into rows', () => {
  const store = create({ storage: memoryStorage() });
  store.write('chapter-1', 'ch01-ex01', { passed: true });
  store.write('chapter-2', 'ch02-ex01', { score: 0.5 });
  const rows = store.snapshot();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].chapter, 'chapter-1');
  assert.equal(rows[0].exercise, 'ch01-ex01');
});

check('merge adopts server rows the client has never seen', () => {
  const store = create({ storage: memoryStorage(), now: () => 500 });
  const result = store.merge([{ chapter: 'chapter-1', exercise: 'ch01-ex01', passed: 1, score: 1, updated: 400 }]);
  assert.equal(result.changed, 0);
  assert.equal(store.read('chapter-1', 'ch01-ex01').passed, true);
});

check('merge lets a newer local record win', () => {
  const store = create({ storage: memoryStorage(), now: () => 900 });
  store.write('chapter-1', 'ch01-ex01', { passed: true, score: 1 });
  const result = store.merge([{ chapter: 'chapter-1', exercise: 'ch01-ex01', passed: 0, score: 0, updated: 400 }]);
  assert.equal(result.changed, 1);
  assert.equal(store.read('chapter-1', 'ch01-ex01').passed, true);
});

check('merge lets a newer server record win', () => {
  const store = create({ storage: memoryStorage(), now: () => 300 });
  store.write('chapter-1', 'ch01-ex01', { passed: false, score: 0 });
  store.merge([{ chapter: 'chapter-1', exercise: 'ch01-ex01', passed: 1, score: 1, updated: 800 }]);
  assert.equal(store.read('chapter-1', 'ch01-ex01').passed, true);
});

check('an equal stamp resolves in favour of passing', () => {
  const store = create({ storage: memoryStorage(), now: () => 600 });
  store.write('chapter-1', 'ch01-ex01', { passed: false });
  store.merge([{ chapter: 'chapter-1', exercise: 'ch01-ex01', passed: 1, updated: 600 }]);
  assert.equal(store.read('chapter-1', 'ch01-ex01').passed, true);
});

check('merge ignores malformed rows without throwing', () => {
  const store = create({ storage: memoryStorage() });
  const result = store.merge([null, { chapter: 'chapter-1' }, { exercise: 'ch01-ex01' }, 42]);
  assert.equal(Array.isArray(result.records), true);
});

check('chapter summary counts only the given exercise ids', () => {
  const store = create({ storage: memoryStorage() });
  store.write('chapter-1', 'ch01-ex01', { passed: true, score: 1 });
  store.write('chapter-1', 'ch01-ex02', { selfAssessed: 'pass' });
  const summary = store.chapterSummary('chapter-1', ['ch01-ex01', 'ch01-ex02', 'ch01-ex03']);
  assert.equal(summary.total, 3);
  assert.equal(summary.passed, 1);
  assert.equal(summary.selfAssessed, 1);
});

check('summary aggregates across chapters', () => {
  const store = create({ storage: memoryStorage() });
  store.write('chapter-1', 'ch01-ex01', { passed: true });
  store.write('chapter-2', 'ch02-ex01', { passed: true });
  const summary = store.summary({ 'chapter-1': ['ch01-ex01'], 'chapter-2': ['ch02-ex01'] });
  assert.equal(summary.total, 2);
  assert.equal(summary.passed, 2);
});

check('an unavailable storage degrades to memory without throwing', () => {
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const store = create({ storage: broken });
  assert.equal(store.available, false);
  store.write('chapter-1', 'ch01-ex01', { passed: true });
  assert.equal(store.read('chapter-1', 'ch01-ex01').passed, true);
});

check('corrupted stored JSON is discarded rather than fatal', () => {
  const storage = memoryStorage({ 'ms-cookbook.exercise.v1': '{not json' });
  const store = create({ storage });
  assert.deepEqual(store.snapshot(), []);
});

check('a code payload beyond the cap is trimmed before storing', () => {
  const store = create({ storage: memoryStorage() });
  store.write('chapter-1', 'ch01-ex01', { code: 'x'.repeat(25000) });
  assert.equal(store.read('chapter-1', 'ch01-ex01').code.length, 20000);
});

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log('\nPASS: exercise store');
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node scripts/test-exercise-store.cjs
```

Expected: `Cannot find module '../assets/exercise-store.js'`。

- [ ] **Step 3: 实现存储**

`assets/exercise-store.js`：

```javascript
/* Local-first progress storage for SILS exercises.
   Guests keep everything in localStorage; signed-in readers merge with the
   server. A denied or corrupted storage degrades to an in-memory map so the
   reading experience never depends on storage being available. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ExerciseStore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const KEY = 'ms-cookbook.exercise.v1';
  const CODE_LIMIT = 20000;

  function safeStorage(candidate) {
    try {
      const probe = '__sils_probe__';
      candidate.setItem(probe, '1');
      candidate.removeItem(probe);
      return candidate;
    } catch { return null; }
  }

  function create(options) {
    const settings = options || {};
    const clock = typeof settings.now === 'function' ? settings.now : () => Date.now();
    const backing = safeStorage(settings.storage || (typeof localStorage !== 'undefined' ? localStorage : null));
    const memory = Object.create(null);
    const available = backing !== null;

    function load() {
      if (!backing) return Object.create(null);
      let raw;
      try { raw = backing.getItem(KEY); } catch { return Object.create(null); }
      if (!raw) return Object.create(null);
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : Object.create(null);
      } catch { return Object.create(null); }
    }

    let data = load();

    function flush() {
      if (!backing) return;
      try { backing.setItem(KEY, JSON.stringify(data)); } catch { /* quota or denial: keep memory copy */ }
    }

    function normalize(record) {
      const source = record && typeof record === 'object' ? record : {};
      return {
        passed: source.passed === true,
        score: typeof source.score === 'number' && source.score >= 0 ? source.score : 0,
        attempts: typeof source.attempts === 'number' && source.attempts > 0 ? source.attempts : 0,
        code: typeof source.code === 'string' ? source.code.slice(0, CODE_LIMIT) : '',
        selfAssessed: typeof source.selfAssessed === 'string' ? source.selfAssessed : '',
        updated: typeof source.updated === 'number' ? source.updated : 0,
      };
    }

    function bucket(chapterId) {
      if (!data[chapterId]) data[chapterId] = Object.create(null);
      return data[chapterId];
    }

    function read(chapterId, exerciseId) {
      const chapter = data[chapterId];
      if (!chapter || !chapter[exerciseId]) return null;
      return normalize(chapter[exerciseId]);
    }

    function write(chapterId, exerciseId, patch) {
      const previous = read(chapterId, exerciseId);
      const next = Object.assign(previous || { attempts: 0 }, patch || {}, { updated: clock() });
      next.passed = next.passed === true || (previous ? previous.passed : false);
      next.score = Math.max(next.score || 0, previous ? previous.score : 0);
      next.attempts = (previous ? previous.attempts : 0) + 1;
      next.code = typeof next.code === 'string' ? next.code.slice(0, CODE_LIMIT) : '';
      next.selfAssessed = typeof next.selfAssessed === 'string' ? next.selfAssessed : '';
      bucket(chapterId)[exerciseId] = normalize(next);
      flush();
      return normalize(next);
    }

    function snapshot() {
      const rows = [];
      for (const chapterId of Object.keys(data)) {
        const chapter = data[chapterId] || {};
        for (const exerciseId of Object.keys(chapter)) {
          const record = normalize(chapter[exerciseId]);
          rows.push({
            chapter: chapterId,
            exercise: exerciseId,
            passed: record.passed ? 1 : 0,
            score: record.score,
            attempts: record.attempts,
            code: record.code,
            selfAssessed: record.selfAssessed,
            updated: record.updated,
          });
        }
      }
      return rows;
    }

    function merge(rows) {
      const changed = [];
      const records = [];
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || typeof row !== 'object') continue;
        const chapterId = typeof row.chapter === 'string' ? row.chapter : '';
        const exerciseId = typeof row.exercise === 'string' ? row.exercise : '';
        if (!chapterId || !exerciseId) continue;
        const incoming = normalize({ ...row, passed: row.passed === 1 || row.passed === true });
        const local = read(chapterId, exerciseId);
        if (!local) {
          bucket(chapterId)[exerciseId] = incoming;
          records.push({ chapterId, exerciseId, record: incoming });
          continue;
        }
        const serverWins = incoming.updated > local.updated
          || (incoming.updated === local.updated && incoming.passed && !local.passed);
        if (serverWins) {
          bucket(chapterId)[exerciseId] = incoming;
          records.push({ chapterId, exerciseId, record: incoming });
        } else if (local.updated > incoming.updated) {
          changed.push({ chapter: chapterId, exercise: exerciseId, passed: local.passed ? 1 : 0, score: local.score, attempts: local.attempts, code: local.code, selfAssessed: local.selfAssessed, updated: local.updated });
        }
      }
      flush();
      return { changed, records };
    }

    function chapterSummary(chapterId, exerciseIds) {
      const ids = Array.isArray(exerciseIds) ? exerciseIds : [];
      let passed = 0;
      let selfAssessed = 0;
      for (const exerciseId of ids) {
        const record = read(chapterId, exerciseId);
        if (!record) continue;
        if (record.passed) passed += 1;
        else if (record.selfAssessed) selfAssessed += 1;
      }
      return { total: ids.length, passed, selfAssessed };
    }

    function summary(chapterMap) {
      let total = 0;
      let passed = 0;
      let selfAssessed = 0;
      for (const chapterId of Object.keys(chapterMap || {})) {
        const part = chapterSummary(chapterId, chapterMap[chapterId]);
        total += part.total;
        passed += part.passed;
        selfAssessed += part.selfAssessed;
      }
      return { total, passed, selfAssessed };
    }

    function reset() {
      data = Object.create(null);
      if (backing) { try { backing.removeItem(KEY); } catch { /* ignore */ } }
      return store;
    }

    const store = { available, read, write, snapshot, merge, chapterSummary, summary, reset };
    return store;
  }

  return { KEY, CODE_LIMIT, create };
});
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node scripts/test-exercise-store.cjs
```

Expected: 全部 `ok`，末行 `PASS: exercise store`。

- [ ] **Step 5: 提交**

```bash
git add assets/exercise-store.js scripts/test-exercise-store.cjs
git commit -m "feat: add local-first exercise progress store with merge strategy"
```

---

## Task 6: L2 Pyodide vendor 与沙箱 Worker

**Files:**
- Create: `scripts/vendor-pyodide.mjs`
- Create: `assets/exercise-sandbox.js`
- Create: `assets/exercise-worker.js`
- Create: `assets/vendor/pyodide/*`

**Interfaces:**
- Consumes: 无
- Produces:
  - `ExerciseSandbox.create({workerUrl, timeoutMs})` → sandbox
  - `sandbox.run(request)` → `Promise<{ok, stdout, error, values, outcomes, ms}>`，`request = {code, checks, answer, timeoutMs}`
  - `sandbox.preload()` → `Promise<void>`，提前拉起 Worker（不执行代码）
  - `sandbox.destroy()` → 释放 Worker
  - `SandboxOutcome.timeout` = `'timeout'`，`SandboxOutcome.crash` = `'crash'`，`SandboxOutcome.worker_error` = `'worker_error'`

- [ ] **Step 1: 写 vendor 下载脚本**

`scripts/vendor-pyodide.mjs`：

```javascript
import {mkdirSync, existsSync, writeFileSync, statSync, readFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const target = resolve(root, 'assets/vendor/pyodide');
const VERSION = '0.26.4';
const BASE = `https://cdn.jsdelivr.net/pyodide/v${VERSION}/full/`;
const FILES = ['pyodide.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];

if (existsSync(resolve(target, 'VERSION')) && readFileSync(resolve(target, 'VERSION'), 'utf8').trim() === VERSION) {
  const complete = FILES.every(name => existsSync(resolve(target, name)));
  if (complete) {
    console.log(`Pyodide ${VERSION} already vendored.`);
    process.exit(0);
  }
}

mkdirSync(target, { recursive: true});
for (const name of FILES) {
  const response = await fetch(BASE + name);
  if (!response.ok) throw new Error(`download failed ${name}: ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length < 1024) throw new Error(`${name} is suspiciously small (${body.length} bytes)`);
  writeFileSync(resolve(target, name), body);
  console.log(`fetched ${name} (${(body.length / 1048576).toFixed(2)} MB)`);
}
writeFileSync(resolve(target, 'VERSION'), `${VERSION}\n`);
const wasm = statSync(resolve(target, 'pyodide.asm.wasm')).size;
if (wasm < 1_000_000) throw new Error(`pyodide.asm.wasm looks truncated (${wasm} bytes)`);
console.log(`Pyodide ${VERSION} vendored into assets/vendor/pyodide/`);
```

- [ ] **Step 2: 下载并校验 Pyodide**

```bash
cd D:/Coding/ms-cookbook
node scripts/vendor-pyodide.mjs
.venv/bin/python scripts/test_pyodide_vendor.py
```

Expected: 四行 `fetched ...` + `Pyodide 0.26.4 vendored into assets/vendor/pyodide/` + `PASS: Pyodide 0.26.4 vendor complete`。

网络失败时：不要改 CDN、不要改版本。检查代理（`127.0.0.1:7897`）后重试。**Pyodide 版本是锁定的（G9）**，换版本会破坏 `importScripts` 路径。

- [ ] **Step 3: 写 Worker**

`assets/exercise-worker.js`：

```javascript
/* Pyodide sandbox worker. Runs learner code and evaluates checks inside one
   Python session so a check can see variables the learner's code defined.
   Pyodide ships without network, filesystem writes and subprocesses, which is
   exactly the boundary we want. */
'use strict';

let runtime = null;
let loading = null;

function reply(message) { self.postMessage(message); }

async function ensureRuntime() {
  if (runtime) return runtime;
  if (!loading) {
    loading = (async () => {
      importScripts('./vendor/pyodide/pyodide.js');
      return loadPyodide({ indexURL: './vendor/pyodide/' });
    })();
  }
  runtime = await loading;
  return runtime;
}

function runUserCode(code) {
  return `
import io, contextlib, traceback
_out = io.StringIO()
_err = None
_ok = True
try:
    with contextlib.redirect_stdout(_out), contextlib.redirect_stderr(_out):
        exec(compile(${JSON.stringify(code)}, '<exercise>', 'exec'), globals())
except BaseException:
    _ok = False
    _err = traceback.format_exc(limit=8)
__sils_stdout = _out.getvalue()
__sils_error = _err
__sils_ok = _ok
`;
}

function runAssert(statement) {
  return `
import traceback
__sils_assert_ok = True
__sils_assert_detail = ''
try:
    exec(compile(${JSON.stringify(statement)}, '<check>', 'exec'), globals())
except BaseException:
    __sils_assert_ok = False
    __sils_assert_detail = traceback.format_exc(limit=3)
`;
}

function readVariable(name) {
  return `
import traceback
__sils_found = name in globals()
__sils_value = globals().get(name)
`;
}

function evaluateSandboxChecks(pyodide, checks) {
  return checks.map(check => {
    if (check.kind === 'assert_python') {
      pyodide.runPython(runAssert(check.code));
      const ok = pyodide.globals.get('__sils_assert_ok') === true;
      const detail = ok ? '' : String(pyodide.globals.get('__sils_assert_detail') || '').split('\n').slice(-1)[0];
      return { ok, detail };
    }
    if (check.kind === 'var_equals') {
      pyodide.runPython(readVariable(check.name));
      const found = pyodide.globals.get('__sils_found') === true;
      const value = found ? pyodide.globals.get('__sils_value') : undefined;
      return { ok: found && value === check.value, detail: found ? `got ${JSON.stringify(value)}` : `${check.name} was never assigned` };
    }
    if (check.kind === 'var_in_range') {
      pyodide.runPython(readVariable(check.name));
      const found = pyodide.globals.get('__sils_found') === true;
      const value = found ? Number(pyodide.globals.get('__sils_value')) : NaN;
      const ok = found && Number.isFinite(value) && value >= check.min && value <= check.max;
      return { ok, detail: found ? `got ${value}` : `${check.name} was never assigned` };
    }
    return null;
  });
}

function evaluateHostChecks(checks, stdout, answer) {
  return checks.map(check => {
    if (check.kind === 'stdout_contains') {
      const ok = stdout.includes(check.value);
      return { ok, detail: ok ? '' : `output does not contain ${JSON.stringify(check.value)}` };
    }
    if (check.kind === 'stdout_equals') {
      const actual = stdout.trim();
      const ok = actual === String(check.value).trim();
      return { ok, detail: ok ? '' : `output was ${JSON.stringify(actual)}` };
    }
    if (check.kind === 'stdout_matches') {
      const ok = new RegExp(check.pattern).test(stdout);
      return { ok, detail: ok ? '' : 'output did not match the expected shape' };
    }
    if (check.kind === 'output_choice') {
      const chosen = Array.isArray(answer) ? answer.slice().sort() : [];
      const expected = check.correct.slice().sort();
      const ok = chosen.length === expected.length && chosen.every((value, index) => value === expected[index]);
      return { ok, detail: `selected ${JSON.stringify(chosen)}` };
    }
    return null;
  });
}

const SANDBOX_KINDS = ['assert_python', 'var_equals', 'var_in_range'];

self.addEventListener('message', async event => {
  const request = event.data || {};
  if (request.type !== 'run') return;
  const started = Date.now();
  try {
    const pyodide = await ensureRuntime();
    pyodide.runPython(runUserCode(request.code || ''));
    const ok = pyodide.globals.get('__sils_ok') !== false;
    const stdout = String(pyodide.globals.get('__sils_stdout') || '');
    const error = pyodide.globals.get('__sils_error') ? String(pyodide.globals.get('__sils_error')) : '';
    const checks = Array.isArray(request.checks) ? request.checks : [];
    // Both evaluators return one slot per check so the two arrays stay aligned
    // by index; a mismatch here would silently mislabel which assertion failed.
    const sandboxOutcomes = ok ? evaluateSandboxChecks(pyodide, checks) : checks.map(() => null);
    const hostOutcomes = evaluateHostChecks(checks, stdout, request.answer);
    const outcomes = checks.map((check, index) => {
      const own = SANDBOX_KINDS.includes(check.kind) ? sandboxOutcomes[index] : hostOutcomes[index];
      return own || { ok: false, detail: ok ? 'not evaluated' : 'code did not run' };
    });
    reply({
      type: 'result', ok, stdout, error, outcomes, ms: Date.now() - started,
    });
  } catch (failure) {
    reply({
      type: 'result', ok: false, stdout: '', error: String(failure && failure.message || failure),
      outcomes: [], ms: Date.now() - started,
    });
  }
});
```

**关键设计点**：`evaluateSandboxChecks` 与 `evaluateHostChecks` **都返回与 `checks` 等长的数组**，用 `null` 占住不属于自己处理的 kind。合并时按索引取，绝不用 `shift()` —— 两个数组混用 `shift()` 会让第 2 题之后的断言结果全部错位显示。

- [ ] **Step 4: 写主线程沙箱门面**

`assets/exercise-sandbox.js`：

```javascript
/* Main-thread facade over the Pyodide worker.
   Nothing here touches the DOM beyond reporting state, so the same file can be
   reasoned about without a browser. The runtime is loaded lazily on first run
   (G9): Pyodide never lands in the initial page payload. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ExerciseSandbox = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DEFAULT_TIMEOUT = 15000;

  function create(options) {
    const settings = options || {};
    const workerUrl = settings.workerUrl || 'assets/exercise-worker.js';
    const defaultTimeout = settings.timeoutMs || DEFAULT_TIMEOUT;
    let worker = null;
    let generation = 0;
    let loadingState = null;

    function ensureWorker() {
      if (worker) return worker;
      const created = new Worker(workerUrl);
      created.addEventListener('error', () => { worker = null; });
      worker = created;
      return worker;
    }

    function destroy() {
      if (worker) { worker.terminate(); worker = null; }
      loadingState = null;
    }

    function preload() {
      if (worker) return Promise.resolve();
      try { ensureWorker(); return Promise.resolve(); }
      catch (error) { return Promise.reject(error); }
    }

    function runOnce(request) {
      return new Promise((resolve, reject) => {
        let instance;
        try { instance = ensureWorker(); }
        catch (error) { reject({ reason: 'worker_error', message: String(error.message || error) }); return; }
        const stamp = ++generation;
        const limit = request.timeoutMs || defaultTimeout;
        let settled = false;
        const finish = value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          instance.removeEventListener('message', onMessage);
          instance.removeEventListener('error', onError);
          resolve(value);
        };
        const timer = setTimeout(() => {
          destroy();
          finish({ ok: false, stdout: '', error: `运行超时（${Math.round(limit / 1000)}秒），请检查是否有死循环`, outcomes: [], ms: limit, reason: 'timeout' });
        }, limit);
        const onMessage = event => {
          if (stamp !== generation && settled) return;
          const data = event.data || {};
          if (data.type !== 'result') return;
          finish({ ok: data.ok === true, stdout: data.stdout || '', error: data.error || '', outcomes: data.outcomes || [], ms: data.ms || 0 });
        };
        const onError = event => {
          destroy();
          finish({ ok: false, stdout: '', error: (event && event.message) || '运行环境异常', outcomes: [], ms: 0, reason: 'crash' });
        };
        instance.addEventListener('message', onMessage);
        instance.addEventListener('error', onError);
        instance.postMessage({
          type: 'run',
          code: request.code || '',
          checks: Array.isArray(request.checks) ? request.checks : [],
          answer: request.answer || null,
          timeoutMs: limit,
        });
      });
    }

    async function run(request) {
      try {
        return await runOnce(request);
      } catch (failure) {
        if (failure && failure.reason) return { ...failure, outcomes: [], stdout: '', ok: false, ms: 0 };
        return { ok: false, stdout: '', error: String(failure && failure.message || failure), outcomes: [], ms: 0, reason: 'worker_error' };
      }
    }

    return { preload, run, destroy, get busy() { return worker !== null; } };
  }

  return { DEFAULT_TIMEOUT, create };
});
```

- [ ] **Step 5: 提交**

```bash
git add scripts/vendor-pyodide.mjs assets/exercise-sandbox.js assets/exercise-worker.js assets/vendor/pyodide
git commit -m "feat: vendor Pyodide 0.26.4 and add the sandbox worker facade"
```

**注意**：`assets/vendor/pyodide` 约 15MB。如果仓库需要控制体积，可在 `.gitattributes` 中为该目录配置 Git LFS。**先不要**加 LFS —— 确认 ModelScope 部署能接受这个体积后再决定。

---

## Task 7: L4 服务端 API

**Files:**
- Modify: `app.py:91`（`executescript` 追加表）
- Modify: `app.py` 约 566 行后（新增端点）
- Create: `tests/test_exercise_api.py`

**Interfaces:**
- Consumes: `assets/exercises.js`（读 `window.EXERCISE_DATA` 取合法 exercise id 集合）、`app.user/request/require_user/db`（`app.py:302-322,72-91`）、`httpx`（已在 `requirements.txt`）
- Produces:
  - `GET /api/exercises/progress` → `{items:[{chapter, exercise, passed, score, attempts, code, selfAssessed, updated}]}`
  - `POST /api/exercises/progress` → 201 `{saved: int}`，body `{items:[...]}`
  - `POST /api/exercises/grade` → `{score, feedback}` 或 503 `{detail:'LLM 评分未启用', fallback:true}`

- [ ] **Step 1: 写失败的测试**

`tests/test_exercise_api.py`：

```python
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
```

- [ ] **Step 2: 运行测试确认失败**

```bash
.venv/bin/python -m pytest tests/test_exercise_api.py -q
```

Expected: 大量 404（端点不存在）与 `FileNotFoundError`（`assets/exercises.js` 若 Task 3 未生成）。

若报 `FileNotFoundError: assets/exercises.js`，先跑 `python3 scripts/build-exercises.py`（此时 Task 3 已让 manifest 只含 3 章，见 Step 4 说明）。

- [ ] **Step 3: 加表**

在 `app.py` 的 `executescript` 中，`CREATE INDEX IF NOT EXISTS wishes_user_time ON wishes(user_id, created);` 之后追加：

```python
    CREATE TABLE IF NOT EXISTS exercise_progress(
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
    CREATE INDEX IF NOT EXISTS exercise_progress_user ON exercise_progress(user_id, updated);
```

- [ ] **Step 4: 加载练习索引**

在 `app.py:254`（`book_data = json.loads(raw)` 之后）追加：

```python
    exercise_raw = (ROOT / 'assets/exercises.js').read_text(encoding='utf-8').split('=',1)[1].strip().rstrip(';')
    exercise_data = json.loads(exercise_raw)
    exercise_index = {cid: {item['id'] for item in chapter['exercises']['zh']} for cid, chapter in exercise_data['chapters'].items()}
    exercise_index = {cid: ids for cid, ids in exercise_index.items() if cid in chapters}
```

**注意**：`chapters` 定义在 `app.py:256`，所以这段必须放在**它之后**。实际插入点：`app.py:257`（`admins = ...` 那一行）之前。

同时在 pydantic 模型区（`app.py:47` 之后，`AnalyticsView` 附近）追加：

```python
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
    items: list[ExerciseItem] = Field(default_factory=list, max_length=50)

class ExerciseGrade(BaseModel):
    exercise: str = Field(min_length=1, max_length=64)
    answer: str = Field(default='', max_length=8000)
    criteria: str = Field(default='', max_length=2000)
```

若 pydantic v2 对 `Field(max_length=…)` 用在 `list` 上报错，改用 `Field(default_factory=list)` + 手动长度校验。

- [ ] **Step 5: 加端点**

在 `app.py` 的 `delete_wish`（约 565 行）之后、`@app.get('/')` 之前插入：

```python
    @app.get('/api/exercises/progress')
    def list_exercise_progress(request: Request):
        u=user(request)
        if not u: return {'items':[]}
        with db() as conn:
            rows=conn.execute('SELECT chapter,exercise,passed,score,code,self_assessed,attempts,updated FROM exercise_progress WHERE user_id=? ORDER BY updated DESC',(u['id'],)).fetchall()
        items=[dict(row) for row in rows]
        for item in items: item['selfAssessed']=item.pop('self_assessed') and 'graded' or ''
        return {'items':items}

    @app.post('/api/exercises/progress',status_code=201)
    def save_exercise_progress(payload: ExerciseProgress, request: Request):
        u=require_user(request)
        now=int(time.time()); saved=0
        with db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            count=conn.execute('SELECT count(*) FROM exercise_progress WHERE user_id=? AND updated>?',(u['id'],now-60)).fetchone()[0]
            if count+len(payload.items)>20: raise HTTPException(429,'操作太频繁，请稍后再试')
            for item in payload.items:
                if item.chapter not in exercise_index or item.exercise not in exercise_index[item.chapter]:
                    raise HTTPException(422,'练习不存在或尚未开放')
                conn.execute('''INSERT INTO exercise_progress VALUES (?,?,?,?,?,?,?,?,?,?)
                                ON CONFLICT(user_id,chapter,exercise) DO UPDATE SET
                                code=excluded.code,passed=MAX(exercise_progress.passed,excluded.passed),
                                score=MAX(exercise_progress.score,excluded.score),
                                self_assessed=excluded.self_assessed,
                                attempts=excluded.attempts,updated=excluded.updated''',
                             (secrets.token_hex(16),u['id'],item.chapter,item.exercise,item.code,item.passed,item.score,1 if item.selfAssessed else 0,item.attempts,item.updated or now))
                saved+=1
        return {'saved':saved}

    @app.post('/api/exercises/grade')
    def grade_exercise(payload: ExerciseGrade):
        known = {i for ids in exercise_index.values() for i in ids}
        if payload.exercise not in known: raise HTTPException(422,'练习不存在或尚未开放')
        key=os.getenv('EXERCISE_LLM_KEY'); base=os.getenv('EXERCISE_LLM_BASE_URL')
        if not key or not base: raise HTTPException(503,'LLM 评分未启用',headers={'x-sils-fallback':'1'})
        model=os.getenv('EXERCISE_LLM_MODEL','gpt-4o-mini')
        prompt=('你是评分助手。按给定标准给答案打分，只输出 JSON。\n'
                f'标准：{payload.criteria}\n答案：{payload.answer}\n'
                '输出格式：{"score": 0 到 1 的小数, "feedback": "一句话点评"}')
        try:
            response=httpx.post(base.rstrip('/')+'/chat/completions',
                headers={'Authorization':f'Bearer {key}'},
                json={'model':model,'temperature':0,'messages':[{'role':'user','content':prompt}]},timeout=20)
            response.raise_for_status()
            content=response.json()['choices'][0]['message']['content']
        except Exception:
            LOGGER.exception('Exercise grading unavailable')
            raise HTTPException(503,'LLM 评分暂时不可用',headers={'x-sils-fallback':'1'})
        try:
            verdict=json.loads(content)
            score=max(0.0,min(1.0,float(verdict.get('score',0))))
            feedback=str(verdict.get('feedback',''))[:500]
        except (ValueError, TypeError):
            raise HTTPException(503,'评分结果无法解析',headers={'x-sils-fallback':'1'})
        return {'score':score,'feedback':feedback}
```

`httpx` 已在 `app.py` 顶部导入（第 11 行）与 `requirements.txt`。

- [ ] **Step 6: 运行测试确认通过**

```bash
.venv/bin/python -m pytest tests/test_exercise_api.py -q
```

Expected: 全部通过。若 `test_grading_uses_a_configured_endpoint` 失败，检查 monkeypatch 目标是否与实际 import 方式匹配。

- [ ] **Step 7: 运行全量测试确认无回归**

```bash
.venv/bin/python -m pytest tests -q
```

Expected: 全部通过，含 Task 1 的 5 个基线测试。

- [ ] **Step 8: 提交**

```bash
git add app.py tests/test_exercise_api.py
git commit -m "feat: add exercise progress and grading endpoints"
```

---

## Task 8: 章节页练习面板 UI

**Files:**
- Create: `assets/exercise-ui.js`
- Create: `assets/exercise.css`

**Interfaces:**
- Consumes: `window.EXERCISE_DATA`、`ExerciseGrader`、`ExerciseStore`、`ExerciseSandbox`、`window.MSI18N.t`
- Produces: `ExerciseUI.init()`（幂等）、`ExerciseUI.render(chapterId)`、`ExerciseUI.teardown()`

- [ ] **Step 1: 写样式**

`assets/exercise.css`：

```css
/* Exercise panel and learning map for the reading view. All selectors are
   namespaced so nothing here can leak into the article typography. */
.exercise-panel {
  margin: 2.5rem auto 0;
  max-width: 46rem;
  padding: 0 1.25rem;
}
.exercise-panel:empty { display: none; }
.exercise-summary {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
  border-top: 1px solid var(--color-border-tertiary, rgba(0,0,0,.15));
  padding-top: 1.25rem;
}
.exercise-summary h2 { font-size: 1.05rem; font-weight: 500; margin: 0; }
.exercise-count { font-size: .82rem; color: var(--color-text-secondary, #666); }
.exercise-card {
  border: 1px solid var(--color-border-tertiary, rgba(0,0,0,.15));
  border-radius: 12px;
  margin-top: .75rem;
  overflow: hidden;
}
.exercise-toggle {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: .75rem;
  width: 100%;
  padding: .85rem 1rem;
  background: none;
  border: 0;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.exercise-toggle:hover { background: var(--color-background-secondary, #f6f6f6); }
.exercise-toggle-title { font-size: .95rem; }
.exercise-toggle-meta { font-size: .78rem; color: var(--color-text-secondary, #666); white-space: nowrap; }
.exercise-state { font-size: .78rem; padding: .1rem .5rem; border-radius: 999px; border: 1px solid currentColor; }
.exercise-state[data-state="passed"] { color: #0f6e56; }
.exercise-state[data-state="self"] { color: #854f0b; }
.exercise-state[data-state="todo"] { color: var(--color-text-tertiary, #999); }
.exercise-body { padding: 0 1rem 1rem; }
.exercise-objective { font-size: .84rem; color: var(--color-text-secondary, #666); margin: 0 0 .5rem; }
.exercise-prompt { font-size: .95rem; line-height: 1.6; margin: 0 0 .75rem; white-space: pre-wrap; }
.exercise-editor {
  width: 100%;
  min-height: 11rem;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: .86rem;
  line-height: 1.55;
  padding: .7rem .8rem;
  border: 1px solid var(--color-border-secondary, rgba(0,0,0,.25));
  border-radius: 8px;
  resize: vertical;
  background: var(--color-background-primary, #fff);
  color: var(--color-text-primary, #111);
}
.exercise-actions { display: flex; gap: .5rem; flex-wrap: wrap; margin-top: .6rem; }
.exercise-actions button {
  font: inherit;
  font-size: .86rem;
  padding: .45rem .9rem;
  border-radius: 8px;
  border: 1px solid var(--color-border-secondary, rgba(0,0,0,.25));
  background: var(--color-background-primary, #fff);
  color: var(--color-text-primary, #111);
  cursor: pointer;
}
.exercise-actions button[data-role="run"] {
  background: #534ab7;
  border-color: #534ab7;
  color: #fff;
}
.exercise-actions button[disabled] { opacity: .55; cursor: default; }
.exercise-status { font-size: .84rem; margin: .6rem 0 0; min-height: 1.2em; color: var(--color-text-secondary, #666); }
.exercise-status[data-tone="error"] { color: #a32d2d; }
.exercise-status[data-tone="pass"] { color: #0f6e56; }
.exercise-checks { list-style: none; margin: .6rem 0 0; padding: 0; font-size: .84rem; }
.exercise-checks li { padding: .25rem 0; border-top: 1px solid var(--color-border-tertiary, rgba(0,0,0,.12)); }
.exercise-checks li[data-ok="false"] { color: #a32d2d; }
.exercise-checks li[data-ok="true"] { color: #0f6e56; }
.exercise-solution {
  margin-top: .6rem;
  font-size: .85rem;
  line-height: 1.6;
  background: var(--color-background-secondary, #f6f6f6);
  border-radius: 8px;
  padding: .7rem .85rem;
}
.exercise-solution pre { margin: .3rem 0; overflow-x: auto; }
.exercise-choices { display: flex; flex-direction: column; gap: .4rem; margin: 0 0 .75rem; }
.exercise-choices label { display: flex; gap: .5rem; align-items: flex-start; font-size: .92rem; }
.exercise-loader { font-size: .86rem; color: var(--color-text-secondary, #666); padding: .5rem 0; }
.exercise-fallback { font-size: .84rem; color: var(--color-text-secondary, #666); }
.exercise-fallback button { font: inherit; font-size: .82rem; margin-right: .4rem; }

.exercise-map { padding: 2rem 0; }
.exercise-map-head { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; flex-wrap: wrap; margin-bottom: 1rem; }
.exercise-map-head h2 { font-size: 1.05rem; font-weight: 500; margin: 0; }
.exercise-map-total { font-size: .85rem; color: var(--color-text-secondary, #666); }
.exercise-map-part { margin-bottom: 1.25rem; }
.exercise-map-part h3 { font-size: .92rem; font-weight: 500; margin: 0 0 .5rem; }
.exercise-map-part-meta { font-size: .78rem; color: var(--color-text-secondary, #666); margin-left: .5rem; font-weight: 400; }
.exercise-map-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr)); gap: .5rem; }
.exercise-map-cell {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: .5rem;
  border: 1px solid var(--color-border-tertiary, rgba(0,0,0,.15));
  border-radius: 8px;
  padding: .5rem .7rem;
  font-size: .85rem;
  text-decoration: none;
  color: inherit;
}
.exercise-map-cell:hover { background: var(--color-background-secondary, #f6f6f6); }
.exercise-map-dots { letter-spacing: .12em; font-size: .9rem; }

@media (max-width: 40rem) {
  .exercise-editor { min-height: 9rem; font-size: .82rem; }
  .exercise-map-grid { grid-template-columns: repeat(2, 1fr); }
  .exercise-summary { flex-direction: column; gap: .25rem; }
}
```

- [ ] **Step 2: 写 UI 模块**

`assets/exercise-ui.js`：

```javascript
/* Chapter exercise panel.
   The panel is injected after the chapter pager instead of being written into
   the chapter HTML: build-content.py rejects interactive tags in chapter
   source (G1), so every control here is created by script. */
(() => {
  'use strict';
  const $ = selector => document.querySelector(selector);
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined && text !== null) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const data = window.EXERCISE_DATA;
  const t = window.MSI18N ? window.MSI18N.t : (key => key);
  const Grader = window.ExerciseGrader;
  const Sandbox = window.ExerciseSandbox;
  const store = window.ExerciseStore ? window.ExerciseStore.create({}) : null;
  const sandbox = Sandbox ? Sandbox.create({}) : null;

  let panel = null;
  let chapterId = '';
  let mounted = false;

  const ANSWER_LABELS = { pass: 'exercise.selfPass', partial: 'exercise.selfPartial', fail: 'exercise.selfFail' };

  function localizedItems(exercise) {
    const chapter = data.chapters[chapterId];
    if (!chapter) return [];
    const list = chapter.exercises[window.MSI18N ? window.MSI18N.lang : 'zh'] || chapter.exercises.zh || [];
    return list;
  }

  async function tryLlmGrade(exercise, code) {
    if (!exercise.llm_rubric || exercise.llm_rubric.enabled !== true) return null;
    if (!exercise.llm_rubric.criteria) return null;
    try {
      const response = await fetch('/api/exercises/grade', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ exercise: exercise.id, answer: code, criteria: exercise.llm_rubric.criteria }),
      });
      if (!response.ok) return null;
      const data = await response.json();
      return typeof data.score === 'number' ? data : null;
    } catch { return null; }
  }

  async function syncProgress(rows) {
    if (!rows || !rows.length) return;
    try {
      const session = await (await fetch('/api/session', { credentials: 'same-origin' })).json();
      if (!session || !session.user) return;
      await fetch('/api/exercises/progress', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrf },
        body: JSON.stringify({ items: rows }),
      });
    } catch { /* reading must never depend on sync */ }
  }

  function renderChecks(items) {
    const list = el('ul', null, 'exercise-checks');
    for (const item of items) {
      const row = el('li', null, null);
      row.dataset.ok = String(item.ok);
      const mark = item.ok ? '✓' : '✗';
      row.append(el('span', `${mark} ${item.detail || item.kind}`));
      list.append(row);
    }
    return list;
  }

  function renderSolution(exercise, host) {
    const details = el('details', null, 'exercise-solution');
    details.append(el('summary', t('exercise.solution')));
    if (exercise.reference) details.append(el('pre', exercise.reference));
    if (exercise.explanation) details.append(el('p', exercise.explanation));
    host.append(details);
  }

  function buildSandboxExercise(exercise, host) {
    const editor = document.createElement('textarea');
    editor.className = 'exercise-editor';
    editor.spellcheck = false;
    editor.value = exercise.starter || '';
    const previous = store && store.read(chapterId, exercise.id);
    if (previous && previous.code) editor.value = previous.code;

    const actions = el('div', null, 'exercise-actions');
    const run = el('button', t('exercise.run'));
    run.type = 'button';
    run.dataset.role = 'run';
    const reset = el('button', t('exercise.reset'));
    reset.type = 'button';
    actions.append(run, reset);

    const status = el('p', null, 'exercise-status');
    status.setAttribute('role', 'status');
    const output = el('div');

    host.append(editor, actions, status, output);

    reset.addEventListener('click', () => {
      editor.value = exercise.starter || '';
      status.textContent = '';
      status.dataset.tone = '';
      output.replaceChildren();
    });

    run.addEventListener('click', async () => {
      run.disabled = true;
      reset.disabled = true;
      output.replaceChildren();
      status.dataset.tone = '';
      status.textContent = t('exercise.loading');
      try {
        const result = await sandbox.run({ code: editor.value, checks: exercise.checks || [] });
        // Align outcomes by index: the worker returns one slot per check, in
        // the same order. Never reorder or filter them.
        const outcomes = (exercise.checks || []).map((check, index) => {
          const produced = result.outcomes[index];
          return produced || { ok: false, detail: result.ok ? 'not evaluated' : 'code did not run' };
        });
        const llm = await tryLlmGrade(exercise, editor.value);
        const verdict = Grader.grade(exercise, { outcomes });
        if (store) store.write(chapterId, exercise.id, {
          passed: verdict.passed, score: verdict.score, code: editor.value, selfAssessed: '',
        });
        const record = store && store.read(chapterId, exercise.id);
        syncProgress(record ? [{
          chapter: chapterId, exercise: exercise.id, passed: record.passed ? 1 : 0,
          score: record.score, code: record.code, selfAssessed: record.selfAssessed,
          attempts: record.attempts, updated: record.updated,
        }] : []);
        status.dataset.tone = verdict.passed ? 'pass' : '';
        const percent = Math.round(verdict.score * 100);
        status.textContent = result.error && !result.ok
          ? String(result.error).split('\n').slice(-1)[0]
          : `${t('exercise.score', { percent })} · ${t('exercise.elapsed', { ms: Math.round(result.ms) })}`;
        output.append(renderChecks(outcomes));
        if (llm && llm.feedback) output.append(el('p', llm.feedback, 'exercise-solution'));
        renderSolution(exercise, output);
        updateCardState(exercise.id, verdict.passed ? 'passed' : 'todo');
      } catch (error) {
        status.dataset.tone = 'error';
        status.textContent = t('exercise.sandboxFailed');
      } finally {
        run.disabled = false;
        reset.disabled = false;
      }
    });
  }

  function buildChoiceExercise(exercise, host) {
    const field = document.createElement('fieldset');
    field.className = 'exercise-choices';
    const check = (exercise.checks || []).find(item => item.kind === 'output_choice');
    const options = check && Array.isArray(check.correct) ? check.correct : [];
    options.forEach(letter => {
      const label = el('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = letter;
      label.append(input, el('span', `${letter}. ${t('exercise.optionPlaceholder')}`));
      field.append(label);
    });
    const actions = el('div', null, 'exercise-actions');
    const submit = el('button', t('exercise.submit'));
    submit.type = 'button';
    const status = el('p', null, 'exercise-status');
    status.setAttribute('role', 'status');
    actions.append(submit);
    host.append(field, actions, status);
    submit.addEventListener('click', () => {
      const chosen = [...field.querySelectorAll('input')].filter(node => node.checked).map(node => node.value).sort();
      const expected = options.slice().sort();
      const ok = chosen.length === expected.length && chosen.every((value, index) => value === expected[index]);
      const verdict = Grader.grade(exercise, { outcomes: [ok] });
      if (store) store.write(chapterId, exercise.id, { passed: verdict.passed, score: verdict.score });
      const record = store && store.read(chapterId, exercise.id);
      syncProgress(record ? [{
        chapter: chapterId, exercise: exercise.id, passed: record.passed ? 1 : 0,
        score: record.score, attempts: record.attempts, updated: record.updated,
      }] : []);
      status.dataset.tone = verdict.passed ? 'pass' : '';
      status.textContent = verdict.passed ? t('exercise.correct') : t('exercise.incorrect');
      updateCardState(exercise.id, verdict.passed ? 'passed' : 'todo');
    });
  }

  function buildReflectExercise(exercise, host) {
    const area = document.createElement('textarea');
    area.className = 'exercise-editor';
    area.spellcheck = false;
    area.placeholder = t('exercise.reflectPlaceholder');
    const previous = store && store.read(chapterId, exercise.id);
    if (previous && previous.code) area.value = previous.code;

    const actions = el('div', null, 'exercise-actions');
    const status = el('p', null, 'exercise-status');
    status.setAttribute('role', 'status');
    for (const choice of ['pass', 'partial', 'fail']) {
      const button = el('button', t(ANSWER_LABELS[choice]));
      button.type = 'button';
      button.addEventListener('click', async () => {
        if (store) store.write(chapterId, exercise.id, { code: area.value, selfAssessed: choice });
        syncProgress(store ? [{ ...store.read(chapterId, exercise.id), chapter: chapterId, exercise: exercise.id, passed: 0, score: 0, selfAssessed: choice }] : []);
        status.textContent = t('exercise.selfRecorded');
        updateCardState(exercise.id, choice === 'fail' ? 'todo' : 'self');
      });
      actions.append(button);
    }
    const solution = el('div');
    renderSolution(exercise, solution);
    host.append(area, actions, status, solution);
  }

  function buildCard(exercise, index) {
    const card = el('article', null, 'exercise-card');
    card.dataset.exercise = exercise.id;
    const toggle = el('button', null, 'exercise-toggle');
    toggle.type = 'button';
    const title = el('span', `${index + 1}. ${exercise.objective}`, 'exercise-toggle-title');
    const state = el('span', t('exercise.stateTodo'), 'exercise-state');
    toggle.append(title, state);
    const meta = el('span', `${exercise.difficulty} · ${exercise.minutes} min`, 'exercise-toggle-meta');
    toggle.append(meta);
    const body = el('div', null, 'exercise-body');
    body.hidden = true;
    body.append(el('p', exercise.prompt, 'exercise-prompt'));
    card.append(toggle, body);
    toggle.addEventListener('click', () => {
      body.hidden = !body.hidden;
      if (!body.hidden && !body.dataset.filled) {
        body.dataset.filled = '1';
        body.append(el('p', exercise.objective, 'exercise-objective'));
        if (exercise.type === 'reflect') buildReflectExercise(exercise, body);
        else if (exercise.type === 'predict') buildChoiceExercise(exercise, body);
        else buildSandboxExercise(exercise, body);
      }
    });
    updateCardState(exercise.id, null, state);
    return card;
  }

  function updateCardState(exerciseId, forced, node) {
    const card = panel && panel.querySelector(`.exercise-card[data-exercise="${exerciseId}"]`);
    if (!card) return;
    const badge = node || card.querySelector('.exercise-state');
    if (!badge) return;
    const record = store ? store.read(chapterId, exerciseId) : null;
    const state = forced || (record && record.passed ? 'passed' : record && record.selfAssessed && record.selfAssessed !== 'fail' ? 'self' : 'todo');
    badge.dataset.state = state;
    badge.textContent = state === 'passed' ? t('exercise.statePassed')
      : state === 'self' ? t('exercise.stateSelf')
        : t('exercise.stateTodo');
  }

  function refreshHeader() {
    if (!panel) return;
    const items = localizedItems({});
    const summary = store ? store.chapterSummary(chapterId, items.map(item => item.id)) : { total: items.length, passed: 0 };
    const node = panel.querySelector('.exercise-count');
    if (node) node.textContent = t('exercise.headerCount', { total: summary.total, passed: summary.passed });
  }

  function render(currentChapterId) {
    if (!data || !data.chapters) return;
    chapterId = currentChapterId;
    const pager = $('.chapter-pager');
    if (!pager) return;
    if (!mounted) {
      panel = el('section', null, 'exercise-panel');
      panel.id = 'exercisePanel';
      panel.setAttribute('aria-label', t('a11y.exercisePanel'));
      const summary = el('div', null, 'exercise-summary');
      summary.append(el('h2', t('exercise.title')), el('span', '', 'exercise-count'));
      panel.append(summary);
      pager.after(panel);
      mounted = true;
    }
    panel.replaceChildren();
    const summary = el('div', null, 'exercise-summary');
    const items = localizedItems({});
    const chapter = store ? store.chapterSummary(chapterId, items.map(item => item.id)) : { total: items.length, passed: 0 };
    summary.append(el('h2', t('exercise.title')), el('span', t('exercise.headerCount', { total: chapter.total, passed: chapter.passed }), 'exercise-count'));
    panel.append(summary);
    if (!items.length) { panel.replaceChildren(); return; }
    items.forEach((exercise, index) => panel.append(buildCard(exercise, index)));
  }

  function init() {
    if (!data || !data.chapters || !Grader || !store) return;
    window.addEventListener('hashchange', () => {
      const match = /^#chapter-(\d+)/.exec(location.hash);
      if (match && panel && panel.offsetParent !== null) render(`chapter-${match[1]}`);
    });
    if (window.MSI18N && window.MSI18N.on) {
      window.MSI18N.on(() => {
        if (panel && panel.offsetParent !== null) {
          const match = /^#chapter-(\d+)/.exec(location.hash);
          if (match) render(`chapter-${match[1]}`);
        }
      });
    }
  }

  window.ExerciseUI = { init, render, chapterId: () => chapterId, refreshHeader };
  init();
})();
```

**实现注记**：`exercise.type === 'fill'` 目前走 `buildSandboxExercise`（当作短填空处理，判分用 `stdout_equals`）。若某章的 `fill` 题需要专门的单输入框 UI，在 `buildCard` 的分派里加一个 `buildFillExercise` 分支即可 —— 现有 34 章设计中 `fill` 只用在第 05/06 章的评测指标选择，形态上按 `predict` 处理更合适。

- [ ] **Step 3: 提交**

```bash
git add assets/exercise-ui.js assets/exercise.css
git commit -m "feat: add chapter exercise panel UI"
```

---

## Task 9: 学习地图（`#practice` 视图）

**Files:**
- Create: `assets/exercise-map.js`
- Create: `scripts/test-exercise-map.cjs`
- Modify: `index.html` practice 段
- Modify: `assets/paper.js:108,422`

**Interfaces:**
- Consumes: `window.EXERCISE_DATA`、`window.ExerciseStore`、`window.MSI18N.t`
- Produces: `ExerciseMap.render()`、`ExerciseMap.aggregate(data, store, parts, bookChapters)`（纯函数，Node 可测）
- **合并而非替换**：现有 `#sceneGrid` 场景卡片保留（`index.html:63` 附近），学习地图插在它**之前**

- [ ] **Step 1: 写失败的测试**

`scripts/test-exercise-map.cjs`：

```javascript
'use strict';
const assert = require('node:assert/strict');
const { aggregate } = require('../assets/exercise-map.js');

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok  ${name}`); }
  catch (error) { failures += 1; console.error(`  FAIL ${name}\n       ${error.message}`); }
}

const DATA = {
  chapters: {
    'chapter-1': { chapter: 'chapter-1', number: 1, partIndex: 0, count: 2, exercises: { zh: [{ id: 'ch01-ex01' }, { id: 'ch01-ex02' }] } },
    'chapter-7': { chapter: 'chapter-7', number: 7, partIndex: 2, count: 1, exercises: { zh: [{ id: 'ch07-ex01' }] } },
  },
};
const PARTS = [{ title: '第一篇' }, { title: '第二篇' }, { title: '第三篇' }];
const BOOK = new Map([['chapter-1', { title: '认识模型' }], ['chapter-7', { title: '第一个结果' }]]);

function fakeStore(records) {
  return {
    read: (chapterId, id) => records[`${chapterId}/${id}`] || null,
    chapterSummary: (chapterId, ids) => {
      let passed = 0; let selfAssessed = 0;
      for (const id of ids) {
        const record = records[`${chapterId}/${id}`];
        if (!record) continue;
        if (record.passed) passed += 1;
        else if (record.selfAssessed && record.selfAssessed !== 'fail') selfAssessed += 1;
      }
      return { total: ids.length, passed, selfAssessed };
    },
  };
}

console.log('ExerciseMap.aggregate');

check('groups chapters under their part in book order', () => {
  const rows = aggregate(DATA, fakeStore({}), PARTS, BOOK);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].partTitle, '第一篇');
  assert.equal(rows[2].partTitle, '第三篇');
  assert.equal(rows[2].chapters.length, 1);
});

check('omits parts that have no exercises', () => {
  const rows = aggregate(DATA, fakeStore({}), PARTS, BOOK);
  assert.equal(rows.find(row => row.partTitle === '第二篇'), undefined);
});

check('counts total exercises across the book', () => {
  const rows = aggregate(DATA, fakeStore({}), PARTS, BOOK);
  assert.equal(rows.reduce((sum, row) => sum + row.total, 0), 3);
});

check('marks a passed exercise', () => {
  const rows = aggregate(DATA, fakeStore({ 'chapter-1/ch01-ex01': { passed: true } }), PARTS, BOOK);
  assert.equal(rows[0].chapters[0].states[0], 'passed');
});

check('marks a self-assessed exercise distinctly from a pass', () => {
  const rows = aggregate(DATA, fakeStore({ 'chapter-1/ch01-ex01': { selfAssessed: 'partial' } }), PARTS, BOOK);
  assert.equal(rows[0].chapters[0].states[0], 'self');
});

check('marks an untouched exercise as todo', () => {
  const rows = aggregate(DATA, fakeStore({}), PARTS, BOOK);
  assert.deepEqual(rows[0].chapters[0].states, ['todo', 'todo']);
});

check('tolerates a chapter missing from the book index', () => {
  const rows = aggregate(DATA, fakeStore({}), PARTS, new Map());
  assert.equal(rows[0].chapters[0].title, 'chapter-1');
});

if (failures) {
  console.error(`\n${failures} failing`);
  process.exit(1);
}
console.log('\nPASS: exercise map aggregation');
```

- [ ] **Step 2: 运行测试确认失败**

```bash
node scripts/test-exercise-map.cjs
```

Expected: `Cannot find module '../assets/exercise-map.js'`。

- [ ] **Step 3: 实现聚合与渲染**

`assets/exercise-map.js`：

```javascript
/* Learning map for the practice view.
   aggregate() is pure so the grid can be verified without a browser;
   render() only paints what aggregate() returns. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ExerciseMap = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function aggregate(data, store, parts, bookChapters) {
    const chapters = (data && data.chapters) || {};
    const grouped = new Map();
    for (const chapterId of Object.keys(chapters)) {
      const chapter = chapters[chapterId];
      const index = Number.isInteger(chapter.partIndex) ? chapter.partIndex : 0;
      if (!grouped.has(index)) grouped.set(index, []);
      grouped.get(index).push(chapter);
    }
    const rows = [];
    for (const index of Array.from(grouped.keys()).sort((a, b) => a - b)) {
      const part = (parts || [])[index] || {};
      const entries = grouped.get(index)
        .sort((a, b) => a.number - b.number)
        .map(chapter => {
          const ids = ((chapter.exercises || {}).zh || []).map(item => item.id);
          // States come from store.read, not from chapterSummary: the summary
          // only carries counts, and a per-exercise view needs each record.
          const states = ids.map(id => {
            if (!store || typeof store.read !== 'function') return 'todo';
            const record = store.read(chapter.chapter, id);
            if (!record) return 'todo';
            if (record.passed) return 'passed';
            if (record.selfAssessed && record.selfAssessed !== 'fail') return 'self';
            return 'todo';
          });
          const summary = store && typeof store.chapterSummary === 'function'
            ? store.chapterSummary(chapter.chapter, ids)
            : { total: ids.length, passed: 0 };
          const book = bookChapters && bookChapters.get ? bookChapters.get(chapter.chapter) : null;
          return {
            chapter: chapter.chapter,
            number: chapter.number,
            title: book && book.title ? book.title : chapter.chapter,
            total: ids.length,
            passed: summary.passed || 0,
            states,
          };
        });
      rows.push({
        partIndex: index,
        partTitle: part.title || `Part ${index + 1}`,
        total: entries.reduce((sum, entry) => sum + entry.total, 0),
        passed: entries.reduce((sum, entry) => sum + entry.passed, 0),
        chapters: entries,
      });
    }
    return rows;
  }

  const GLYPH = { passed: '✓', self: '~', todo: '○' };

  function render() {
    const host = document.getElementById('exerciseMap');
    if (!host) return;
    const data = window.EXERCISE_DATA;
    const store = window.ExerciseStore ? window.ExerciseStore.create({}) : null;
    if (!data || !store) { host.replaceChildren(); return; }
    const bookData = window.BOOK_DATA || { chapters: [] };
    const bookChapters = new Map((bookData.chapters || []).map(chapter => [chapter.id, chapter]));
    const t = window.MSI18N ? window.MSI18N.t : (key => key);
    const rows = aggregate(data, store, bookData.parts || [], bookChapters);
    host.replaceChildren();
    if (!rows.length) return;
    const section = document.createElement('section');
    section.className = 'exercise-map container';
    const head = document.createElement('div');
    head.className = 'exercise-map-head';
    const heading = document.createElement('h2');
    heading.textContent = t('exercise.mapTitle');
    const total = rows.reduce((sum, row) => sum + row.total, 0);
    const passed = rows.reduce((sum, row) => sum + row.passed, 0);
    const summary = document.createElement('span');
    summary.className = 'exercise-map-total';
    summary.textContent = t('exercise.mapTotal', { passed, total });
    head.append(heading, summary);
    section.append(head);
    for (const row of rows) {
      const block = document.createElement('div');
      block.className = 'exercise-map-part';
      const title = document.createElement('h3');
      title.textContent = row.partTitle;
      const meta = document.createElement('span');
      meta.className = 'exercise-map-part-meta';
      meta.textContent = `${row.passed}/${row.total}`;
      title.append(meta);
      const grid = document.createElement('div');
      grid.className = 'exercise-map-grid';
      for (const entry of row.chapters) {
        const cell = document.createElement('a');
        cell.className = 'exercise-map-cell';
        cell.href = `#${entry.chapter}`;
        const label = document.createElement('span');
        label.textContent = `${String(entry.number).padStart(2, '0')} · ${entry.title}`;
        const dots = document.createElement('span');
        dots.className = 'exercise-map-dots';
        dots.textContent = entry.states.map(state => GLYPH[state] || GLYPH.todo).join('');
        cell.append(label, dots);
        grid.append(cell);
      }
      block.append(title, grid);
      section.append(block);
    }
    host.append(section);
  }

  return { aggregate, render };
});
```

- [ ] **Step 4: 运行测试确认通过**

```bash
node scripts/test-exercise-map.cjs
```

Expected: 全部 `ok`，末行 `PASS: exercise map aggregation`。

- [ ] **Step 5: 加容器与调用**

`index.html` 的 `<main data-page="practice">` 中，把

```html
<section class="page-banner"><div class="container"><h1 data-i18n="practice.title">从一个真实任务开始</h1><p data-i18n="practice.subtitle">把模型能力，放进你关心的应用场景。</p></div></section><div class="scene-grid container" id="sceneGrid"></div>
```

改为

```html
<section class="page-banner"><div class="container"><h1 data-i18n="practice.title">从一个真实任务开始</h1><p data-i18n="practice.subtitle">把模型能力，放进你关心的应用场景。</p></div></section><div id="exerciseMap"></div><div class="scene-grid container" id="sceneGrid"></div>
```

`assets/paper.js:108`：

```javascript
  renderProjectLinks(); renderHomePaths(); renderScenes();
```

改为

```javascript
  renderProjectLinks(); renderHomePaths(); renderScenes(); renderExerciseMap();
```

并在 `renderScenes` 函数定义之后（约 106 行后）加入：

```javascript
  function renderExerciseMap() { if (window.ExerciseMap) window.ExerciseMap.render(); }
```

`assets/paper.js:422`（`window.MSI18N.on` 回调）：

```javascript
    renderProjectLinks();renderHomePaths();renderScenes();buildChapterNav();renderIndex();
```

改为

```javascript
    renderProjectLinks();renderHomePaths();renderScenes();renderExerciseMap();buildChapterNav();renderIndex();
```

**注意**：`assets/exercise-map.js` 必须在 `assets/paper.js` **之前**加载（`paper.js` 启动时就要调用 `renderExerciseMap()`）。

- [ ] **Step 6: 提交**

```bash
git add assets/exercise-map.js scripts/test-exercise-map.cjs index.html assets/paper.js
git commit -m "feat: add learning map to the practice view"
```

---

## Task 10: 接线与资源指纹

**Files:**
- Modify: `index.html:132-134`（script 标签）
- Modify: `scripts/check-site.mjs:50,55`（CSS 校验 + 数据断言）
- Run: `node scripts/version-assets.mjs`

**Interfaces:**
- Consumes: Task 4/5/6/8/9 的产物
- Produces: 页面能实际加载练习功能

- [ ] **Step 1: 加 script 与 css 标签**

`index.html:133`（`paper.js` 那一行所在行）之前插入：

```html
<script src="assets/exercises.js"></script><script src="assets/exercise-grader.js"></script><script src="assets/exercise-store.js"></script><script src="assets/exercise-sandbox.js"></script><script src="assets/exercise-map.js"></script><script src="assets/exercise-ui.js"></script>
```

`index.html:12`（`reader-tools.css` 那行）之后插入：

```html
  <link rel="stylesheet" href="assets/exercise.css">
```

**加载顺序要求**：`exercises.js` → `exercise-grader.js` → `exercise-store.js` → `exercise-sandbox.js` → `exercise-map.js` → `exercise-ui.js` →（然后才是 `paper.js`）。顺序错了会在启动时报 `ExerciseGrader is not defined`。

**Pyodide 不在这里出现（G9）。** 它只在 `assets/exercise-worker.js` 里被 `importScripts`，且只在用户点「运行」时触发。

- [ ] **Step 2: 刷新缓存指纹**

```bash
node scripts/version-assets.mjs
```

Expected: 无输出（静默写入）。`index.html` 中新增的 `?v=` 会被填充。

- [ ] **Step 3: 扩展 check-site**

`scripts/check-site.mjs:50`：

```javascript
for(const css of ['assets/styles.css','assets/paper.css','assets/review.css','assets/reader-tools.css']){
```

改为

```javascript
for(const css of ['assets/styles.css','assets/paper.css','assets/review.css','assets/reader-tools.css','assets/exercise.css']){
```

在 `console.log(...)` 之前追加断言：

```javascript
const exerciseContext={window:{}};
vm.runInNewContext(read('assets/exercises.js'),exerciseContext);
const exercises=exerciseContext.window.EXERCISE_DATA;
const chapterIds=new Set(exercises.chapters?Object.keys(exercises.chapters):[]);
for(const chapterId of chapterIds)assert(ids.has(chapterId),'Exercise chapter is not in the book: '+chapterId);
const seenExercises=new Set();
for(const [chapterId,chapter] of Object.entries(exercises.chapters)){
  const counts=new Set();
  for(const lang of exercises.languages){
    const list=chapter.exercises[lang]||[];
    counts.add(list.length);
    for(const item of list){
      assert(!seenExercises.has(item.id),'Duplicate exercise id '+item.id);
      seenExercises.add(item.id);
      assert(item.chapter===chapterId,item.id+' points at the wrong chapter');
      assert(item.objective&&item.prompt&&item.explanation,item.id+' is missing required prose');
      assert(['code','predict','fill','build','reflect'].includes(item.type),item.id+' has an unknown type');
    }
  }
  assert(counts.size===1,chapterId+' language counts diverge');
}
assert(exercises.exerciseCount===seenExercises.size,'exerciseCount does not match the corpus');
const sandboxScript=read('assets/exercise-sandbox.js');
const workerScript=read('assets/exercise-worker.js');
assert(!/<script[^>]*pyodide/i.test(read('index.html')),'Pyodide must stay out of index.html');
assert(workerScript.includes("importScripts('./vendor/pyodide/pyodide.js')"),'Worker must import the vendored Pyodide');
assert(sandboxScript.includes('assets/exercise-worker.js'),'Sandbox must default to the bundled worker');
```

- [ ] **Step 4: 校验通过**

```bash
node scripts/build-content.mjs --check
python3 scripts/build-i18n.py --check
node scripts/check-site.mjs
```

Expected: 三个脚本全部 Verified/PASS。`check-site.mjs` 末行应显示练习计数。

- [ ] **Step 5: 提交**

```bash
git add index.html scripts/check-site.mjs
git commit -m "feat: wire the exercise modules into the page and extend site checks"
```

---

## Task 11: locale 词条

**Files:**
- Modify: `assets/locale/zh.js`、`en.js`、`es.js`

**Interfaces:**
- Consumes: `assets/exercise-ui.js`、`assets/exercise-map.js` 的 `t()` 调用
- Produces: 三份 key 集合完全一致的词条（Task 1 的 `test_locale_key_parity` 依赖）

**新增 key 清单（必须三份齐备）**

```
a11y.exercisePanel
exercise.title
exercise.headerCount
exercise.run
exercise.reset
exercise.submit
exercise.solution
exercise.score
exercise.elapsed
exercise.stateTodo
exercise.statePassed
exercise.stateSelf
exercise.selfPass
exercise.selfPartial
exercise.selfFail
exercise.selfRecorded
exercise.reflectPlaceholder
exercise.optionPlaceholder
exercise.loading
exercise.sandboxFailed
exercise.correct
exercise.incorrect
exercise.mapTitle
exercise.mapTotal
```

- [ ] **Step 1: 加中文词条**

在 `assets/locale/zh.js` 的词条对象中追加：

```javascript
  'a11y.exercisePanel': '本章练习',
  'exercise.title': '动手练一练',
  'exercise.headerCount': '共 {total} 题 · 已通过 {passed}',
  'exercise.run': '运行',
  'exercise.reset': '重置',
  'exercise.submit': '提交',
  'exercise.solution': '查看参考答案与解析',
  'exercise.score': '通过率 {percent}%',
  'exercise.elapsed': '用时 {ms} 毫秒',
  'exercise.stateTodo': '未完成',
  'exercise.statePassed': '已通过',
  'exercise.stateSelf': '自评通过',
  'exercise.selfPass': '我答对了',
  'exercise.selfPartial': '部分对',
  'exercise.selfFail': '没答出',
  'exercise.selfRecorded': '已记录你的自评，学习地图已更新。',
  'exercise.reflectPlaceholder': '写下你的判断和理由…',
  'exercise.optionPlaceholder': '（本题选项见题干）',
  'exercise.loading': '正在加载运行环境，首次约 15MB，请稍候…',
  'exercise.sandboxFailed': '运行环境异常，请刷新页面重试。阅读不受影响。',
  'exercise.correct': '回答正确。',
  'exercise.incorrect': '还差一点，再想想。',
  'exercise.mapTitle': '学习地图',
  'exercise.mapTotal': '已通过 {passed} / {total} 题',
```

- [ ] **Step 2: 加英文词条**

在 `assets/locale/en.js` 中追加同样 25 个 key：

```javascript
  'a11y.exercisePanel': 'Exercises for this chapter',
  'exercise.title': 'Try it yourself',
  'exercise.headerCount': '{total} exercises · {passed} passed',
  'exercise.run': 'Run',
  'exercise.reset': 'Reset',
  'exercise.submit': 'Submit',
  'exercise.solution': 'Show the reference answer and explanation',
  'exercise.score': 'Score {percent}%',
  'exercise.elapsed': '{ms} ms',
  'exercise.stateTodo': 'Not started',
  'exercise.statePassed': 'Passed',
  'exercise.stateSelf': 'Self-assessed',
  'exercise.selfPass': 'I got it right',
  'exercise.selfPartial': 'Partly right',
  'exercise.selfFail': 'Not yet',
  'exercise.selfRecorded': 'Your self-assessment is recorded and the map is updated.',
  'exercise.reflectPlaceholder': 'Write your reasoning…',
  'exercise.optionPlaceholder': '(options are listed in the prompt)',
  'exercise.loading': 'Loading the runtime, about 15MB on first use…',
  'exercise.sandboxFailed': 'The runtime hit an error. Refresh to retry — reading is unaffected.',
  'exercise.correct': 'Correct.',
  'exercise.incorrect': 'Not quite. Try again.',
  'exercise.mapTitle': 'Learning map',
  'exercise.mapTotal': '{passed} / {total} exercises passed',
```

- [ ] **Step 3: 加西班牙语词条**

在 `assets/locale/es.js` 中追加：

```javascript
  'a11y.exercisePanel': 'Ejercicios de este capítulo',
  'exercise.title': 'Practicá',
  'exercise.headerCount': '{total} ejercicios · {passed} aprobados',
  'exercise.run': 'Ejecutar',
  'exercise.reset': 'Reiniciar',
  'exercise.submit': 'Enviar',
  'exercise.solution': 'Ver la respuesta de referencia y la explicación',
  'exercise.score': 'Puntuación {percent} %',
  'exercise.elapsed': '{ms} ms',
  'exercise.stateTodo': 'Sin empezar',
  'exercise.statePassed': 'Aprobado',
  'exercise.stateSelf': 'Autoevaluado',
  'exercise.selfPass': 'Lo acerté',
  'exercise.selfPartial': 'Parcialmente',
  'exercise.selfFail': 'Todavía no',
  'exercise.selfRecorded': 'Tu autoevaluación quedó registrada y el mapa se actualizó.',
  'exercise.reflectPlaceholder': 'Escribe tu razonamiento…',
  'exercise.optionPlaceholder': '(las opciones están en el enunciado)',
  'exercise.loading': 'Cargando el entorno, unos 15 MB la primera vez…',
  'exercise.sandboxFailed': 'El entorno falló. Recarga para reintentar; la lectura no se ve afectada.',
  'exercise.correct': 'Correcto.',
  'exercise.incorrect': 'Casi. Inténtalo de nuevo.',
  'exercise.mapTitle': 'Mapa de aprendizaje',
  'exercise.mapTotal': '{passed} / {total} ejercicios aprobados',
```

- [ ] **Step 4: 验证 key 齐备**

```bash
.venv/bin/python -m pytest tests/test_regression_baseline.py::test_locale_key_parity -v
node scripts/test-i18n.cjs
```

Expected: 均通过。

- [ ] **Step 5: 提交**

```bash
git add assets/locale/zh.js assets/locale/en.js assets/locale/es.js
git commit -m "feat: add exercise copy for zh, en and es"
```

---

## Task 12: CI 与文档

**Files:**
- Modify: `.github/workflows/deploy-modelscope.yml`
- Modify: `AUTH-AND-DISCUSSION.md`
- Modify: `README.md`、`README.zh-CN.md`

**Interfaces:**
- Consumes: 全部既有任务
- Produces: 合并保护 + 用户可见文档

- [ ] **Step 1: 扩展 CI**

`.github/workflows/deploy-modelscope.yml` 的 `paths:` 块中追加：

```yaml
      - 'scripts/build-exercises.py'
      - 'scripts/test_exercises.py'
      - 'scripts/vendor-pyodide.mjs'
      - 'scripts/test_pyodide_vendor.py'
      - 'scripts/test-exercise-grader.cjs'
      - 'scripts/test-exercise-store.cjs'
      - 'scripts/test-exercise-map.cjs'
      - 'content/exercises/**'
      - 'assets/exercise*'
      - 'assets/exercises.js'
      - 'assets/vendor/pyodide/**'
```

在 `Verify chapter data and local resources` 步骤之后追加：

```yaml
      - name: Verify exercise data
        run: |
          python3 scripts/build-exercises.py --check
          python3 scripts/test_exercises.py
          python3 scripts/test_pyodide_vendor.py
      - name: Verify exercise modules
        run: |
          node scripts/test-exercise-grader.cjs
          node scripts/test-exercise-store.cjs
          node scripts/test-exercise-map.cjs
```

`Verify reading community API` 步骤已运行 `pytest tests -q`，会自动覆盖 `tests/test_exercise_api.py`，**不要**再加一遍。

- [ ] **Step 2: 确认部署白名单**

```bash
grep -n "content\|assets" scripts/deploy-modelscope.mjs | head -20
```

`content/exercises/` 在 `content/` 下、`assets/vendor/pyodide/` 在 `assets/` 下，两者都应被自动包含。若发现显式文件列表不含 `assets`，需在 `scripts/deploy-modelscope.mjs:79` 的 `files` 数组中确认 `assets` 是目录级包含。

- [ ] **Step 3: 补 AUTH-AND-DISCUSSION.md**

在文件末尾追加：

```markdown
## 练习与进度数据

- 游客练习进度只存在浏览器本地存储（键名 `ms-cookbook.exercise.v1`），不上传。
- 登录后进度会同步到服务端 `.data/reading.sqlite3` 的 `exercise_progress` 表，用于跨设备继续学习。
- 同步只上传题目 id、是否通过、通过率、尝试次数和你写的代码。请不要在练习代码里写入生产密钥或个人信息。
- 练习代码在浏览器内的 Pyodide 沙箱中执行。Pyodide 默认没有网络访问、没有文件系统写入、没有子进程，因此练习无法安装第三方包，也无法访问你的本地文件。
- `EXERCISE_LLM_KEY` 与 `EXERCISE_LLM_BASE_URL` 均为可选项。未配置时，开放题只展示参考答案与自评，不做自动评分。
```

- [ ] **Step 4: 补 README**

`README.md` 的 `## Learning paths` 之后插入：

```markdown
## Hands-on exercises

Every chapter ships two to four exercises. Write code in the browser, run it in a Pyodide sandbox, and get per-check feedback right in the page. Progress is kept locally for guests and synced to your ModelScope account once you sign in, so it follows you across devices. The `#practice` view doubles as a learning map showing which chapters you have worked through.

Exercises that would need a GPU, a training cluster or an external API are written as reflection prompts instead: you write your reasoning, compare it with the reference answer, and self-assess. We would rather say a topic cannot run in a browser than ship a Run button that always fails.
```

`README.zh-CN.md` 的对应位置插入：

```markdown
## 动手练习

每章配套 2 到 4 道练习。在浏览器里写代码，用 Pyodide 沙箱直接运行，逐项给出通过/未通过反馈。游客进度存在本地，登录魔搭账号后自动同步，换设备也能接着做。`#practice` 视图同时是学习地图，一眼看清哪些章练过。

需要 GPU、训练集群或外部 API 的题目会写成思考题：你写下判断，对照参考答案自评。我们宁可明说某个主题在浏览器里跑不了，也不放一个注定失败的「运行」按钮。
```

- [ ] **Step 5: 提交**

```bash
git add .github/workflows/deploy-modelscope.yml AUTH-AND-DISCUSSION.md README.md README.zh-CN.md
git commit -m "docs: wire exercise verification into CI and document the feature"
```

---

## Task 13: 手工浏览器验证

自动化测试覆盖不到 Pyodide 下载、Worker 生命周期与 UI 交互。这一步必须手工做。

**Files:** 无改动，只有验证

**Interfaces:**
- Consumes: Task 1-12 全部产物
- Produces: 验证记录

- [ ] **Step 1: 启动服务**

```bash
cd D:/Coding/ms-cookbook
APP_BASE_URL=http://127.0.0.1:7860 .venv/bin/uvicorn app:app --host 127.0.0.1 --port 7860 --no-access-log
```

- [ ] **Step 2: 逐条验证（对照设计 §13.1）**

| # | 操作 | 期望 |
|---|---|---|
| 1 | 打开 `#chapter-7` | 出现「动手练一练」面板，3 道题 |
| 2 | 展开第 1 题，点「运行」 | 首次显示「正在加载运行环境…」，随后逐项出现 ✓/✗ |
| 3 | 把代码改成 `print('wrong')` | 第 1 项 ✗，通过率 <100%，未通过 |
| 4 | 填正确代码再跑 | 通过率 100%，徽章变「已通过」 |
| 5 | 刷新页面 | 徽章仍是「已通过」，代码保留 |
| 6 | 打开 `#chapter-13` 第 3 题（reflect） | **无「运行」按钮**，只有三个自评按钮 + 参考答案 |
| 7 | 点「我答对了」 | 徽章变「自评通过」，通过率不计入 |
| 8 | 打开 `#practice` | 场景卡片**仍在**，其上方出现学习地图 |
| 9 | 切换语言到 English | 练习题干变英文，学习地图标题变英文 |
| 10 | 切到 Español 再切回中文 | 数据无损，无控制台报错 |
| 11 | 断网后点「运行」 | 显示加载失败 + 重试，**正文与划线评论照常可用** |
| 12 | 缩窄到 375px | 面板单列，编辑器可用，按钮不遮挡 |
| 13 | 打开 DevTools Network | Pyodide 的 15MB 只在首次点「运行」时加载，刷新阅读页不再请求 |
| 14 | 登录魔搭账号，改进度，换浏览器登录 | 进度同步 |
| 15 | 点章节划线、留言、访问统计 | 全部照常工作，**无回归** |

- [ ] **Step 3: 记录问题并修复**

任何一项不符期望，记为 bug，**修复后重跑该步骤**，不要攒到最后。

---

## Task 14: 补齐剩余 32 章中文练习

**Files:**
- Create: `content/exercises/zh/chapter-01.json` … `chapter-06.json`、`chapter-08.json` … `chapter-12.json`、`chapter-14.json` … `chapter-23.json`、`chapter-25.json` … `chapter-32.json`、`chapter-34.json`、`chapter-35.json`（共 32 个）
- Modify: `content/exercises/manifest.json`（从 3 章展开到 34 章）
- Regenerate: `assets/exercises.js`

**Interfaces:**
- Consumes: Task 3 冻结的 schema
- Produces: 完整中文语料

**题量与形态按设计 §11.2**

| 篇 | 章号 | 每章题数 | 形态 |
|---|---|---|---|
| 1 认识开源模型 | 01–04 | 2 | `predict` / `reflect` |
| 2 从问题出发 | 05–06 | 2 | `predict` / `fill` |
| 3 跑得起 | 07★–11 | 3 | `code` |
| 4 微调与评测 | 12–15 | 3 | `code` |
| 5 业务系统实践 | 16–20 | 2 | `build` / `reflect` |
| 6 AIGC | 21–25 | 2 | `predict` / `reflect` |
| 7 Agent | 26–32 | 3 | `build` / `reflect` |
| 8 补充基础 | 34–35 | 2 | `code` |

★ 07 已完成。11、15、35 章需 `code`；chapter-24 不出现（G4）。

- [ ] **Step 1: 展开 manifest 为全部 34 章**

把 `content/exercises/manifest.json` 的 `chapters` 替换为 34 项。**除 `chapter-24` 外，`content/manifest.json` 中所有 `status == 'ready'` 的章都要列出**，`idPrefix` 严格为 `ch{两位章号}`：

```json
{
  "title": "ModelScope Cookbook 练习集",
  "version": 1,
  "languages": ["zh", "en", "es"],
  "packages": [],
  "chapters": [
    { "chapter": "chapter-1", "idPrefix": "ch01" },
    { "chapter": "chapter-2", "idPrefix": "ch02" },
    { "chapter": "chapter-3", "idPrefix": "ch03" },
    { "chapter": "chapter-4", "idPrefix": "ch04" },
    { "chapter": "chapter-5", "idPrefix": "ch05" },
    { "chapter": "chapter-6", "idPrefix": "ch06" },
    { "chapter": "chapter-7", "idPrefix": "ch07" },
    { "chapter": "chapter-8", "idPrefix": "ch08" },
    { "chapter": "chapter-9", "idPrefix": "ch09" },
    { "chapter": "chapter-10", "idPrefix": "ch10" },
    { "chapter": "chapter-11", "idPrefix": "ch11" },
    { "chapter": "chapter-12", "idPrefix": "ch12" },
    { "chapter": "chapter-13", "idPrefix": "ch13" },
    { "chapter": "chapter-14", "idPrefix": "ch14" },
    { "chapter": "chapter-15", "idPrefix": "ch15" },
    { "chapter": "chapter-16", "idPrefix": "ch16" },
    { "chapter": "chapter-17", "idPrefix": "ch17" },
    { "chapter": "chapter-18", "idPrefix": "ch18" },
    { "chapter": "chapter-19", "idPrefix": "ch19" },
    { "chapter": "chapter-20", "idPrefix": "ch20" },
    { "chapter": "chapter-21", "idPrefix": "ch21" },
    { "chapter": "chapter-22", "idPrefix": "ch22" },
    { "chapter": "chapter-23", "idPrefix": "ch23" },
    { "chapter": "chapter-25", "idPrefix": "ch25" },
    { "chapter": "chapter-26", "idPrefix": "ch26" },
    { "chapter": "chapter-27", "idPrefix": "ch27" },
    { "chapter": "chapter-28", "idPrefix": "ch28" },
    { "chapter": "chapter-29", "idPrefix": "ch29" },
    { "chapter": "chapter-30", "idPrefix": "ch30" },
    { "chapter": "chapter-31", "idPrefix": "ch31" },
    { "chapter": "chapter-32", "idPrefix": "ch32" },
    { "chapter": "chapter-33", "idPrefix": "ch33" },
    { "chapter": "chapter-34", "idPrefix": "ch34" },
    { "chapter": "chapter-35", "idPrefix": "ch35" }
  ]
}
```

展开 manifest 后、`scripts/test_exercises.py` 会因 32 章缺内容而失败 —— 这是预期的，它在等你填内容。

- [ ] **Step 2: 先建占位文件，让校验器能逐章推进**

```bash
cd D:/Coding/ms-cookbook
for n in 01 02 03 04 05 06 08 09 10 11 12 14 15 16 17 18 19 20 21 22 23 25 26 27 28 29 30 31 32 34 35; do
  for lang in zh en es; do printf '[]' > "content/exercises/$lang/chapter-$n.json"; done
done
```

- [ ] **Step 3: 逐章编写中文内容**

**写作规则（每条都对应校验器的具体断言）**

1. `id` 格式 `chNN-exMM`，`NN` 与章号一致（校验器断言 `id.startswith(f"ch{number:02d}-ex")`）
2. `objective` ≤ 60 字，一句话说清学什么（校验器断言长度）
3. `explanation` 必须能脱离正文独立看懂
4. 非 `reflect` 必须至少一个非 `self_assessed` 的 check（校验器断言 `graded` 非空）
5. `reflect` 必须有 `reference`，且**不能**带 graded check（校验器断言 `not graded`）
6. `code` / `build` 必须有 `starter`（校验器断言）
7. `checks[].weight` ≥ 1（校验器断言）
8. 所有 `assert_python` 的 `code` 必须能 `compile()`（校验器调用 `compile()`）
9. 所有 `stdout_matches` 的 `pattern` 必须能 `re.compile()`（校验器调用）
10. 沙箱内不用 `input()`、不读文件、不联网（Pyodide 无这些能力）
11. 不用需要第三方包的 import（未 vendor numpy 等）

**写作规则 12–18（来自 Task 3 的五轮评审，是这套 schema 真正难的地方）**

Task 3 的 3 章样板在评审中暴露了 7 类缺陷，且**全部通过了结构校验**（`scripts/test_exercises.py` 查不出来）。它们的共同根因是：**题目要求（A）、判分标准（B）、解析讲的重点（C）三者不对齐**。以下规则是为此立的。

12. **`reference` 必须能独立运行**（不依赖 `starter` 的上下文）。`scripts/check_exercise_references.py` 会在 standalone 失败时报错。两种写法都合法时，选 standalone。

13. **加 check 必须同时重配权重。** 否则会出现「加 check 却稀释了其他必答点」—— 这在 Task 3 实际发生过：M-2 补了一条 check 把总权重推到 13，导致「不做下划线转中划线」这个核心考点从 75%（判不过）变成 84.6%（**判过**）。

    先约定三个词，后两条判据全靠它们：

    - **必答点**：prompt 明确要求、漏掉就没算完成题目的那一条要求。
    - **守护 check**：**当这条必答点被漏掉时它会失败**的 check。是「会失败」，不是「提到过这个点」—— 一条只在别的点出错时才失败的 check 不算守护。
    - **总权重 `T`**：全部非 `self_assessed` check 的 `weight` 之和（判分器口径：非正权重按 1 计）。

    **P1（硬标准，必须满足）**：每条必答点单独被漏掉时 score 必须 < 0.8。设它的守护 check 权重之和为 `w`。

    **阈值分两套，取决于判分时 `llm` 分数是否真的参与了计算** —— 判分器不是纯确定性的：

    ```
    score = det × 0.7 + llm × 0.3            （LLM_WEIGHT = 0.3，见 assets/exercise-grader.js）
    ```

    判分器的 `usable` 条件是「`llm_rubric.enabled === true` **且** 调用方传了数字型的 `llm.score`」，两者缺一就走纯确定性分支。所以按 `llm_rubric.enabled` 选阈值是安全的取法（开着 rubric 就按开着算），但要知道真正决定分支的是两件事：

    - `llm_rubric.enabled = false`（或没有 rubric、或调用方没传 LLM 分）：`score = det`，于是 `1 - w/T < 0.8` → **`w / T > 0.2`**
    - `llm_rubric.enabled = true` 且 LLM 确实打了分：要保证**即使 LLM 给满分也判不过**，取最坏情况 `llm = 1`：

      ```
      0.7 × (1 - w/T) + 0.3 < 0.8
      1 - w/T              < (0.8 - 0.3) / 0.7 = 0.5 / 0.7 = 5/7 ≈ 0.714
      w/T                  > 1 - 5/7 = 2/7 ≈ 0.286
      ```

      即 **`w / T > 2/7 ≈ 0.286`**。

    常见错算：把前提写成「确定性分必须 < 0.8 × 0.7 = 0.56」，推出 `w/T > 0.44`。`0.8 × 0.7` 不是判分器里的任何一项；0.44 只是一个**过严的充分条件**，不是阈值本身。验算只用上面那两行。

    **P2（加强标准）**：**每条必答点至少被 2 条守护 check 守着。**

    判据只有这一条，**与必答点有几条无关**。早先那版「必答点 ≥ 3 的题必须满足 P2、≤ 2 的题豁免」把判据挂错了变量：3 个点每个只有 1 条守护时 P2 根本不可能满足（规则却写「必须」）；4 个点里 3 个满足时剩下那个仍然不满足（规则却写「豁免」）。写成「每个点 ≥ 2 条守护 check」就没有这种自相矛盾。

    达不到 P2 时（预算不够，或这一点的错误实现天然只触发一条 check）：退到 **P1 单条高权重守护**（`w/T` 超过上表阈值），并且**必须在 `explanation` 里写明判分边界**。诚实标注「这一点只有一条防线，它有多重」远好过假装满足。

    **范例（诚实版，`ch13-ex01`）**：7 条必答点里 6 条满足 P2 —— 五个键各有「逐键断言 + 五键联合断言」两条守护（各 3/13 = 23.1%），「下划线转中划线」有两条正则守着（6/13 = 46.2%）。第 7 条「五个 flag 都出现在渲染出来的命令行里」**只有一条守护**（那条全量 lookahead 正则，3/13 = 23.1%）：实测删掉它之后，「字典全对、但命令行漏掉 `--dataset`」的实现得 **10/10 = 100%**，判过。它满足 P1（23.1% > 0.2，因为这道题 `llm_rubric.enabled = false`），但同一个权重在 rubric 打开时会跌破 2/7，最坏情况 `0.7 × 0.769 + 0.3 = 0.838 > 0.8` —— 这就是规则必须写明前提的原因。

14. **每条题目明确要求的必答点，都必须有一条 check 覆盖它。** 典型反例（Task 3 第 2 轮发现，现已修好）：`ch33-ex02` 的 `explanation` 强调「除零保护不能省」，但当时没有一条 check 调 `metrics(0,0,0)` —— 删掉守卫的实现照样 100% 通过。**写规则时注意这类反例会随语料修复而失效**：现在那条 check 在，解析里「除零保护」这句话确实有兜底了。

15. **判分不能对合法写法过严。** 典型反例：`ch13-ex01` 的正则只接受 `--model value`，而 `--model=value`、`--model 'value'` 都是合法 CLI 语法，却判不过 —— **正确答案被判错**。写 `stdout_matches` 时要判断 flag 名与值是否存在，不要约束分隔符细节。

    **验证要求**：每道题都要试至少 2–3 种**等价但写法不同**的正确解法，全部必须判过。

16. **`stdout_matches` 的正则在 Python `re` 与 JS `RegExp` 下必须行为一致** —— harness 用 Python 判分，浏览器用 JS 判分，同一个 `pattern` 字符串喂给两个引擎。规则不是「小心一点」，而是一份**白名单 + 黑名单 + 验证脚本**：

    **允许（白名单）**

    - 字面量与转义：普通字符，以及转义后的元字符 `\.` `\/` `\-` `\$`
    - 字符类：`[...]`、`[^...]`、`[\s=]`、`[A-Za-z0-9]`、类内的 `\s \S`
    - 量词：`*` `+` `?` `{n}` `{n,m}`，含非贪婪形式 `*?` `+?` `??` `{n,m}?`
    - 锚点与分支：`|`、分组 `(...)`、`^`（两侧含义一致，都匹配串首）
    - **前瞻** `(?=...)`：用来表达「后面某处必须出现 X」，不必约束出现顺序
    - `\d` `\w` `\b` **仅当匹配对象确定是 ASCII 时**（见下）

    `$`（串尾）**不要用**：实测它并不满足「两侧含义一致」—— Python 的 `$` 额外匹配**末尾换行之前**的位置，JS 的 `$` 只匹配真正的串尾。`abc$` 对 `'abc\n'` 是 Python 命中、JS 不命中；`b$` 对 `'a\nb\n'` 同样分歧。需要「结尾」语义时用 `(?=\s*$)` 之类的显式写法，或干脆不用锚点。

    **禁止（黑名单，`scripts/check_regex_parity.py` 硬失败）**

    - 命名组 `(?<n>...)` / `(?P<n>...)`、后顾断言 `(?<=...)` `(?<!...)`
    - 内联标志 `(?i)` `(?m)` `(?s)`、原子组 `(?>...)`、占有量词 `*+` `++` `?+`、条件式 `(?(...)...)`
    - `\A` `\Z`（在 JS 里是字面量 A / Z）、`\p{...}`（Python 标准 `re` 不支持）

    黑名单里两条路径都必要，因为它们抓的不是同一类：`(?P<n>...)` 过不了**静态 lint**（脚本的正则只认 `(?<`），但过不了 **JS 编译**（`Invalid group`）—— 任何 `(?P` / `(?<` 命名组都会在后半段被硬失败拦下，写规则时不必区分这两者。

    **仍然要当心的**：`\d` `\w` `\s` 在 Python `re` 里默认按 Unicode 处理、在 JS `RegExp` 里只认 ASCII —— 所以 `\d` 只有在**上下文保证是 ASCII 数字**时才安全（全角数字会让两边给出相反答案）。也别用反向引用 `\1`：一旦因为增删分组而编号错位，错误会静默地变成「匹配到别的东西」。

    **验证方式**：写完每章跑 `python scripts/check_regex_parity.py`（**CI 的 `Verify exercise data` 步骤已在跑它**，所以漏写会在推送时暴露，不必记得手动执行）。它做两件事 —— 用上面的黑名单静态扫全部 `stdout_matches` 的 `pattern`；再把每个 `pattern` 交给 Python `re` 与 node 的 `RegExp` 各跑一批样本（该题 reference 的真实 stdout，外加一组对抗性样本：全角数字、`--flag=value` 写法、混合换行与制表符、残句……），两边结果必须逐条一致，任一不一致即退出码 1。**白名单不是免检区** —— 静态 lint 只查黑名单那一列，白名单里的构造仍要靠后半段的样本比对来证明两端一致。

17. **查表 / 硬编码答案的实现必须判不过。** 实测存在**把答案抄下来就拿 100%** 的实现：把 check 用到的输入点做成一张字典，`get` 不到就返回默认值。学员不理解题意、只背下 check 用的那几组输入就能过关，而输入点是可以从公开的语料里读出来的。

    Task 3 现状（**只有输入点「算出来」的题才算修好**）：`ch13-ex02` 与 `ch33-ex02` 已改成遍历生成的输入点，「把全部已知答案写进字典」的实现分别掉到 **72.7%** / **73.9%**，判不过；**`ch33-ex01` 仍未修** —— 它的 9 个输入点是逐个枚举的，照抄一张表实测仍是 **100%**。写新题时不要重复这个形状。

    写 check 时必须让「查表」不可行：

    - 一道题的 check 要覆盖**多个不同的输入点**，跨不同分支、跨不同量级 —— 只喂一组输入的实现等于送分；
    - 纯函数题最危险：输入点越少越容易被一张表覆盖。至少 3 个不同的调用点，其中至少 2 个落在不同分支上；
    - **输入点要「算出来」而不是「列出来」**：把逐个枚举的输入点写死，学员照样能再抄一遍一张表。有效的做法是让 check 自己生成输入点（如按 `range` 遍历总量 × 若干占比、或遍历生成的 `(correct, minor, wrong)` 组合），这样要覆盖就得复现题目的算法本身。Task 3 实测：`ch13-ex02` 遍历 1–24 × 4 档共 96 组、`ch33-ex02` 遍历 91 组生成组合，两题「把全部已知答案写进字典」的实现分别掉到 **72.7%** 与 **73.9%**，判不过；
    - 为此新增输入点之后，按第 13 条重配权重，别让「多喂几个输入」稀释掉别的必答点。

    边界要诚实：当前 UI 不展示 check 代码（`assets/app.js` 不引用 `checks`），但 `assets/exercises.js` 是公开静态资源，所以这条规则**提高抄答案的成本，而不是杜绝**。

18. **`explanation` 里每个具体主张都必须有对应 check 兜底；写不出 check 的主张就不该写进解析。** 反例有两层：`ch33-ex02` 的解析开篇断言「`round(x, 3)` 保证返回 0.7 而不是 0.7000000000000001」，但没有任何 check 区分 round 与不 round；**而且这个主张本身是错的** —— 实测 `14/20 == 0.7` 在二进制浮点下为 `True`，这三个比例 round 与不 round 完全一样，round 在这组数据上多余。`explanation` 不该教一个不成立的东西，也不该教一个学员改了却无法确认有没有用的东西。

    判据：

    - 主张是「某个输入必须得到某个结果」→ 必须有 check 跑那个输入（harness 断言 A 的机械半边）；
    - 主张是「某种写法判不过 / 判得过」→ 必须实跑过这种写法再写（`check_exercise_references.py` 只证明 reference 自己 100%，不证明某个错误实现会挂）；
    - 主张是 Python 或数值行为本身 → 先在解释器里验算再写，别凭印象。

    **本条与第 17 条分工不同，别混用**：第 17 条管的是「check 的输入点够不够多、是不是生成的」（防查表），本条与断言 A 管的是「`explanation` 的每个主张有没有对应的 check」（防解析与判分脱节）。一道题可以输入点很多却解析里写着一个没人验的主张，也可以解析句句有 check 兜底却只有三个输入点、查表照样能过 —— 两道独立的门。

**Task 14 的额外要求**：写完每章后跑这三个自动化入口（Task 3 已全部固化）：

1. `python scripts/test_exercises.py` —— 结构、字段类型、三语 id 对齐
2. `python scripts/check_exercise_references.py` —— 实跑每个 reference 并按判分器口径验证 100% 通过；另带一条断言：**`explanation` 里若出现具体的函数调用输入，则 checks 里必须存在执行该输入的 check**
3. `python scripts/check_regex_parity.py` —— 第 16 条规则的静态黑名单 + Python/JS 行为比对

**这三个入口 CI 都会跑**（`.github/workflows/deploy-modelscope.yml` 的 `Verify exercise data` 步骤，第 3 个需要同一 job 里的 node）。三个脚本同时也是 pytest 文件，`pytest scripts/check_exercise_references.py scripts/check_regex_parity.py -q` 可跑前两个。

**断言 A 的覆盖面要说准**：它只抓**`explanation` 里引用了具体实参的那一类**缺陷（只扫 `explanation`、只认带字面量实参的调用、只认本题定义的函数）。`prompt` 里追加一条必答要求、或只写「必须做 X」而不给具体输入时，它都返回空 —— 不要拿它当「解析与判分对齐」的全面保证，那是第 14 与第 18 条规则要人工把关的部分。

**规则 19–20（来自 Task 8 的两轮评审）**

19. **`predict` 型题目的选项格式（Task 8 的解析器规则，也是 UI 的解析依据）**：一个选项只并入它**正下方**满足以下三条的行 —— 比选项自身**缩进更深**、本身**不带标记**、且**不开启 Markdown 块**（`>` 引用、`-`/`*`/`1.` 列表项、`#` 标题）。**空行立即结束选项块。** 其余一切都是题干散文，照常显示在题干里，不会被吞进选项标签。

    真正的折行选项不受影响 —— 悬挂缩进本就是「续行」的定义。

    **验证要求**：选项后紧跟散文（无论有没有空行隔开）时，散文**不得**进选项标签，同时**必须仍出现在题干里**（既不吞掉也不丢字）。

20. **判分边界要在 `explanation` 里诚实标注。** 当某个必答点只有一条 check 守着时（达不到规则 13 的 P2），必须在 `explanation` 里写明这一点及其薄弱程度。远好过假装满足。

**练习题不得在 `explanation` 里承诺做不到的事。** 典型反例（Task 3 第 2 轮发现）：`ch33-ex02` 的解析强调「`round(x, 3)` 保证返回 0.7 而不是 0.7000000000000001」，但没有任何 check 区分 round 与不 round（不 round 仍 100% 通过）—— **而且那句话本身也不成立**：`14/20` 在二进制浮点下就等于 `0.7`，round 是多余的。写不出对应 check 的主张就不该写进解析。

- [ ] **Step 4: 校验中文语料**

`scripts/test_exercises.py` 此时会因 en/es 仍是占位（中文残留）而失败。用下面的独立脚本先确认中文部分：

```bash
cd D:/Coding/ms-cookbook
python3 -c "
import json, glob, pathlib, collections
counts = {}
total = 0
for path in sorted(glob.glob('content/exercises/zh/chapter-*.json')):
    items = json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
    counts[path] = len(items)
    total += len(items)
print('chapters:', len(counts))
print('total:', total)
print('per-chapter:', sorted(set(counts.values())))
assert total >= 95, total
assert set(counts.values()) <= {2, 3}, counts
print('zh corpus OK')"
```

Expected: `chapters: 34`、`total: >= 95`、`per-chapter: [2, 3]`、`zh corpus OK`。

**注意**：`python3 scripts/build-exercises.py` 要等 Task 15 完成才能跑通 —— 它要求三语齐备。中文阶段只跑上面的独立校验。

- [ ] **Step 5: 提交**

```bash
git add content/exercises assets/exercises.js
git commit -m "feat: add Chinese exercises for the remaining 32 chapters"
```

---

## Task 15: 英西翻译

**Files:**
- Modify: `content/exercises/en/*.json`（32 个）
- Modify: `content/exercises/es/*.json`（32 个）
- Regenerate: `assets/exercises.js`

**Interfaces:**
- Consumes: Task 14 的中文语料
- Produces: 完整三语语料，`scripts/test_exercises.py` 全绿

- [ ] **Step 1: 翻译规则**

**翻译**：`objective`、`prompt`、`explanation`、`reference`、`checks[].value`、`checks[].pattern`、`checks[].criteria`

**不翻译**：`id`、`chapter`、`type`、`difficulty`、`minutes`、`starter`、`checks[].code`、`checks[].name`、`checks[].weight`、`checks[].correct`、`checks[].min`、`checks[].max`、`llm_rubric.enabled`

**特别注意 `checks[].pattern`**：它是正则，直接参与判分。

- 第 07 章 `stdout_matches` 的 pattern 含中文 `我是[\s\S]{1,20}，\s*我想学\s*[^\s]` —— **保留中文**，因为它在判用户的输出（示例代码本就输出中文）。校验器只检查 `objective/prompt/explanation/reference` 四个字段的中文残留，不检查 `pattern`。这一条 pattern 三语**逐字相同**，翻译时不要顺手「本地化」它：它是判分口径，不是文案。
- 第 13 章的 `stdout_matches` pattern 含 `swift\s+sft` 等英文命令，保持不变。
- **三语的 `weight` 必须逐条相等**：`scripts/test_exercises.py` 会断言 id / type / difficulty 对齐，但**不比对 weight**。翻译时顺手改权重，等于给另一种语言的判分换了口径，而 CI 不会报。

- [ ] **Step 2: 逐语言翻译**

对每个 `zh/chapter-NN.json` 生成对应的 `en/chapter-NN.json` 与 `es/chapter-NN.json`。结构与 key 集合必须与中文完全一致（校验器断言）。

- [ ] **Step 3: 验证**

```bash
python3 scripts/build-exercises.py
.venv/bin/python scripts/test_exercises.py
node scripts/check-site.mjs
```

Expected: 全部通过。校验器的 CJK 正则会捕获任何漏译的字段。

- [ ] **Step 4: 提交**

```bash
git add content/exercises assets/exercises.js
git commit -m "feat: add English and Spanish editions of every exercise"
```

---

## Task 16: 文档收尾与验收

**Files:**
- Modify: `README.md`（补题量统计，若与实际不符）
- Modify: `content/exercises/manifest.json`（若 `packages` 需补）

- [ ] **Step 1: 核对数字**

```bash
cd D:/Coding/ms-cookbook
python3 -c "
import json
raw=open('assets/exercises.js',encoding='utf-8').read()
d=json.loads(raw.split('=',1)[1].strip().rstrip(';'))
print('chapters with exercises:',len(d['chapters']))
print('total exercises:',d['exerciseCount'])
from collections import Counter
print(Counter(e['type'] for c in d['chapters'].values() for e in c['exercises']['zh']))
print('reflect share:', sum(1 for c in d['chapters'].values() for e in c['exercises']['zh'] if e['type']=='reflect'),'/',d['exerciseCount'])"
```

对照设计 §13.2 验收标准：
- 34 章各有 2–4 题 ✓（检查上一步 Counter 的 min）
- 总题量 ≥ 95 ✓
- 三语 id 集合一致 ✓（校验器已断言）
- en/es 无中文残留 ✓（校验器已断言）

**若 `reflect` 占比超过 60%**，说明内容偷懒了 —— 大量章节被写成「不可跑」而不是设计可跑的题。回到 Task 14 重写。

- [ ] **Step 2: 跑全部校验**

```bash
.venv/bin/python -m pytest tests -q
node scripts/test-exercise-grader.cjs
node scripts/test-exercise-store.cjs
node scripts/test-exercise-map.cjs
python3 scripts/build-content.mjs --check
python3 scripts/build-i18n.py --check
python3 scripts/build-exercises.py --check
node scripts/check-site.mjs
```

Expected: 全部通过，零失败。

- [ ] **Step 3: 更新 README 的题量描述**

若 Task 12 写入的描述与实际题量不符，修正 `README.md` 与 `README.zh-CN.md`。

- [ ] **Step 4: 提交**

```bash
git add -A
git commit -m "docs: reconcile exercise counts with the shipped corpus"
```

---

## 验收总表

对照设计 §13：

| 阶段 | 任务 | 关键验收 |
|---|---|---|
| P0 引擎 | 1–13 | 判分器/存储/地图 100% Node 覆盖；API 全覆盖；手工 15 项验证通过；现有功能零回归 |
| P1 内容 | 14 | 34 章 × 2–4 题，≥95 题 |
| P2 一致性 | 15–16 | 三语 id 齐备；无中文残留；学习地图与实际进度一致 |

## 执行顺序依赖

```
1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16
```

- Task 4/5/6/7 彼此独立，可并行。
- Task 8 依赖 4/5/6 的产物。
- Task 13 需要 Task 10/11 完成（否则页面加载不了练习功能）。
- Task 14 依赖 Task 3 的 schema 冻结，并在结尾把 manifest 展开到 34 章。
- Task 15 依赖 Task 14。

## 三处易错实现点

以下三点在直觉编码下都会写错，且**测试能抓住**。写完后对照检查一遍。

| 位置 | 错误写法 | 正确写法 |
|---|---|---|
| `exercise-worker.js` | 用两个 `push()` 数组 + `shift()` 分配 outcomes | 两个 evaluator 都 `map()` 返回**等长数组**（不处理的 kind 填 `null`），合并时**按索引**取 |
| `exercise-ui.js` | 用 `result.outcomes.find(Boolean)` 过滤后按顺序对齐 | 直接 `result.outcomes[index]`，worker 保证与 `checks` 等长同序 |
| `exercise-map.js` | 从 `chapterSummary()` 的返回值里读每题状态 | `chapterSummary()` 只返回计数；状态必须调 `store.read(chapterId, id)` |

前两处的共同教训：**跨函数传递的数组必须保持索引对齐，任何过滤或 `shift` 都会在第 2 项之后静默错位** —— 用户看到的是「第二条断言失败」，实际是第一条。