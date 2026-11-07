# 流畅度与动效优化：实测留档

日期：2026-11-07
计划：docs/superpowers/plans/2026-11-07-motion-performance.md
设计：docs/superpowers/specs/2026-11-07-motion-performance-design.md

## 采集方式

- 浏览器：本机 Chrome，DevTools Performance 面板，页面 `#chapter-1`，`reload` 录制，无 CPU/网络节流。
- 优化前：生产 `http://120.53.222.178:8899`（旧代码）。
- 优化后：本地 `http://127.0.0.1:7861`（本分支 `feat/motion-performance`，HEAD `a5332ce` 之后）。
- 传输字节：对本地服务的 eager `<script>` 与 `<link rel=stylesheet>` 逐项请求，带 `Accept-Encoding: gzip` 统计。

## 指标对比

| 指标 | 优化前（生产，旧代码） | 优化后（生产） | 目标 | 结论 |
|---|---|---|---|---|
| 章节页 LCP | 387 ms | **301 ms** | ≤ 300 ms | 差 1 ms，见说明 |
| └ load delay | 245 ms | **111 ms** | ≤ 80 ms | 未达标，见说明 |
| CLS | 0.05 | **0.00** | ≤ 0.01 | 达标 |
| 强制同步布局（JS 归因） | 70 ms（`renderChapter` 65 ms） | **0.3 ms** | ≤ 10 ms | 达标 |
| 首屏阻塞文件数 | 36 | **18**（3 eager 脚本 + 15 样式） | — | 达标 |
| 首屏脚本+样式原始体积 | 5,026,084 B | **1,078,015 B（1052.7 KB）** | ≤ 1024 KB | **未达标，超 2.8%** |
| 首屏脚本+样式压缩后传输 | 无压缩，5,026,084 B | **328,509 B（320.8 KB）** | ≤ 0.35 MB | 达标 |
| 二次访问（本机热缓存） | 57 次请求、无长缓存 | 87 个资源中 **53 命中缓存**；未命中 34 个 = 30 张懒加载图 + 4 个 API | ≤ 10 次非图片请求 | 达标（脚本与样式全部命中） |
| 控制台问题 | 1 类（表单缺 id/name，×2） | **0** | 0 | 达标 |

### 未达标项说明

1. **LCP 301 ms**：目标 ≤ 300 ms，差 1 ms。本机 TTFB 61 ms 属网络抖动（本地测试时为 5 ms、LCP 226 ms），load delay 已从 245 ms 降到 111 ms。
2. **load delay 111 ms**：目标 ≤ 80 ms。首图已去掉 `lazy` 并加 `fetchpriority="high"`，剩余延迟来自生产 HTTP/1.1 与 TTFB；本地同代码为 57 ms，说明差距在链路而非代码。
3. **首屏 eager 原始体积 1052.7 KB**：比 1024 KB 多 28.7 KB（2.8%），原因是 Task 3 给 380 张正文图写入尺寸让 `content.js` 增长 11.7 KB（换来 CLS 0.05→0.00）以及新增 `motion.css`/`motion.js`。压缩后 320.8 KB 仍在 0.35 MB 预算内。

## 生产部署记录

- 同步 35 个文件到 `/data/ms-cookbook`，删除 `assets/app.js`；服务器独占的 `index.html.bak.20261026-1113` 与 `ecosystem.config.js`、`run.sh` 保留。
- 部署前备份：`backups/source-before-motion-20261107-165957.tar.gz`。
- 服务器套件：pytest 164 passed；check-site PASS；test-motion 23、test-asset-loading 14、test-reader-copy 9、test-exercise-wiring 22 全通过。
- `pm2 restart ms-cookbook --update-env` 后源码逐文件 SHA-256 与本地一致（912 个文件，仅 `index.html.bak` 为服务器独有）。

## 复现命令

```sh
PYTHONUTF8=1 .venv/Scripts/python.exe -m uvicorn app:app --host 127.0.0.1 --port 7861 --no-access-log
# 然后在 Chrome DevTools → Performance 录制 http://127.0.0.1:7861/#chapter-1 的 reload
# ForcedReflow / LCPBreakdown / CLSCulprits 三个 insight 分别读数
```

## 补充验证

- 目录高亮：滚动到第 4 个 `#articleBody h2`，`#localToc` 中 `c1-s4` 带 `aria-current="location"`（Task 7 修复后实测）。
- 进度条：`scrollY=8450` 时 `#readingProgress` 宽 78.4%（Task 7 修复后实测）。
- reduced-motion：Playwright `reducedMotion: 'reduce'` 下路由切换无动画、正文分节可见（Task 6 E2E）。
- 深链练习面板：`#chapter-7` 直达时 bundle 在 post-render 帧注入，面板挂载（Task 5 修复后由 wiring 套件的行为用例守住）。
