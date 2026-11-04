# dsh-cto-agent（实现侧）

《Cube Agent 类产品重建提示词》的实现仓库。规格文档在 `../cube-agent-rebuild-prompt-v10.md`（不进本仓库，属产品文档）。

## 当前状态

| 能力 | 状态 | 证据 |
|---|---|---|
| 租户隔离 Gateway | ✅ 可运行 | `test/tenant-isolation.test.mjs` 8/8 |
| run 状态机 + 事件日志 | ✅ 可运行 | `test/sse-resume.test.mjs` 8/8 |
| SSE 断线续传（`Last-Event-ID`） | ✅ 回放式 | 同上（实时推送未做） |
| 真实 dsh 插件加载 | ✅ 已验证（桩服务下） | `spike-c2.mjs` → `C2_PASS` |
| 前端 / 真实 agent loop / 审批 UI | ❌ 未开始 | — |

## 目录

```
impl/src/
  db.mjs        SQLite 表结构与双租户种子数据
  context.mjs   token → RequestContext（401 只表达无身份）
  server.mjs    Gateway 路由（租户过滤 + 越权 404 + 审计）
  events.mjs    事件日志（run 内单调 seq，先落库后发送）
  runs.mjs      run 状态机（非法迁移抛错）
  sse.mjs       SSE 帧与 Last-Event-ID 续传
impl/test/      16 条用例
impl/services/  最小 service 桩（诊断用，非产品代码）
deploy/         systemd 单元
scripts/        一键在线升级
```

## 快速开始

```bash
node impl/src/server.mjs            # 默认 8787，可用 PORT 覆盖
curl -H 'Authorization: Bearer tok_a' http://127.0.0.1:8787/api/me
curl -H 'Authorization: Bearer tok_a' http://127.0.0.1:8787/api/sessions/s_b1   # 期望 404
```

## 测试

```bash
node --test impl/test/tenant-isolation.test.mjs impl/test/sse-resume.test.mjs
```

## 一键在线升级

```bash
scripts/upgrade.sh --check   # 只看有没有新版本，不动手
scripts/upgrade.sh           # 拉取 → 跑测试 → 重启服务
```

前置：远程已配置（`origin`）、当前分支为 `main`、服务由 `cube-agent.service` 托管。

## HTTP 一键在线升级

```bash
CUBE_UPGRADE_TOKEN=<你的口令> node impl/src/server.mjs

curl -X POST -H "x-upgrade-token: <你的口令>" http://127.0.0.1:8787/api/admin/upgrade
```

返回：`{ ok, upToDate, before, after, behind, tests }`。

| 情况 | 响应 |
|---|---|
| 未配置 `CUBE_UPGRADE_TOKEN` | **503** `upgrade_disabled`（默认关闭，fail-closed） |
| token 缺失/错误 | **401** `unauthenticated` |
| 工作区有未提交改动 | **409** `dirty_worktree`（不覆盖本地） |
| 已有升级在进行 | **409** `upgrade_in_progress`（单飞锁） |
| 远程不可达 | **502** `fetch_failed` |

只执行 `git fetch` + `git pull --ff-only`，**不执行** `reset --hard` / `clean`。

## 远程仓库

> 本地目录名保留为 `cube-agent`（历史原因），**远程仓库名使用 `cto`**：`dsh-cto-agent`。

```bash
git remote add origin git@github.com:ctomall/dsh-cto-agent.git
git push -u origin main
```

## 演练

- 2026-11-04 18:31:47：HTTP 触发 ff-only 升级演练
