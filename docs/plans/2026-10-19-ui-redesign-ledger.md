# 全站主题重设计 — SILS（Super Intelligence Learning Space）

日期：2026-10-19 · 技能：fantastic-ui · 模式：recursive-polish（整站 sweep）

## Step 0 — Brief（一句话方向）

> **Super Intelligence Learning Space**：明亮活泼的学习平台——暖白大地 + 大胆近黑 band，
> 一枚软黄 accent 标记每一个动作与进度状态，人文主义字体，发丝线分隔不用阴影，
> 无渐变无玻璃拟态——产品本身就是仪器。

Preset 判定：用户方向词「活泼、明亮」+ 学习平台域 → **Campus Bright（Preset I）**
两条信号命中、无否决项（不奢侈、不克制、不 B2B 正式）。 adaptations：
product surface 而非 marketing page，故 band 交替用于首页，阅读区保持明亮安静，
`--invert` 暖近黑只给侧边栏/代码块/footer 强调带。

## 去 AI 味清单（本站原罪）

现行 `reading.css :root` 的 `--brand:#624aff` + `--cyan:#36cfd1` 紫青渐变体系：
- [ ] 紫→青渐变（进度条、h2 规则线、书封面、侧边栏 radial 光斑）
- [ ] 紫色玻璃拟态/辉光按钮（`box-shadow:0 8px 20px #7551d52a`）
- [ ] 均匀卡片网格 + 装饰性 icon 库用法
- [ ] 标题 letter-spacing 滥用与渐变文字
- [ ] 玻璃拟态 backdrop-filter 装饰性使用

## 现行 token 体系（prior art，Phase B  reconcile）

权威定义在 `assets/reading.css:2`：`--brand/--brand-hover/--selected/--surface/
--heading/--text/--muted/--border`，并把 `--purple/--violet/--violet-bright/--cyan/
--ink/--rule` 别名收敛过去。`paper.css:1` 与 `styles.css:1` 各有 :root 但多数被
reading.css 后者居上 shadow（唯一独有存活值：`--sidebar-width:270px`）。
**决策：保留全部语义 token 名，只换值；紫名（--purple/--violet/--violet-bright/
--cyan）全退役，文字角色拆出 `--brand-ink`。**

## 曲面清单（Phase A — 递归遍历）

| # | 曲面 | 类型 | 载体 | 硬编码色 | 状态 |
|---|---|---|---|---|---|
| 1 | token 基座 | shared-primitive | styles.css/paper.css/reading.css :root | — | not-audited |
| 2 | reader 布局+侧边栏+文章排版 | route-shared | styles.css | 89 | not-audited |
| 3 | header/hero/banner/footer/paths | route-shared | paper.css | 132 | not-audited |
| 4 | reader 侧栏+搜索对话框 | panel/overlay | reader-tools.css | 67 | not-audited |
| 5a | 阅读注释层 | route-shared | reading.css | 23 | not-audited |
| 5b | 客户端反馈修订 | route-shared | review.css | 12 | not-audited |
| 5c | 练习面板+学习地图（SILS） | panel | exercise.css | 14 | not-audited |
| 5d | 讨论 | panel | discussion.css | 10 | not-audited |
| 5e | 愿望清单 | panel | wishes.css | 2 | not-audited |
| 5f | 导航 | shared | navigation.css | 2 | not-audited |
| 5g | 首页补充 | route | homepage.css | 2 | not-audited |
| 5h | 贡献者墙 | route | contributors/wall.css | 1 | not-audited |
| 5i | i18n 专用 | shared | i18n.css | 10 | not-audited |
| 6 | analytics 页 | route | analytics.css + analytics.html | 30 | not-audited |
| 7 | 品牌字样（chrome） | shared | index.html/app.py/locale×3 | — | not-audited |

视图路由（hash SPA）：home / contents / paths / practice / contribute / reader(+SILS 面板)；
覆盖层：siteMenu、bookSearch、tocDialog、language-switcher、account area、image viewer。
`home.css`、`home/fonts.css`、`community.css` 无加载方（死代码，不纳入）。

## 新色板（Campus Bright adapted，暖化）

| 角色 | 值 | 用途 |
|---|---|---|
| --canvas | #faf7ef | 页面底（暖纸） |
| --surface | #f5f1e6 | 嵌套面板/输入井 |
| --paper | #ffffff | 卡片/文章 |
| --invert | #221e16 | 暖近黑：侧边栏/代码块/强调带 |
| --hair / --hair-lit | #e7e0cd / #d3c9ad | 发丝线 |
| --ink / --heading | #221e16 | 主文字 |
| --text | #3b362a | 正文 |
| --muted | #6f6a58 | 次要（仅 captions） |
| --brand | #f7c13b | 软黄 FILL（按钮/进度/选中条） |
| --on-brand | #221e16 | 黄底上的字（10.3:1） |
| --brand-ink | #8a580c | 琥珀色文字/图标/链接（浅底） |
| --selected | #fbf0cd | 选中/悬停暖黄淡化 |
| --up / --down | #2f7d52 / #b3382c | 语义：通过/失败 |

## 批次计划

- B1（T1+T2+T3）：token 基座 + styles.css + paper.css — 共享 primitive 先行
- B2（T4+T5）：reader-tools + 其余 9 文件
- B3（T6+T7）：analytics + 品牌更名
- B4（T8）：验证 + 一致性门 + 机械证明
