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

| 指标 | 优化前（生产，旧代码） | 优化后（本地） | 目标 | 结论 |
|---|---|---|---|---|
| 章节页 LCP | 387 ms | **226 ms** | ≤ 300 ms | 达标 |
| └ load delay | 245 ms | **57 ms** | ≤ 80 ms | 达标 |
| CLS | 0.05 | **0.00** | ≤ 0.01 | 达标 |
| 强制同步布局（全页） | 70 ms（`renderChapter` 65 ms） | **0 ms**（DevTools 报告 “no problems”） | ≤ 10 ms | 达标 |
| 首屏阻塞文件数 | 36 | **18**（3 eager 脚本 + 15 样式） | — | 达标 |
| 首屏脚本+样式原始体积 | 5,026,084 B | **1,078,015 B（1052.7 KB）** | ≤ 1024 KB | **未达标，超 2.8%** |
| 首屏脚本+样式压缩后传输 | 无压缩，5,026,084 B | **328,509 B（320.8 KB）** | ≤ 0.35 MB | 达标 |
| 二次访问请求数 | 57 | 待生产复核（静态资源已 `immutable`） | ≤ 10 | 待复核 |
| 控制台问题 | 1 类（表单缺 id/name ×2） | 0 | 0 | 达标 |

### 未达标项说明

首屏 eager 原始体积 1052.7 KB，比 1024 KB 目标多 28.7 KB（2.8%）。原因有两条，均为达标项换来的：

1. Task 3 给 380 张正文图片写入 `width`/`height`，`assets/content.js` 从 893,138 B 增至 904,864 B（+11.7 KB），换来 CLS 0.05 → 0.00；
2. 新增 `assets/motion.css`（2,490 B）与 `assets/motion.js`（约 4 KB，defer）属于动效层本身。

压缩后传输 320.8 KB，仍在 0.35 MB 预算内，实际网络成本未超。

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
