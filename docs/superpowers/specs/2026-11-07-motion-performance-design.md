# 流畅度、缺陷与分层动效 设计文档

日期：2026-11-07
状态：已批准，待实施计划
作者：沈愐 / 阿步

---

## 1. 目标与范围

在不更换技术栈、不引入第三方依赖的前提下，把 SILS 从"能读"提升为"读起来顺、动起来有节奏、错误说得清"。三条主线：传输与加载提速、全站分层动效系统、已知缺陷收口。

### 1.1 明确纳入

- 后端内容类型感知的压缩、版本化资源的长缓存、webp 的 MIME 修正
- `index.html` 全部脚本 `defer`；非中文语言包与练习包按需注入
- 分层动效系统：路由切换 / 内容入场 / 组件微交互，共用一套时长与缓动 token
- `prefers-reduced-motion` 与 View Transitions 不支持时的双退路降级
- 章节渲染的强制同步布局消除、正文图片尺寸注入（消除 CLS 主因）
- 三个写端点偶发 500 的低风险兜底（503 + `Retry-After`）与前端退避重试
- 读者可见文案去技术化（10 处 `error.message` 直贴）
- 表单字段 `id`/`name` 缺失、死文件 `assets/app.js` 清理

### 1.2 明确排除（YAGNI）

- 不引入 GSAP 或任何动画库，不新增 `package.json` 与前端构建工具链
- 不拆分章节正文产物（正文仍由 `assets/content.js` 单文件承载）
- 不改 SQLite 的连接生命周期，即 `AUTH-AND-DISCUSSION.md` 里"真正的修法"仍标记未修
- 不动域名侧 TLS / Cloudflare 配置；不改 OAuth 与账号登录的任何行为
- 不改正文文字、不改版块结构、不做视觉重设计

### 1.3 关键取舍（已确认）

| 决策 | 结论 |
|---|---|
| 动效强度 | 全站分层动效系统（路由 + 内容 + 组件三层） |
| 改动边界 | 全链路：后端传输 + 前端加载 + 动效 + 缺陷 |
| 动效实现 | 零依赖原生层：CSS token + View Transitions + IntersectionObserver |
| 500 写竞争 | 低风险兜底（503 + 前端重试），不改连接模型 |
| 图片尺寸 | 构建期读取 webp/png 头部写入 `width`/`height`（接受改 `scripts/build-content.py`，不改产物结构） |

---

## 2. 现状基线（全部实测，非估计）

| 项目 | 实测值 | 取证方式 |
|---|---|---|
| 动效存量 | `@keyframes` 0 处、`will-change` 0 处；仅 5 个 CSS 文件有 hover 级 transition | 全仓 grep |
| 页面切换 | `[hidden]{display:none}` 硬切，`paper.js:426` 强制 `behavior:'instant'` | 代码 + 浏览器 |
| 首屏阻塞 | 14 个 stylesheet + 22 个 script，共 5,026,084 字节，`defer/async/preload` 0 处 | `index.html:9-22,133-137` |
| 压缩 | 无。`content.js` 893 KB、`exercises.js` 1.20 MB、两份正文译文 2.28 MB 原样传输 | Chrome trace：Compression FAILED |
| 缓存 | 静态资源仅 ETag/Last-Modified，无 `Cache-Control` | `curl -I` |
| webp MIME | `application/octet-stream` | 响应头 |
| LCP（章节页） | 387 ms，其中 load delay 245 ms | Chrome trace |
| CLS | 0.05，最差簇由未定尺寸的 `.article-image` 造成 | trace CLSCulprits |
| 强制重排 | 总计 70 ms，`renderChapter` 占 65 ms | trace ForcedReflow |
| 每次滚动读布局 | `updateProgress` 读 `article.offsetHeight`（`paper.js:390`） | 代码 |
| 控制台问题 | 表单字段缺 `id`/`name`，2 处 | Chrome 控制台 |
| 技术串外泄 | `discussion.js`/`wishes.js`/`analytics-dashboard.js` 共 10 处 `textContent=e.message` | 代码 |
| 死文件 | `assets/app.js` 未被任何页面引用 | `index.html` 脚本清单 |
| 测试环境 | 无 `package.json`、无 jsdom；node 侧用 `node:vm` + 手写最小 DOM | `test-exercise-ui-harness.cjs` |

---

## 3. 架构

四个互不纠缠的单元，每个都能独立理解与测试。

### 3.1 A 单元：传输层（`app.py`）

- **压缩**：新增内容类型感知的压缩中间件——在 `GZipMiddleware` 外包一层判定，响应类型不在白名单时直接剥掉请求的 `Accept-Encoding` 使其原样透传。白名单为 `text/*`、`application/javascript`、`application/json`、`image/svg+xml`；`image/webp`、`image/png`、`application/wasm` 不压缩（已压缩数据再 gzip 只烧 CPU）。站点无流式响应，压缩中间件不破坏任何现有行为。
- **缓存**：URL 携带 `?v=<sha12>`（由 `scripts/version-assets.mjs` 写入的 SHA-256 前 12 位）的资源返回 `Cache-Control: public, max-age=31536000, immutable`；未版本化的 `/favicon.svg`、`/deployment.json`、`/README*.md`、`/CONTRIBUTING.md` 返回短 `max-age + must-revalidate`；`/` 保持 `no-cache`，`/analytics` 保持 `no-store`。部署后哈希变化即 URL 变化，旧缓存自然失效。
- **MIME**：应用启动时注册 `image/webp`，使 webp 以正确类型下发。

对外契约不变：路径、状态码、响应体形状均不动，只动响应头与编码。

### 3.2 B 单元：加载层（`index.html`、`assets/i18n.js`、新增 `assets/asset-loader.js`）

- `index.html:133-137` 的 22 个脚本全部加 `defer`。已确认 `index.html` 有 0 个内联 `<script>`，`defer` 保持文档执行顺序，`check-site.mjs:61-67` 的顺序断言继续成立。
- 首屏仍随文档一起 eager 下载的两项（不进按需注入名单）：`assets/locale/zh.js` 与 `assets/content.js`——默认语言词典与全书正文，延迟它们会让首屏出现中文缺字或空正文。注意 `defer` 只解除解析阻塞，不解除下载，因此这两项仍计入首屏传输预算。
- 按需注入两组资源：
  - `assets/locale/<code>.js` + `assets/content-i18n/<code>.js`（en/es，合计约 3.4 MB）：仅在切换到该语言时加载。`i18n.js` 新增异步 `load(code)`，注入完成后 `register()` 再 `notify()`，从而复用 `paper.js:432` 已有的语言回调。
  - 练习包 6 个文件（`exercises.js`、`exercise-grader/store/sandbox/map/ui.js`，约 1.2 MB）：首次进入 `#practice` 时由 `ensureExerciseBundle()` 注入。依据：`window.EXERCISE_DATA` 只被 `exercise-map.js` 与 `exercise-ui.js` 读取。
- `asset-loader.js` 提供唯一的注入原语：`loadScript(src) -> Promise`，内部用 `<script>` + `onload/onerror`，并以 URL 为键缓存 promise。

### 3.3 C 单元：动效层（新增 `assets/motion.css`、`assets/motion.js`）

- **token**（现仓库存量：`styles.css:23` 只有颜色与布局 token，无任何动效 token）：
  - 时长 `--motion-fast: 120ms`、`--motion-base: 220ms`、`--motion-slow: 360ms`
  - 缓动 `--ease-out: cubic-bezier(.22,.61,.36,1)`、`--ease-in-out: cubic-bezier(.65,.05,.36,1)`
  - 位移 `--motion-rise: 10px`
- **硬约束**：动效只允许改变 `transform` 与 `opacity`；禁止对 `width/height/top/left/margin` 做过渡。路由过渡期间主线程不得出现 > 50 ms 长任务。
- **三层实现**：
  1. 路由切换——`paper.js` 的 `route()` 的 DOM 变更包进 `document.startViewTransition()`，`::view-transition-old/new(root)` 使用 token 做淡入 + `--motion-rise` 位移。
  2. 内容入场——`IntersectionObserver` 观察 `[data-reveal]`：章节正文的 h2 分节，以及首页、全书目录、真实任务库、社区共建四个视图的卡片。进入视口加 `.is-revealed` 并立即 `unobserve`；observe 前先把已在视口内的元素直接标记，避免首帧闪烁。
  3. 组件微交互——按钮、导航、卡片、链接的 hover/active/focus-visible 状态，统一走 token。
- **降级**：
  - `prefers-reduced-motion: reduce` 时，CSS 把三个时长 token 归零；JS 用 `matchMedia` 判定后不创建 observer、不包 `startViewTransition`。
  - 不支持 View Transitions 的浏览器（Safari 17 及更早）退化为一次性 `.view-enter` class 动画，与 VT 共用同一套 token。
  - 快速连续切路由时，新过渡调用旧过渡的 `skipTransition()`，避免动画排队堆积。

### 3.4 D 单元：缺陷收口

- **强制重排**：`renderChapter`（`paper.js:355-371`）当前在写完 DOM 后立即读 `getBoundingClientRect`。改为 DOM 写入结束后在一个 `requestAnimationFrame` 中统一读几何。
- **滚动读布局**：`updateProgress` 缓存 `article` 高度，仅在 resize 与章节切换时重算。
- **图片尺寸**：`scripts/build-content.py` 在构建期解析 webp/png 头部尺寸，为正文 `<img>` 写入 `width`/`height`；`check-site.mjs` 增加断言，要求每张 `article-image` 的尺寸与真实文件头部一致。章节首图（LCP 元素）去掉 `loading="lazy"` 并加 `fetchpriority="high"`，其余正文图保持 lazy——这一步与尺寸写入同在 `scripts/build-content.py`，不新增构建脚本。
- **写端点兜底**：`POST /api/chapters/{chapter}/entries`、`POST /api/wishes`、`POST /api/exercises/progress` 命中既有失效模式（`SQLITE_READONLY`／磁盘镜像类错误）时返回 `503` + `Retry-After: 2`，不再抛 500；其他异常路径不变。
- **前端重试与文案**：写失败时按 2 次退避重试（读者输入已确认在成功前不清空），仍失败才提示；`discussion.js`/`wishes.js`/`analytics-dashboard.js` 的 10 处 `error.message` 直贴改为按状态码映射中文文案，技术细节只进 `console`。
- **杂项**：补齐表单字段 `id`/`name`；删除未被引用的 `assets/app.js`。

---

## 4. 数据流与时序

**冷启动**：压缩后的 `index.html` 下发 → 14 个 CSS 仍阻塞（首屏样式）→ 22 个 `defer` 脚本按文档顺序在解析后执行 → 静态 hero 先绘制，FCP 不再等待 JS。章节页 LCP 由 JS 注入首图，故靠 `fetchpriority="high"` 与去 lazy 把 load delay 压到 80 ms 内。

**语言切换**：switcher → `MSI18N.load(code)` 注入两份语言资源 → `register()` → `notify()` → `paper.js:432` 回调以 `inPlace` 重跑路由。失败保持原语言并提示，不出现半中半英中间态。

**练习包**：路由命中 `#practice` → `ensureExerciseBundle()`（promise 缓存，幂等）→ 就绪后 `renderExerciseMap()`；未就绪时先渲染骨架与加载态。

**路由动效**：`route()` 的同步 DOM 变更被 `startViewTransition` 包裹，过渡只是包装层，不引入新状态机，因此不存在半切换状态；异常照常冒泡到既有处理。滚动保持 `instant`，视觉连续性由动效负责。

---

## 5. 验收指标

同一台服务器、同一 Chrome、禁缓存冷启动的实验室数值（无 CrUX 真实用户数据）。

| 指标 | 现状 | 目标 |
|---|---|---|
| 章节页 LCP | 387 ms | ≤ 300 ms |
| └ load delay | 245 ms | ≤ 80 ms |
| CLS | 0.05 | ≤ 0.01 |
| renderChapter 强制重排 | 65 ms（总 70 ms） | ≤ 10 ms |
| 首屏脚本+样式传输 | 36 个文件 / 5.03 MB 未压缩 | eager 集合 ≤ 1.0 MB 原始，压缩后 ≤ 0.35 MB |
| 二次访问请求数 | 57 | ≤ 10 |
| 控制台问题 | 1 类（2 处） | 0 |
| 路由过渡期长任务 | 未测（此前无动效） | 无 > 50 ms |

上表的"首屏脚本+样式传输"只统计 `<script>` 与 `<link rel=stylesheet>`，不含图片；图片体积单独在 LCP 的 load delay 一项里体现。

---

## 6. 测试策略

沿用现有测试形态，不新增依赖。

- **新增 `tests/test_static_delivery.py`**：JS/HTML 在 `Accept-Encoding: gzip` 下带 `Content-Encoding`；webp 为 `image/webp`；png/wasm **不**被压缩；版本化资源带 `immutable`；`/` 仍 `no-cache`、`/analytics` 仍 `no-store`。
- **新增 `tests/test_write_fallback.py`**：monkeypatch 使写语句抛 `SQLITE_READONLY` 形态异常，断言三个端点返回 503 + `Retry-After` 而非 500；正常路径状态码不变。
- **新增 `scripts/test-motion.cjs`**：静态断言 `motion.css` 的过渡只引用 token、只碰 `transform`/`opacity`；`prefers-reduced-motion` 块存在且把时长 token 归零；`index.html` 脚本全部 `defer` 且顺序不变。
- **新增 `scripts/test-asset-loading.cjs`**：用 `node:vm` + 手写 DOM 验证 `loadScript` 幂等、失败后清除 promise 缓存以允许重试、`ensureExerciseBundle` 重复调用不重复注入。
- **扩展 `scripts/check-site.mjs`**：每张 `article-image` 的 `width`/`height` 与真实文件头部尺寸一致。
- **扩展 `tests/discussion-browser.cjs`**：Playwright 以 `reducedMotion: 'reduce'` 运行，断言路由切换不产生 animation、控制台无 error、过渡后可见页正确；保留现有 `scrollWidth <= innerWidth` 与 `deepEqual(errors, [])` 断言。
- **回归底线**：123 项 pytest、全部 node 套件、`node scripts/check-site.mjs` 在本地与服务器均须全绿；服务器同步后源码哈希与本地逐文件一致。

---

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| `defer` 改变执行时机，依赖顶层 `window.*` 的脚本读到未就绪数据 | 已确认 0 内联脚本且 defer 保序；`renderChapter` 对 `window.katex` 已有存在性判断；node 顺序断言 + 浏览器 E2E 双重把关 |
| 按需注入语言包导致中途显示回退文案 | `load()` 完成前不 `notify()`，语言切换原子生效；失败保持原语言 |
| View Transitions 在旧浏览器不可用 | 特性检测 + class 动画退化，共用 token，两条路径同节奏 |
| 一年 `immutable` 缓存导致旧资源滞留 | 仅对 URL 带内容哈希的资源生效；哈希变即 URL 变 |
| 压缩大图浪费 CPU | 内容类型白名单，二进制类型直接跳过 |
| 构建期解析图片尺寸失败 | 解析不出尺寸时保持原标签不变，由 `check-site.mjs` 断言暴露缺口，不静默写错尺寸 |
