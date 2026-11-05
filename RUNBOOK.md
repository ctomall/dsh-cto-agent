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

## 2.5 数据与备份

- 库文件：`/var/lib/cube-agent/cube.db`（WAL 模式，同目录 `-wal`/`-shm`）
- 备份：`sqlite3 /var/lib/cube-agent/cube.db ".backup '/var/lib/cube-agent/backup-$(date +%F).db'"`
- 恢复：停服 → 用备份覆盖 `cube.db` → 删 `-wal`/`-shm` → 起服
- 已验证：新建会话 → 重启服务 → 会话仍在

## 3. 故障演练（每季度至少一次）

| 演练 | 操作 | 期望 |
|---|---|---|
| 服务崩溃 | `sudo systemctl kill -s SIGKILL cube-agent.service` | 3s 内被 `Restart=always` 拉起，`/healthz` 200 |
| 坏版本升级 | 上游提交一个失败测试 → `scripts/upgrade.sh` | exit 5，HEAD 回到 before，工作区干净 |
| 模型未接通 | 清空 `MODEL_*` | `model_real 0`，`/api/model/status` 的 `real:false`，`model-doctor` exit 2 |
| 限流失效 | 连打 `/api/version` 65 次 | 第 61 次 429 + `retry-after` |
| 身份门失效 | 无 Cookie 访问 `/api/sessions` | 401；访问 `/` → 302 `/login` |

## 3.5 公网延迟与抖动（已知问题）

现象：`https://cto.ila3.top` 单请求 1.4–20s，偶发 `000`（超时）；本机 `127.0.0.1:8787` **0.4ms**。

实测定位（2026-11-05）：

| 指标 | 值 | 说明 |
|---|---|---|
| 本机 healthz | 0.0004s | 应用不是瓶颈 |
| 出网到 Cloudflare 边缘 | tcp 0.26s / tls 0.53s | 链路 RTT 偏高 |
| IPv6 出网 | **失败** | `curl -6` 直接 000 |
| 1.1.1.1:443 | 不可达 | 出网受限 |
| TCP 重传率 | ~0.86%（`TcpRetransSegs/TcpOutSegs`） | 有丢包 |
| 隧道 QUIC RTT | ~271ms，有 buffered packets | 抖动来源 |

已做的调整：`/etc/cloudflared/cto.yml` 增加 `edge-ip-version: "4"`（避免向不可用的 IPv6 反复尝试），`protocol: quic`。
效果：中位数从 ~4.8s 降到 1.4–2.8s（多次采样波动），**但超时仍会发生**——属链路层问题，本机无法根治。

运维影响：**验收与巡检固定走本机**（`scripts/acceptance.sh http://127.0.0.1:8787`）；公网只做“可达性”抽查，不作为判定依据。

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
| 数据备份 | 未自动化 | SQLite 已落盘 `/var/lib/cube-agent/cube.db`（WAL），但无定时备份/恢复演练 |
