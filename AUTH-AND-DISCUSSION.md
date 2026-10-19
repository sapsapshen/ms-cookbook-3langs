# 魔搭登录、划线与评论

## 功能与可见性

- 游客可阅读正文、公开划线评论与章节留言。
- 登录后可选中同一段落内最多 2000 字：保存仅自己可见的划线，或发表公开想法。
- 章节末尾可留言，按最新优先显示；支持加载更多。点击引用可回到原文。
- 作者可删除自己的记录。`MODERATOR_SUBS` 可配置管理员的 OIDC sub（逗号分隔），管理员可删除公开内容。
- 原文变更后先校验段落、偏移和引用；无法唯一匹配时保留笔记并提示无法定位，不把划线错误应用到其他文字。

## 本地运行

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
APP_BASE_URL=http://127.0.0.1:7860 .venv/bin/uvicorn app:app --host 127.0.0.1 --port 7860 --no-access-log
```

访问 http://127.0.0.1:7860 。原来的静态 HTTP 服务不提供 `/api`，不能用于登录和评论。

默认评论与账号数据保存在 `.data/reading.sqlite3`，访问统计保存在独立的 `.data/analytics.sqlite3`，密钥保存在 `.data/session.key`；这些文件均被 Git 忽略。
没有 OAuth 配置时明确显示登录待开启，不提供伪造的演示登录。
本地真实 OAuth 需创建允许本地回调的互联应用，设置以下环境变量（不要把密钥写入 Git）：

- `OAUTH_CLIENT_ID`
- `OAUTH_CLIENT_SECRET`
- `OPENID_PROVIDER_URL=https://www.modelscope.cn`
- `APP_BASE_URL=http://127.0.0.1:7860`
- 回调地址：`http://127.0.0.1:7860/auth/callback`

## 创空间部署

依据官方文档 https://www.modelscope.cn/docs/studios/oauth ：Static 不支持内置 OAuth。
本版本需要 Docker 创空间（平台要求已绑定阿里云账号并完成实名认证）。
在现有创空间设置中将部署类型调整为 Docker，启用 OAuth，仅勾选 `openid profile`，然后部署本版本。
平台自动注入 `OAUTH_CLIENT_ID`、`OAUTH_CLIENT_SECRET`、`OPENID_PROVIDER_URL`、`OAUTH_SCOPES`、`STUDIO_HOST`。
线上回调为 `https://<STUDIO_HOST>/auth/callback`；如果使用独立应用则显式配置 `APP_BASE_URL` 和对应回调。

Docker 监听 7860，持久化数据目录固定为 `/mnt/workspace/purplebook`。创空间通过 `ossfs` 挂载该目录，访问统计的 SQLite 运行库位于容器本地磁盘，并定期生成一致性快照保存到持久化目录；同时保留上一版快照作为恢复点。请备份持久化目录，不要启用多个应用副本共同写入这些数据。
更换域名后需更新 OAuth 回调。创空间 iframe 的第三方 Cookie 受浏览器限制，因此登录在新窗口完成，并在该独立页面继续阅读和评论。

部署脚本已改为要求 Docker，拒绝把带后端的版本发布成 Static。GitHub Action 会先跑 API 测试再发布。
当前实现不会自动更改线上创空间设置，也不会把本地未提交的改动推送到线上。

## 访问统计

网站会按逻辑页面记录匿名 PV 和 UV，首页、目录、阅读路径、真实任务库、社区页和每一章分别统计。访客标识由浏览器随机生成，服务端只保存经过 HMAC 处理的哈希，不关联魔搭账号、姓名或评论数据。统计日期使用 `Asia/Shanghai`，区间查询使用最近 180 天的每日访客记录，累计 UV 通过独立去重表持续保存。全站小时 PV/UV 从功能启用后开始记录，小时明细保留最近 90 天；同一访客在每个小时内分别去重，所选日期的 UV 按全天访客去重。统计库运行在本地文件系统，持久化层保存当前与上一版完整快照；检测到运行库损坏时优先从快照恢复，并保留带时间戳的故障副本。

统计页面位于 `/analytics`，打开后直接显示累计、今日、每小时和所选时间范围的数据。小时视图支持今天、昨天和最近 90 天内的指定日期。今日指标每日 0 点重新计算，近 N 天指标使用滚动窗口，累计指标从有效统计数据的首日持续增长。该地址不放入读者页面的公开导航，知道固定网址即可访问。统计接口只提供聚合后的只读数据。

## 练习与进度数据

- 游客练习进度只存在浏览器本地存储（键名 `ms-cookbook.exercise.v1`），不上传。换浏览器或清理站点数据即丢失。
- 登录后进度会同步到服务端 `.data/reading.sqlite3` 的 `exercise_progress` 表，用于跨设备继续学习。同一账号在另一台设备登录后会拉回这些记录。
- 同步只上传题目 id、所属章节、是否通过、通过率、尝试次数和你写的代码（单条上限 20000 字符）。请不要在练习代码里写入生产密钥或个人信息——它会随进度一起存到服务端，评论区的删除权限不覆盖这张表。
- 服务端只按 `updated` 时间戳合并，取较新的一条；通过状态与分数是单调的（只升不降），避免一次旧快照把已通过的题改回未通过。
- 练习代码在读者自己的浏览器内的 Pyodide 沙箱中执行，没有任何服务端执行。真实边界是：没有网络访问、没有子进程，也没有通往宿主文件系统的路——**内存文件系统（MEMFS）本身是可写的**，`open('/tmp/x', 'w')` 会成功，但没有挂载 NODEFS，所以写入只存在于 worker 的内存里，随 worker 一起销毁，真实磁盘与本地文件都不会被碰到。因此练习无法安装第三方包，也无法读取或覆盖你的本地文件。完整的边界说明（含 JS 逃逸路径的封闭方式）见 `assets/exercise-worker.js` 的头部注释。
- `EXERCISE_LLM_KEY` 与 `EXERCISE_LLM_BASE_URL` 均为可选项。未配置时，开放题只展示参考答案与自评，不做自动评分。

## 练习评分的配额

`POST /api/exercises/grade` 是本站唯一按调用付费的公开端点，因此自带上限。以下是运维需要知道的事实，全部经过实测。

**未配置 `EXERCISE_LLM_KEY` / `EXERCISE_LLM_BASE_URL` 时**：端点直接返回 `503` + `fallback: true`，**不调用模型、不产生任何费用**。但它仍然会写入调用账本——判定发生在读取 Key 之前，所以未启用的部署同样按下面的额度计数，30 次/60 秒后开始返回限流形态的 `503`。两种 `503` 的响应体完全相同（都带 `fallback: true` 和 `x-sils-fallback: 1`），客户端不需要区分。

**配置后**，额度按身份分桶，**每个桶 30 次/60 秒**：

- **登录读者**按账号计（`user:` + 读者 ID 的 HMAC-SHA256 哈希）。
- **游客**按来源地址计（`address:` + 客户端地址的 HMAC-SHA256 哈希）。地址不满足「拦住一个脚本」的粒度：一间教室、一个公司或一个运营商 NAT 后面的大量读者会共用一个额度。登录读者有能穿过 NAT 的身份，所以以身份为准；游客没有身份，只能以地址为准，这会**少算**共享出口的游客而不是多算，对他人账单的封顶来说是安全的方向。

**因此单一身份或单一地址的实际上限是 60 次/60 秒**：用满账号额度后脱掉 cookie 会落入访客桶，两个桶各自独立、各 30 次。哈希的原料带 `user:` / `address:` 前缀，所以一个 `user_id` 恰好等于某个地址字符串时两个桶不会撞在一起。

**触发限流返回 `503` + `fallback: true`**，与「未启用」「上游故障」同形，客户端只需一条降级代码路径。被拒的调用**记入账本但不计入额度**：记是为了让并发下上限真的守得住（不记账的话被拒者可以立刻重试并被拿去和同一批行比较），不再次计费是因为判定发生在 `httpx.post` **之前**，被拒不调模型。一次没记账的调用就是一次没计费的调用，而这正是这个账本存在的唯一理由。

**账本与配额的关系**：`exercise_grade_calls` 记录窗口内的**尝试**（含被拒），额度上限 30 约束的是端点会**尝试**多少次，上游调用次数约束的是它会**花费**多少。这两个数字不是同一个：`outcome='graded'` 的行数应当跟随账单走，`unavailable` 说明上游故障，`refused` 是限流。剪枝在写入的同一个事务里完成，表不会无界增长。审计表**不存答案、不存评分标准**——它是成本与滥用账本，不是读者提交内容的副本。

## 已知问题：Windows 高并发下的 SQLite 写竞争（既有问题，未修）

`POST /api/chapters/{chapter}/entries`、`POST /api/wishes`、`POST /api/exercises/progress` 这三个写端点在 **Windows + 高并发**下偶发返回 `500`。

原因是 **`SQLITE_READONLY`，不是 `SQLITE_BUSY`**：WAL + 短生命周期连接的竞争（`-shm` 需要至少一个长连接常驻），而不是锁竞争。因此连接上的 `timeout=15` **不生效**，写语句立即失败。隔离复现确认与业务逻辑无关。

**这是既有问题，与评分端点的改动无关。** 评分端点（`POST /api/exercises/grade`）已针对同一失败模式做了兜底：claim（记账）失败时降级为 `503` + `fallback: true` 且不调用模型，settle（结算）失败时记日志不抛出——读者已经拿到分数，一次记账写失败不能变成 500。**上面三个端点没有这层兜底，仍可能返回 500。当前状态：未修。**

真正的修法是消除短生命周期连接（WAL 的 `-shm` 需要常驻连接），那会改变「一次操作一个连接」的既有约定，需要单独决策。短期缓解手段是降低这些端点的并发写入压力（部署侧限流或错峰）。

## 身份与安全

使用 Authlib 完成 OIDC state、nonce、签名及身份校验。Cookie 中只保存随机服务端会话 ID、CSRF 与短期授权事务；不保存访问令牌。
数据库保存随机用户 ID、OIDC sub、显示名称和评论；用户 ID 只取自验证后的服务端身份。退出时撤销服务端会话。
写操作要求有效登录、同源 Origin 和 CSRF token。写端点各自计配额，窗口都是 60 秒：划线与章节留言 `POST /api/chapters/{chapter}/entries` 与 `POST /api/wishes` 每位用户每分钟 10 次与 5 次，练习进度 `POST /api/exercises/progress` 每位用户每分钟 20 次；练习评分 `POST /api/exercises/grade` 是另一套额度，见上一节。空批次不算写入（读者从未做过练习时不会因此被拒）。静态文件仅通过显式允许的目录提供，源代码、数据库、密钥不会作为静态文件暴露。
前端通过 textContent 渲染用户内容，拒绝将评论作为 HTML 执行。
生产会话使用 HTTPS Secure、HttpOnly、SameSite=Lax Cookie。

## 验证

```sh
.venv/bin/pip install pytest
.venv/bin/python -m pytest tests -q
node --check assets/discussion.js
node scripts/check-site.mjs
```

测试覆盖游客写入拒绝、CSRF、私人划线隔离、所有权删除、持久化重启、分页、频率限制、退出撤销、静态文件隔离、OAuth 非法 state，以及模拟已验证身份后的会话建立。
真实魔搭授权回跳必须在配置合法 OAuth 应用后联调；模拟提供方测试不等同真实 OAuth 登录验收。

浏览器端到端验证（安装 Playwright 后）：

```sh
node tests/discussion-browser.cjs
# 使用本机 Edge 时：PLAYWRIGHT_CHANNEL=msedge node tests/discussion-browser.cjs
```

该验证会启动 7861 端口的隔离测试服务并生成测试会话，仅写入临时目录；结束后清理，不往真实评论库写入测试内容。

创空间提供方兼容：认证发现固定使用 `https://www.modelscope.cn/.well-known/openid-configuration`，避免平台内部提供方别名触发地址白名单或浏览器跳转问题。客户端 ID 和密钥仍取自平台注入。
