# Super Intelligence Learning Space (SILS) 设计文档

日期：2026-10-18
状态：已批准，待实施计划
作者：沈愐 / 阿步

---

## 1. 目标与范围

把 ms-cookbook（ModelScope Cookbook，魔搭紫皮书）从**静态阅读站**扩展为**交互式学习空间**：读者不只读文字，而是在浏览器里写代码、跑代码、拿自动反馈、看自己的学习进度。

### 1.1 明确纳入

- 35 章全量配套练习（约 100+ 条），中文 + English + Español 三语
- 浏览器内 Python 沙箱（Pyodide/WASM），本地 vendor，按需加载
- 混合判分：确定性断言为主，LLM 评分为可选增强，默认关闭
- 进度本地优先（游客即用即走），登录后同步到 SQLite
- `#practice` 视图升级为学习地图：8篇 × 练习网格，三态进度

### 1.2 明确排除（YAGNI）

- 不换技术栈，不引入 Next.js/React，不新建子应用
- 不做远程算力沙箱，不调用本地 Ollama/llama.cpp
- 不做多智能体陪练、Prompt 实验室、模型对比台
- 不做社区排行榜/勋章/社交关系
- 不改现有章节正文一个字，不改现有 OAuth/划线/留言/统计的任何行为

### 1.3 关键取舍（已确认）

| 决策 | 结论 |
|---|---|
| 需要 GPU/服务的真实推理题 | 降级为 `reflect` 类型，只做概念自评，**不假装能跑** |
| LLM 评分 | 默认关闭；未配置 Key 时全部走确定性判分或自评降级 |
| 交付节奏 | 一次性全交付（引擎 + 35 章 + 三语） |
| Pyodide 托管 | 本地 vendor（`assets/vendor/pyodide/`） |

---

## 2. 现有系统的硬约束（设计前提）

这些是读代码得到的事实，不是假设。设计必须服从。

| # | 约束 | 出处 | 设计后果 |
|---|---|---|---|
| C1 | 章节 HTML 有白名单，禁止 `<button> <input> <details> <iframe>` 等标签 | `scripts/build-content.py:184` `SAFE` 集合 | 练习 UI 不能写进章节正文，必须 JS 动态注入 |
| C2 | 章节 HTML 禁止任何 `on*` 事件属性 | `scripts/build-content.py:185` | 同上，交互只能靠事件监听绑定 |
| C3 | 翻译管线按**块序号**索引（`{"0": "...", "1": "..."}`） | `scripts/build-i18n.py:170` | 练习内容一旦进章节 HTML 块流，i18n 序号整体位移，`build-i18n.py --check` 失败 |
| C4 | `build-content.py --check` 与 `build-i18n.py --check` 是字节级全等比对 | 两个脚本 | 任何生成物改动必须同步提交 |
| C5 | 服务端 `chapters` 映射排除 `status == 'pending'` | `app.py:256` | chapter-24 的练习 API 返回 404，练习面板也不显示 |
| C6 | 写操作强制 `require_user` + CSRF token + 同源校验 | `app.py:302-322` | 游客态必须纯前端，不得请求服务端 |
| C7 | 路由 view 白名单硬编码在 `paper.js` | `assets/paper.js:392` | 新增 view 名必须改这一行 |
| C8 | 访问统计有 `analytics_pages` / `analytics_titles` 白名单 | `app.py:258-259` | 改view 需同步改这里 |
| C9 | `assets/*.js\|css` 带 `?v=<sha256>` 缓存指纹 | `scripts/version-assets.mjs` | 新增/修改后必须跑该脚本 |
| C10 | 部署文件白名单在 `deploy-modelscope.mjs` | `scripts/deploy-modelscope.mjs:79` | 新目录需确认是否被包含 |
| C11 | 现有代码零Pyodide / 零沙箱 / 零练习 / 零进度表 | 全仓 grep | 全部为新增，无历史包袱也无既有接口 |
| C12 | `assets/penguin-harness/` 是纯图片目录 | 目录内 31 个 PNG | 与本项目无关，不要误用 |

**结论：C3 是最关键的设计驱动因素** —— 它直接导致「练习数据完全独立于章节 HTML」这个根本架构决策。

---

## 3. 架构

四层。每层可独立理解、独立测试、单一职责。

```
L1 练习数据层    content/exercises/{manifest.json, zh|en|es/chapter-NN.json}
                 → scripts/build-exercises.py → assets/exercises.js
                 → 内容不进入 content/chapters/、不进入章节 HTML（守 C3）

L2 运行沙箱层    assets/exercise-sandbox.js（主线程门面）
                 → Web Worker → assets/vendor/pyodide/（lazy load）
                 → 捕获 stdout/stderr，15s 强制 terminate

L3 判分引擎层    assets/exercise-grader.js（纯函数，无 DOM 无网络）
                 级别1 确定性 checks[]（默认，主路径）
                 级别2 LLM 评分（可选，需 Key）
                 级别3 降级：参考答案 + 自评

L4 进度存储层    浏览器本地存储（游客主路径）
                 ↔ app.py SQLite exercise_progress（登录后增量同步）
```

### 3.1 依赖方向

严格单向向下，无反向依赖：

```
L4 → L3 → L2 → L1
```

- L1 是纯数据，无代码
- L2 只接受「代码字符串」，不知道练习是什么
- L3 只接受「运行结果 + checks」，不知道 Pyodide 怎么跑
- L4 只知道 exercise id，不知道练习内容

每层因此可单独测试：L3 在Node 里跑单测（不需要 WASM），L2 的 timeout 逻辑可 mock，L4 的存储可用内存替身。

---

## 4. L1 练习数据层

### 4.1 目录布局

```
content/exercises/
  manifest.json                     # 练习索引与校验依据
  zh/chapter-01.json ... chapter-35.json     # 35 个
  en/chapter-01.json ... chapter-35.json     # 35 个
  es/chapter-01.json ... chapter-35.json     # 35 个
```

共106 个 JSON 文件。命名与 `content/chapters/` 对齐（两位补零），但**内容完全独立**。

`content/exercises/` 会被 `deploy-modelscope.mjs` 自动包含（它在 `content/` 下）。

### 4.2 练习 schema

```json
{
  "id": "ch01-ex03",
  "chapter": "chapter-1",
  "type": "code",
  "difficulty": 2,
  "minutes": 6,
  "objective": "理解参数量与显存占用的关系",
  "prompt": "给定模型参数量 P（十亿），估算 fp16 权重占用显存（GiB）。",
  "starter": "# 用公式计算\nparams_b = 7\n",
  "checks": [
    { "kind": "assert_python", "code": "assert abs(mem - 14.0) < 0.1", "weight": 2 },
    { "kind": "stdout_contains", "value": "14", "weight": 1 }
  ],
  "llm_rubric": {
    "enabled": false,
    "criteria": "是否说明了 fp16 每参数 2 字节，以及未计入激活值与 KV cache"
  },
  "reference": "params_b * 2 / 1024 = 14 GiB",
  "explanation": "fp16 每个权重占 2 字节。7B × 2 = 14GB，除以 1024 得 GiB。实际部署还要加 KV cache 与激活值。"
}
```

**字段约束**

| 字段 | 类型 | 必填 | 约束 |
|---|---|---|---|
| `id` | string | 是 | 全局唯一，`ch{NN}-ex{MM}` |
| `chapter` | string | 是 | 必须存在于 `content/manifest.json` 的 chapters |
| `type` | enum | 是 | `code` / `predict` / `fill` / `build` / `reflect` |
| `difficulty` | int | 是 | 1 / 2 / 3 |
| `minutes` | int | 是 | 1–60 |
| `objective` | string | 是 | ≤ 60 字，一句话说明学什么 |
| `prompt` | string | 是 | 题干 |
| `starter` | string | `code`/`build` 必填 | 初始代码 |
| `checks` | array | 可选（`reflect` 可空） | 每项必须有 `kind` + `weight` |
| `llm_rubric` | object | 否 | `enabled` 默认 false |
| `reference` | string | `reflect` 必填 | 参考答案 |
| `explanation` | string | 是 | 解析 |

**`checks[].kind` 白名单**（构建时校验，不允许未知 kind）

| kind | 语义 | 附加字段 |
|---|---|---|
| `assert_python` | 在沙箱内跑Python 断言，必须为真 | `code` |
| `stdout_contains` | 标准输出包含子串 | `value` |
| `stdout_equals` | 标准输出精确等于（trim 后） | `value` |
| `stdout_matches` | 正则匹配 | `pattern` |
| `var_equals` | 沙箱全局变量等于某值 | `name`, `value` |
| `var_in_range` | 沙箱全局变量在区间内 | `name`, `min`, `max` |
| `output_choice` | 单选/多选题正确项匹配 | `correct`（数组） |
| `self_assessed` | 仅 `reflect` 用，人工自评占位 | — |

**`type` 语义**

| type | 沙箱 | 说明 |
|---|---|---|
| `code` | 需要 | 写代码跑通并满足 checks |
| `build` | 需要 | 同code，但通常多检查产物结构 |
| `predict` | 不需要 | 预测题：选/填 → `output_choice` 自动判 |
| `fill` | 不需要 | 填空 → 字符串比对 |
| `reflect` | 不需要 | 概念自评 + 参考答案 + LLM 评分（若开启） |

### 4.3 `manifest.json`

```json
{
  "title": "ModelScope Cookbook 练习集",
  "version": 1,
  "languages": ["zh", "en", "es"],
  "chapters": [
    { "number": 1, "chapter": "chapter-1", "exerciseCount": 3, "idPrefix": "ch01" },
    ...
  ]
}
```

### 4.4 构建脚本 `scripts/build-exercises.py`

职责：
1. 读`content/exercises/manifest.json`
2. 逐语言读 35 个练习文件，校验 schema
3. 输出 `assets/exercises.js`：`window.EXERCISE_DATA = {...};\n`
4. `--check` 模式做字节级比对（与现有脚本一致）

**构建期强校验（失败即 `SystemExit`）**

- 每章练习文件的 `chapter` 字段与文件名匹配
- `id` 全局唯一
- `id` 前缀与 `manifest.json` 的 `idPrefix` 匹配
- `chapter` 必须存在于 `content/manifest.json`，且 `status == 'ready'`（守 C5：chapter-24 跳过）
- `checks[].kind` 在白名单内
- 三语文件 id 集合完全一致（缺一即失败，不做降级 —— 这是内容正确性的保证）
- `exerciseCount` 与实际条数一致
- `reflect` 型必须有 `reference`
- 非 `reflect` 型若无 `checks`，构建失败（不允许"有题无验收"）

**输出格式**（与 `assets/content.js` 风格一致）

```
window.EXERCISE_DATA = {"title":"...","version":1,"languages":["zh","en","es"],"exercises":{"chapter-1":{"zh":[...],"en":[...],"es":[...]}},...};
```

按 `chapter.id` → `lang` → 数组 分组，前端直接取用，零解析逻辑。

---

## 5. L2 运行沙箱层

### 5.1 加载策略

Pyodide 约 15MB，**绝不进主包**。

```
用户点击「运行」
  → assets/exercise-sandbox.js 检查全局 Pyodide 是否已就绪
  → 未就绪：显示「正在加载运行环境（首次约 15MB）」+ 骨架态
  → importScripts('assets/vendor/pyodide/pyodide.js')
  → loadPyodide({ indexURL: 'assets/vendor/pyodide/' })
  → 就绪，标记全局，Worker 复用
```

二次点击直接复用，无重复下载。

### 5.2 Web Worker 边界

沙箱跑在**独立 Worker**，主线程不阻塞。超时用 `worker.terminate()` 硬杀。

- 消息协议：`{type:'run', code, checks, timeoutMs}` → `{type:'result', passed, checks, stdout, stderr, error, ms}`
- 超时默认 15000ms，可在练习级覆写
- Worker 崩溃：捕获 `worker.onerror`，重建 Worker，重试一次，失败则报「运行环境异常」

### 5.3 Pyodide 默认即安全

Pyodide 默认无网络、无文件系统写、无 subprocess。无需额外加固。文档中明确写出这个边界，避免读者误以为可以在里面 pip install。

### 5.4 判分在 Worker 内完成

`checks` 一并发给 Worker，Worker 在同一Python 会话里跑完所有断言，只回传结构化结果。避免多次 `runPython` 的往返开销，也避免主线程接触 Python 异常对象。

### 5.5 vendor 落地

```
assets/vendor/pyodide/
  pyodide.js
  pyodide.asm.wasm
  python_stdlib.zip
  pyodide-lock.json
  + 依赖包（仅在练习用到时补：numpy / pandas / matplotlib）
```

版本固定在 `assets/vendor/pyodide/VERSION`。由 `scripts/test_exercises.py` 校验该文件存在且对应目录完整 —— 构建脚本不关心 vendor（职责单一），防误删交给测试脚本。

**依赖包策略**：默认只带标准库。若某章练习需要 numpy，则显式加入并记录在 `manifest.json` 的 `packages` 字段。不做「全量科学栈」——那会让15MB 变成 60MB。

---

## 6. L3 判分引擎层

### 6.1 三级降级（核心设计）

**判分绝不阻断学习流程。** 任何一级失败都降级到下一级，不弹错误页。

| 级别 | 触发条件 | 行为 | 计分 |
|---|---|---|---|
| **1 确定性** | `checks[]` 存在非 `self_assessed` 项 | 立即执行，加权通过率 | 计入 |
| **2 LLM** | `llm_rubric.enabled === true` **且** 服务端已配 Key | `POST /api/exercises/grade`，返回0–1 分数 | 计入 |
| **3 降级** | 无 Key / 请求失败 / 超时 | 显示 `reference` + `explanation` + 三档自评按钮 | **不计入**，标记 `self-assessed` |

### 6.2 加权通过率

```
score = Σ(weight of passed checks) / Σ(all weights)
passed = score ≥ 0.8
```

阈值 0.8 的理由：允许一道题有 1 个次要检查项未过（如提示信息文案），不至于全盘否定。

`score` 与逐项结果都回传给前端，用于展示「哪一步没过」。

### 6.3 LLM 评分链路

```
前端 → POST /api/exercises/grade {exerciseId, answer, criteria}
     → app.py 检查 EXERCISE_LLM_KEY
        ├── 未配置 → 503 {fallback: true}
        └── 已配置 → 调 LLM → {score, feedback}
     → 前端收到 503 → 自动切级别 3，不报错、不重试
```

**默认关闭。** 未配置 `EXERCISE_LLM_KEY` 时，服务端返回 503，前端立即走自评。这是零成本、零外部依赖的默认路径。

### 6.4 纯函数约束

`assets/exercise-grader.js` 是纯函数集合：

- 不碰 DOM
- 不发网络请求
- 不读 `window`（除注入的依赖）
- 输入 `{checks, result, exercise}`，输出 `{passed, score, items[], mode}`

因此可在 Node 里直接单测，无需浏览器、无需 Pyodide。这是本层可测性的基础。

---

## 7. L4 进度存储层

### 7.1 本地优先

```
命名空间：ms-cookbook.exercise.v1
结构：{ [chapterId]: { [exerciseId]: {passed, score, attempts, code, selfAssessed, updated} } }
```

游客态：读写全在本地，`localStorage` 不可用时（隐私模式）降级为内存态，仅当次会话有效。

### 7.2 登录后同步

```
页面加载 → GET /api/session
  → 未登录：纯本地，不发任何写请求
  → 已登录：GET /api/exercises/progress
            → 合并策略（下方）
            → 合并后如有变化，POST 回写本地合并结果
```

**合并策略**（双方可能各自有进度）：

| 情况 | 结果 |
|---|---|
| 仅一方有 | 保留该方 |
| 双方都有，`updated` 服务端较新 | 服务端胜 |
| 双方都有，`updated` 本地较新 | 本地胜，回写服务端 |
| 双方都有，`updated` 相等 | 取 `passed` 的逻辑或（任一通过即通过） |

`updated` 用客户端 unix 秒。时钟偏移不影响正确性 —— 因为冲突时只是"选一个"，不会产生数据损坏。

### 7.3 服务端表

```sql
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

加入 `app.py:82-91` 的 `executescript`（幂等，`CREATE TABLE IF NOT EXISTS`）。

### 7.4 API

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/api/exercises/progress` | 可选（公开读，游客返回空） | 读取该用户全部进度 |
| POST | `/api/exercises/progress` | `require_user` | 批量 upsert，CSRF + 同源 + 限流 |
| POST | `/api/exercises/grade` | 公开 | LLM 评分，无 Key 返回 503 |

**限流**：60 秒内同一用户最多 20 次写入（照抄 `app.py:544-555` 的 `BEGIN IMMEDIATE` + count 范式）。比现有接口宽松，因为用户一次学习可能连续提交多题。

**写入安全**：
- `code` 字段最长 20000 字符（防止超大 payload）
- `exercise` 必须存在于 `EXERCISE_DATA`（守恒：不为不存在的练习存进度）
- `chapter` 必须在 `chapters` 映射内（守 C5）
- 全部走 `require_user`（CSRF + 同源）

### 7.5 隐私

`code` 存的是用户写的代码。`AUTH-AND-DISCUSSION.md` 已承诺"不上传个人信息"。练习代码同标准：**不写生产密钥、不含个人数据**，在 UI 上以提示文案明示。

---

## 8. UI 设计

### 8.1 章节页练习面板

在 reader view 的 `.chapter-pager` 之后注入（照抄 `assets/discussion.js:9-10` 模式，守 C1/C2）：

```
┌─────────────────────────────────────────┐
│ 本章练习 3 题 · 预计 18 分钟   已通过 1/3│
├─────────────────────────────────────────┤
│ [题目卡片 1]                    ✓ 已通过 │
│ [题目卡片 2]                    ○ 未完成 │
│ [题目卡片 3]                  ~ 自评通过 │
└─────────────────────────────────────────┘
```

点击展开：

```
目标：理解参数量与显存占用的关系
─────────────────────────────────
题干（渲染为轻 Markdown）
───────────────────────────────
[代码编辑器 textarea]
───────────────────────────────
[▶ 运行]  [重置]  [查看提示]
───────────────────────────────
✓ 断言 1：显存估算正确 (weight 2)
✗ 断言 2：未考虑 KV cache (weight 1)
score 0.67 / 未通过 · 用时 1.2s
[查看解析]
```

`reflect` 型不显示编辑器，显示自评三档 + 参考答案（折叠）。

### 8.2 学习地图（`#practice` 视图升级）

复用现有 `#practice`（当前只是场景卡片导航，`paper.js:69-70` 硬编码 map）：

```
学习地图  总进度 34/102 练习 · 12 章已打通

第一篇 认识开源模型          8/9
  01 开源模型正在改变什么      ✓✓✓
  02 开源模型还没用上…         ✓✓~
  03 数据，是你要做…           ✓○○

第二篇 从问题出发              4/8
  ...

第三篇 让第一个模型工作起来      2/12
  ...
```

三态：`✓` 通过 / `~` 自评通过 / `○` 未做。点击跳转 `#chapter-N`。

顶部汇总条复用已有 `updateProgress` 机制。

### 8.3 语言切换

练习内容随站点语言切换，与章节翻译同一套机制（`window.MSI18N.lang`）。缺译时回落中文并显示提示条（照抄 `paper.js:310-312` 的降级逻辑）。

因为练习数据独立于章节 HTML，**练习翻译不参与 `build-i18n.py` 的块序号**，切换零风险。

### 8.4 移动端

- 练习面板在窄屏折叠为单列，代码编辑器最小高度 200px
- 学习地图网格 8列 → 2 列
- 「运行」按钮固定在编辑器下方，不悬浮（避免遮挡）

---

## 9. 错误处理

| 场景 | 行为 |
|---|---|
| Pyodide 加载失败 | 练习区显示「运行环境加载失败」+ 「重试」+ 「跳过本题」；**不影响阅读** |
| 代码语法错误 | 显示 Python traceback（教学价值），不惩罚 |
| 运行超时 | 「运行超时（15s），请检查是否有死循环」 |
| 沙箱崩溃 | 重建 Worker 重试一次；仍失败则「环境异常，请刷新页面」 |
| 本地存储不可用 | 内存态，当次会话有效，提示「进度不会保存」 |
| 同步失败 | 静默重试 1 次，仍失败则本地为准，不打断 |
| LLM 评分 503 | 立即切自评，不重试、不报错 |
| 练习数据缺失 | 面板不显示，不留空壳 |

**核心原则：练习功能的所有故障都不阻断阅读。** 阅读站是主体，练习是增强。

---

## 10. 测试策略

| 层 | 文件 | 覆盖 |
|---|---|---|
| L1 构建 | `scripts/test_exercises.py` | schema 完整、id 唯一、三语齐备、章节存在、kind 白名单、generate物字节一致 |
| L3 判分 | `scripts/test-exercise-grader.cjs` | 8 种 `kind` 各一用例、加权阈值 0.8 边界、降级路径、异常输入 |
| L4 API | `tests/test_exercise_api.py` | 游客读空、401 无 CSRF、403 错 origin、429 限流、未知 exercise 拒绝、503 降级 |
| 集成 | `tests/test_exercises_build.py` | 端到端：构建 → 校验 → check-site 全通过 |

**Pyodide 不进 CI。** CI 跑不了 WASM 大文件，也不该跑（15MB 下载 × 每次 CI）。沙箱层靠手动验证 + 浏览器 E2E。判分层是纯函数，所以判分逻辑 100% CI 覆盖——这正是 L3 纯函数约束的回报。

**CI 链扩展**（`.github/workflows/deploy-modelscope.yml` 现有 4 步后追加）：

```yaml
- name: Verify exercise data
  run: |
    python3 scripts/build-exercises.py --check
    python3 scripts/test_exercises.py
- name: Verify exercise grader
  run: node scripts/test-exercise-grader.cjs
- name: Verify exercise API
  run: .venv/bin/python -m pytest tests -q
```

同时把 `scripts/build-exercises.py` 与 `scripts/test-exercises.py` 加进 workflow 的 `paths:` 白名单。

---

## 11. 内容生产（35 章 × 3 语 = 105 文件）

### 11.1 排期策略

一次性全交付，但按「样板 → 批量 → 翻译」三步走，中间可验收。

**Step 1 · 黄金样板（3 章）**

选三章覆盖面最广的作为 schema 冻结依据：

| 章 | 选它的原因 |
|---|---|
| 07「30 分钟带你快速看到第一个结果」 | 纯代码，最简单 |
| 13「用 ms-swift 完成轻量微调」 | 需要参数构造，典型 build 题 |
| 33「产线巡检 Agent」 | 多步骤综合，最复杂 |

三章写完 → schema 冻结 → 跑构建校验 → 用户验收。**这是唯一的强制质量闸门。**

**Step 2 · 批量补齐 35 章（剩余 32 章）**

按篇分组，同篇内风格统一。每章 2–4 题。

**Step 3 · en/es 翻译**

`content/exercises/en/*.json` 与 `es/*.json`。翻译的是 `prompt` / `objective` / `explanation` / `reference` / `checks[].value` / `checks[].pattern` 字段。**`checks[].code`（Python 断言）不翻译。**

### 11.2 各类章节的练习形态

| 篇 | 章数 | 练习形态 | 沙箱 |
|---|---|---|---|
| 1 认识开源模型 | 4 | 概念判断 + 许可证对比 | `predict` / `reflect` |
| 2 从问题出发 | 2 | 任务定义 + EvalScope 指标选择 | `predict` / `fill` |
| 3 跑得起 | 5 | 显存估算、量化计算、Ollama 命令构造 | `code` |
| 4 微调与评测 | 4 | 数据格式化、超参对比、评测指标计算 | `code` |
| 5 业务系统实践 | 5 | RAG 检索、结构化输出、语音/视觉流程 | `build` / `reflect` |
| 6 AIGC | 5 | 参数构造、Prompt 设计 | `reflect` / `predict` |
| 7 Agent | 8 | MCP 配置构造、Skill 定义、Prompt 设计 | `build` / `reflect` |
| 8 补充基础 | 2 | 注意力计算、参数量估算 | `code` |

**总题量目标：约 100 题**（34 章 × 2–4 题，chapter-24 为 pending 不配题）。

### 11.3 「不可跑」题的诚实处理

以下主题**无法在浏览器 Pyodide 中真实运行**：

- 需要 GPU 的模型推理（DiffSynth、图像 LoRA 训练）
- 需要 ms-swift 训练集群的微调
- 需要 TTS/ASR 模型
- 需要外部 API（ModelScope、Ollama 服务端）
- 需要 Agent 框架运行时（Claude Code、PI、DeepSeek Harness）

**处理方式：写 `reflect` 题。**

```
类型：reflect
题干：如果你要用 DiffSynth 训练一个商品图 LoRA，
     数据集需要满足哪三个条件？写下来。
自评：对照参考答案，逐条打勾
[✓ 我答对了] [~ 部分对] [✗ 没答出]
```

绝不写「运行这段代码」的按钮然后让它失败。**假装能跑比不提供练习更糟** —— 那会教读者「这个站的练习都是假的」。

---

## 12. 对现有系统的改动清单

| 文件 | 改动 | 风险 |
|---|---|---|
| `content/exercises/**` | 新增 106 文件 | 无 |
| `scripts/build-exercises.py` | 新增 | 无 |
| `scripts/test_exercises.py` | 新增 | 无 |
| `scripts/test-exercise-grader.cjs` | 新增 | 无 |
| `assets/exercises.js` | **生成物** | 需与源同步提交 |
| `assets/exercise-sandbox.js` | 新增 | 无 |
| `assets/exercise-grader.js` | 新增 | 无 |
| `assets/exercise-ui.js` | 新增 | 无 |
| `assets/exercise.css` | 新增 | 无 |
| `assets/vendor/pyodide/**` | 新增 ~15MB | 仓库变大；deploy 白名单需确认 |
| `index.html` | 加 3 个 script + 1 个 css + 练习容器 | 低 |
| `assets/paper.js` | `#practice` 视图升级 | **中** — 现有 practice 是场景卡片导航，需合并而非替换 |
| `assets/version-assets.mjs` 后跑一次 | 刷新 `?v=` 指纹 | 低 |
| `app.py` | +1 表、+3 端点、+1 pydantic 模型、LLM proxy | 低 |
| `tests/test_exercise_api.py` | 新增 | 无 |
| `.github/workflows/deploy-modelscope.yml` | +2 步 + paths 白名单 | 低 |
| `AUTH-AND-DISCUSSION.md` | 补练习数据与隐私说明 | 无 |
| `README.md` / `README.zh-CN.md` | 补练习功能段落 | 无 |

**不动**：`content/source-html/**`、`content/chapters/**`、`content/manifest.json`、`scripts/build-content.py`、`scripts/build-i18n.py`、`scripts/chapter_markdown.py`、现有 OAuth/划线/留言/统计的任何逻辑。

---

## 13. 验收标准

### 13.1 引擎（P0）

- [ ] `python3 scripts/build-exercises.py` 生成 `assets/exercises.js`，`--check` 通过
- [ ] `scripts/test_exercises.py` 全绿（含 vendor 完整性检查）
- [ ] 章节页出现练习面板，读代码/划线/留言**无回归**
- [ ] `code` 型练习可运行、判分、显示逐项结果
- [ ] `reflect` 型练习可自评，不显示运行按钮
- [ ] 游客刷新页面进度保留；登录后同步到服务端，换浏览器可见
- [ ] Pyodide 加载失败时阅读功能完全正常
- [ ] `pytest tests -q` 全绿（含原有测试）
- [ ] `node scripts/check-site.mjs` 全绿
- [ ] 移动端 375px 宽下面板可用

### 13.2 内容（P1）

- [ ] 34 章各有 2–4 题，总题量 ≥ 95
- [ ] 三语文件 id 集合完全一致
- [ ] en/es 翻译不含中文残留（构建脚本校验常见中文标点/汉字残留）
- [ ] 每题 `objective` 与所在章主题一致
- [ ] 每题 `explanation` 能独立看懂，不依赖正文

### 13.3 一致性（P2）

- [ ] 语言切换时练习内容同步切换，缺译回落中文并提示
- [ ] `#practice` 学习地图进度与实际练习进度一致
- [ ] 中文/英文站点均通过 `check-site.mjs`

---

## 14. 未决问题

| # | 问题 | 默认处理 |
|---|---|---|
| Q1 | Pyodide 版本选哪个 | 最新稳定版，固定到 `VERSION` 文件 |
| Q2 | 是否带 numpy | 默认不带；若第 11 章练习需要再加 |
| Q3 | LLM 用哪家 | 服务端 OpenAI 兼容接口，`EXERCISE_LLM_BASE_URL` 可配 |
| Q4 | 学习地图是否显示排行榜 | **不做**（已排除在范围外） |
| Q5 | 练习是否计入访问统计 | 复用现有 `purplebook:route` 事件，练习面板不分独立 page |

---

## 15. 参考

- 现有系统：`content/manifest.json`、`scripts/build-content.py`、`scripts/build-i18n.py`、`assets/paper.js`、`assets/discussion.js`、`app.py`
- 讨论与鉴权：`AUTH-AND-DISCUSSION.md`
- 依赖设计流程：superpowers `brainstorming` → `writing-plans`