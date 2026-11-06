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

## 发布前自查：密钥不入库

```bash
./scripts/secret-scan.sh      # exit 0 才可发布
```

检查三件事：运行期密钥文件是否被忽略且未被跟踪；受控文件里是否出现密钥模式（`sk-`/私钥/`ghp_`）；当前真实密钥值是否出现在工作区或提交历史。

## 备份与恢复

```bash
# 在线备份（VACUUM INTO，WAL 下安全；自动逐表核对行数）
sudo node scripts/backup.mjs --db /var/lib/cube-agent/cube.db --out /var/backups/cube-agent

# 恢复
sudo systemctl stop cube-agent
sudo cp /var/backups/cube-agent/cube-YYYYmmdd-HHMMSS.db /var/lib/cube-agent/cube.db
sudo rm -f /var/lib/cube-agent/cube.db-wal /var/lib/cube-agent/cube.db-shm
sudo systemctl start cube-agent
curl -s http://127.0.0.1:8787/healthz
```

备份脚本会在结束时比对源库与副本的逐表行数；不一致即 `exit 1`，不要拿这种快照去恢复。

### 恢复演练（不碰线上）

```bash
sudo ./scripts/restore-drill.sh          # 或用 SRC_DB=... 指定源库
```

流程：备份 → 还原到临时库 → 用还原库在 8797 起独立实例 → 校验 `/healthz`、`/api/overview` 与消息行数一致。**线上服务完全不受影响。**

## 部署形态（2026-11-06 起）

- 服务运行在 **`/opt/cube-agent`**（GitHub 克隆），**不再直接跑开发工作区** `/home/pro/dsh/cube-agent`
- 好处：开发目录里改文件不会瞬时上线；升级走 ff-only 拉取 `/opt` 克隆
- 发布流程：`开发目录改 → commit → push → 调用 /api/admin/upgrade 或 /opt 里 git pull --ff-only → 自动重启`
- 单元文件：`deploy/cube-agent.service`（`WorkingDirectory=/opt/cube-agent/impl`），实际生效副本在 `/etc/systemd/system/`

## 升级测试门禁

- 生产已开启 `UPGRADE_RUN_TESTS=1`：升级在 pull 之后、重启之前运行门禁用例
  （tenant-isolation / sse-resume / upgrade / ratelimit / gate），失败自动 `git reset --hard` 回滚
- **门禁必须在干净环境跑**：`upgrade.mjs` 用 `cleanTestEnv()` 剥离 `CUBE_TOKENS / APP_PASSWORD / DB_PATH / WORKSPACE_ROOT / PORT / MODEL_*` 等 15 个变量并设 `NODE_ENV=test`
- 教训：服务进程带着生产 env 直接 `node --test`，会让 gate 测试走生产配置（期望未开口令门）而 100% 失败
- 自举顺序（如果门禁逻辑本身要修）：先 `UPGRADE_RUN_TESTS=0` 升上去 → 重启 → 再设回 1

## 自动备份（systemd timer）

```bash
systemctl list-timers cube-agent-backup.timer     # 下次触发时间
sudo systemctl start cube-agent-backup.service     # 立即跑一次
sudo journalctl -u cube-agent-backup.service -n 20 # 看校验结果
ls -la /var/backups/cube-agent                     # 产物（默认保留最近 14 份）
```

- 单元文件在仓库 `deploy/cube-agent-backup.{service,timer}`，安装在 `/etc/systemd/system/`
- 每日 03:30 触发，`Persistent=true`（关机错过会在开机后补跑），`RandomizedDelaySec=300`
- 备份脚本自带逐表行数校验；不一致会 `exit 1`，journal 里能直接看到

## 恢复演练（用定时器产出的那份备份）

```bash
./scripts/restore-drill.sh 8790 --from-latest   # 取 /var/backups 最新一份
./scripts/restore-drill.sh 8790                 # 或现场新做一份再还原
```

校验项：最新备份存在 → `integrity_check=ok` → 还原副本 → 独立实例 `/healthz` → `/api/overview` 可用 → 行数与还原库一致 → **负向：故意损坏一份副本，`integrity_check` 必须报错**（证明"损坏能被发现"）。
