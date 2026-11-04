# cube-agent 运维手册（RUNBOOK）

线上地址：https://cto.ila3.top ｜ 仓库：ctomall/dsh-cto-agent ｜ 主机：/home/pro/dsh/cube-agent

## 0. 先看三个点（30 秒定位）

```bash
curl -s https://cto.ila3.top/healthz                 # {"ok":true,"driver":"fake|openai:..."}
curl -s https://cto.ila3.top/api/version             # 线上运行代码的 SHA
systemctl is-active cube-agent.service cloudflared-cto.service
```

指标（需登录）：`/metrics` — `model_real`、`runs_created_total`、`rate_limited_total`、`login_failures_total`。

## 1. 常见故障与处置

| 现象 | 判据 | 处置 | 复验 |
|---|---|---|---|
| 页面 502/000 | `systemctl is-active` 非 active | `sudo systemctl restart cube-agent.service` | `/healthz` 200 |
| 页面 302 到登录，但口令不对 | 日志无报错，`login_failures_total` 增长 | 从 `/etc/cube-agent/env` 取 `APP_PASSWORD` | 登录后 `/` 200 |
| 全员 401 | 运行时 token 变了 | 看 `/etc/cube-agent/env` 的 `CUBE_TOKENS` | `curl -H "Authorization: Bearer <token>" .../api/me` |
| 429 频繁 | `/metrics` 里 `rate_limited_total` | 确认来源 IP；必要时调 `LIMITS` | 等待窗口滑过 |
| 域名 404 | `cloudflared-cto.service` 挂 或 DNS 指错隧道 | `cloudflared tunnel route dns --overwrite-dns <uuid> cto.ila3.top` | 公网 `/healthz` 200 |
| 升级后功能全失效 | `/api/version` ≠ `git HEAD` | 进程没重启：`systemctl restart` | 版本一致 |
| 模型是假的 | `/metrics` 里 `model_real 0` | 配 `MODEL_*`，跑 `node scripts/model-doctor.mjs --probe` | `model_real 1` |

## 2. 升级与回滚

```bash
scripts/upgrade.sh --check      # 只看差多少
scripts/upgrade.sh              # 拉取 → 跑全量测试 → 重启 → 等 /healthz
# 测试失败 → exit 5（已自动 git reset --hard 回滚）
# 健康检查失败 → exit 6（已回滚并重启）
```

手工回滚：`git reset --hard <before> && sudo systemctl restart cube-agent.service`。

## 3. 故障演练（每季度至少一次）

| 演练 | 操作 | 期望 |
|---|---|---|
| 服务崩溃 | `sudo systemctl kill -s SIGKILL cube-agent.service` | 3s 内被 `Restart=always` 拉起，`/healthz` 200 |
| 坏版本升级 | 上游提交一个失败测试 → `scripts/upgrade.sh` | exit 5，HEAD 回到 before，工作区干净 |
| 模型未接通 | 清空 `MODEL_*` | `model_real 0`，`/api/model/status` 的 `real:false`，`model-doctor` exit 2 |
| 限流失效 | 连打 `/api/version` 65 次 | 第 61 次 429 + `retry-after` |
| 身份门失效 | 无 Cookie 访问 `/api/sessions` | 401；访问 `/` → 302 `/login` |

## 4. 上线前检查清单

- [ ] `node --test impl/test/*.test.mjs` 全绿
- [ ] `./scripts/acceptance.sh --require-all` 无非预期 SKIP
- [ ] `/api/version` == `git rev-parse --short HEAD`
- [ ] `.runtime-tokens` / `.runtime-app-password` 未入库（`git ls-files | grep runtime` 为空）
- [ ] `/etc/cube-agent/env` 权限 600

## 5. 已知缺口（如实记录）

| 项 | 状态 | 影响 |
|---|---|---|
| Cloudflare Access | **未配置**（缺 `CLOUDFLARE_API_TOKEN` / `CF_ACCOUNT_ID` / `CF_ZONE_ID`） | 挡人的是应用层口令门，不是 CF 身份层 |
| 真实模型 | **未接通**（缺 `MODEL_*`） | 线上 `driver: fake`，事件序列由假模型决策 |
| 数据持久化 | 内存 SQLite | 重启即丢数据 |
