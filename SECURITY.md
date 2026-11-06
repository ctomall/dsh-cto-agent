# 安全契约

> 一句话：**凡是把数据发出去的端点，都必须过租户闸门**——包括 SSE、下载、错误信息。

## 信任边界

| 层 | 谁在守 | 说明 |
|---|---|---|
| 边缘 | Cloudflare（**未配置**） | 当前未启用 CF Access，边缘访问控制待补（见 HANDOFF ③） |
| 应用身份 | `APP_PASSWORD` → HMAC Cookie | 单口令部署时，Cookie 通过即映射 `GATE_TENANT`/`GATE_USER` |
| 租户身份 | `Bearer` token → `{tenantId,userId}` | 多租户正路；Cookie 与 Bearer 二选一 |
| 资源归属 | `runs.tenant_id` / `sessions.tenant_id` | 跨租户**一律 404**（不区分越权与不存在，避免探测） |

## 端点规则（新增端点必须对照）

1. **GET 资源**：先解析身份 → 再按 `tenant_id + 资源 id` 查 → 查不到返回 404
2. **POST 变更**：同上，且 Cookie 身份下必须过 CSRF 同源校验（`sec-fetch-site` 非 `same-origin` → 403）
3. **SSE / 流式**：与普通 GET 同样校验（`/api/runs/:id/events` 曾因此漏过，v64 修复）
4. **文件下载**：校验 run 归属 + `path.resolve` 后必须仍在工作区目录内（防路径穿越）
5. **全局运维端点**（`/metrics`、`/api/admin/upgrade`）：只认 Cookie 或专用 token，不认租户 token

## 已有闸门与证据

| 项 | 位置 | 证据 |
|---|---|---|
| 租户矩阵（8 个 GET + 2 个 POST 跨租户 404） | `impl/test/tenant-matrix.test.mjs` | `node --test` |
| 事件流隔离 | `impl/src/server.mjs` SSE 段 | 同左 |
| 路径穿越 400 | `impl/test/artifacts.test.mjs` | 同左 |
| CSRF 403 | `impl/test/gate-cookie.test.mjs` | 同左 |
| Cookie 三件套（HttpOnly/SameSite/Secure） | `impl/src/gate.mjs` | 同左 |
| 升级接口鉴权四口径 | `impl/test/upgrade-auth.test.mjs` | 同左 |
| 密钥不入库 | `scripts/secret-scan.sh` | 运行 exit 0 |

## 已知缺口

- **未启用 Cloudflare Access**：公网入口只有应用层口令门
- **Cookie 身份映射到固定租户**（`GATE_TENANT`，默认 `t_a`）：单口令部署的固有简化，多租户必须走 Bearer
- ~~无审计查询接口~~ → 已补 `GET /api/audit?limit=50`（租户内只读，倒序，上限 200；跨租户天然隔离）

## v66–v68 新增闸门

| 项 | 位置 | 说明 |
|---|---|---|
| 限流不可伪造 | `impl/src/ratelimit.mjs` | 仅回环/`TRUSTED_PROXIES` 可信 `cf-connecting-ip` 与 `x-forwarded-for`；直连用 socket 地址 |
| 限流键上限 | 同上 | 默认 10k，淘汰过期键，防伪造来源造成内存增长 |
| 请求体上限 | `impl/src/server.mjs` | `content-length > MAX_BODY_BYTES`（默认 1 MiB）→ 413 |
| 工具沙箱按真实路径 | `impl/src/tools.mjs` | `realpath` 校验目录，挡符号链接逃逸 |
| 升级 token 常量时间比较 | `impl/src/upgrade.mjs` | `timingSafeEqual`，避免时间侧信道 |
| 表名白名单 | `impl/src/backup.mjs` | `countTables` 只接受已知表名，杜绝拼接 |

## 代码级安全自查（v145，2026-11-06）

| 检查项 | 做法 | 结论 |
|---|---|---|
| SQL 注入 | 全部业务查询用参数绑定；仅 `pragma`/`VACUUM INTO` 与**表名**拼接 | 表名走白名单常量（`TABLES` / `KEY_TABLES`），`VACUUM INTO` 路径由服务端生成并转义单引号 |
| 命令执行 | 仅升级用 `execFile('git'…)`、`execFile('node'…)`（数组参数、无 shell） | 无 `eval` / `new Function` / `shell:true` |
| 路径穿越 | 产物路由 `resolve` + 「必须位于 run 工作区内」前缀校验；工具侧 `realpath` 防符号链接逃逸 | 已有用例覆盖 |
| 响应头注入 | 产物文件名做白名单替换（`[^\w.\-\u4e00-\u9fa5]` → `_`） | 防引号/换行破坏 `Content-Disposition` |
| 同源脚本执行 | 产物 `?inline=1` 仅对安全类型内联；html/svg/xml 永远 `attachment` + `nosniff` | 浏览器级实测：脚本未执行、触发下载 |
| 开放重定向 | 重定向目标均为固定路径（`/`、`/login`、`/?sid=…`） | 无外部 URL 注入点 |
| CSRF | 非 GET 请求校验 `sec-fetch-site: same-origin` | 已有用例覆盖 |
| 密钥泄漏 | `/api/settings` 断言不出现真实密钥**值**（非关键词） | 用例 + 生产抽查 0 命中 |
