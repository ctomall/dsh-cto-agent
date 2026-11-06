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

## 每月自动恢复演练（systemd timer）

```bash
systemctl list-timers cube-agent-restore-drill.timer     # 每月 1 日 04:30
sudo systemctl start cube-agent-restore-drill.service     # 立即跑一次
sudo journalctl -u cube-agent-restore-drill.service -n 20 # 期望最后一行 pass=7 fail=0
```

单元文件在 `deploy/cube-agent-restore-drill.{service,timer}`，端口固定 8798（临时实例，跑完即退）。

## 恢复演练（用定时器产出的那份备份）

```bash
./scripts/restore-drill.sh 8790 --from-latest   # 取 /var/backups 最新一份
./scripts/restore-drill.sh 8790                 # 或现场新做一份再还原
```

校验项：最新备份存在 → `integrity_check=ok` → 还原副本 → 独立实例 `/healthz` → `/api/overview` 可用 → 行数与还原库一致 → **负向：故意损坏一份副本，`integrity_check` 必须报错**（证明"损坏能被发现"）。

## 公网可用性与升级窗口

- 每次升级会 `process.exit(0)` 让 systemd 拉起新进程（`RestartSec=2`）。这个窗口内 cloudflared 连不上 origin，公网会返回 **502**：
  `dial tcp 127.0.0.1:8787: connect: connection refused`
- 窗口约 2–5 秒；**不是故障，但会被外部监控记一次失败**
- 建议：升级放在低峰；外部探活用 2 次重试消除该窗口（`scripts/verify-online.sh` 已对 000/502/503/504 重试）
- 判据：本机 `/healthz` 200 + 公网连续 3 次 200 才算恢复
- **验收不要在升级重启窗口里跑**：进程退出到 systemd 拉起之间（约 2–5s）请求会 401/502，`acceptance.sh` 的第 0.2 步会先确认版本稳定再往下走

## 公网链路现状（实测，2026-11-06）

- 本机 `127.0.0.1:8787/healthz` 连续 5/5 = **200**
- 公网 `https://cto.ila3.top/healthz` 同一时刻 **3/5 = 200**，其余为 `000`（`time_connect=0`，TCP 未建立）
- 分协议抽样：`--http2` 7/10、`--http1.1` 2/10；`--ipv6` 全部立即失败（本机无 IPv6 出口）
- 对照：`https://www.cloudflare.com/` 5/5 成功，`https://1.1.1.1/` 0/5
- 结论：**丢包发生在出网链路/边缘路径，不是应用缺陷**；所有公网验收脚本都需对 `000`/`502` 重试

### 根因与修复（2026-11-06 二轮排障）

对照 `www.cloudflare.com` 也是 **7/10**，说明与我们的域名/隧道无关，而是**本机→边缘**的链路问题。继续量：

```
ping -M do -s 1472 1.1.1.1  → 100% packet loss   （1500 MTU 走不通）
ping -M do -s 1372 1.1.1.1  → 0% loss           （1400 MTU 正常）
sysctl net.ipv4.tcp_mtu_probing → 0             （内核对 PMTU 黑洞不做探测）
```

即 **路径 MTU < 1500 + 不探测 = PMTU 黑洞**：大包被静默丢弃，表现为随机超时/530。

**处置**：`net.ipv4.tcp_mtu_probing=1`（持久化到 `/etc/sysctl.d/99-mtu-probing.conf`），
并 `systemctl restart cloudflared-cto`（旧连接按旧 MSS 建立，必须重建）。同一测法前后对比：

| 阶段 | 公网 `/healthz` |
|---|---|
| 改前（3 组 ×10） | 7/10、7/10、7/10 |
| 改后（3 组 ×10） | **9/10、10/10、10/10** |

公网验收自此完整跑通：`pass=12 fail=0 skip=0`。公网脚本仍保留「时间预算重试 + 000 记 SKIP」作为兜底。
- 因此：**判定以本机验收为准**；公网结论只在多次重试成功时才算数
- **吞吐上限**：`/api/runs` 受 runs 桶限流（**20/分/IP**）。并发冒烟时超过该值会拿到 429，`scripts/concurrency-smoke.sh` 会自动等待 62s 重试一次；这不是故障，是设计

## 干净克隆复现（无需 .runtime-* 文件）

验收脚本的凭据来源已支持环境变量，任何人在空白机器上都能复现：

```bash
git clone git@github.com:ctomall/dsh-cto-agent.git && cd dsh-cto-agent
node --test impl/test/*.test.mjs            # 221 通过
APP_PASSWORD='pw-1' APP_SESSION_SECRET='secret-1234567890' \
CUBE_TOKENS='{"tok_a":{"tenantId":"t_a","userId":"u_a"},"tok_b":{"tenantId":"t_b","userId":"u_b"}}' \
PORT=8899 DB_PATH=/tmp/vc/cube.db WORKSPACE_ROOT=/tmp/vc/ws node impl/src/server.mjs &

PW='pw-1' TOK_A=tok_a TOK_B=tok_b ./scripts/acceptance.sh http://127.0.0.1:8899
# → pass=20 fail=0 skip=2（两个 SKIP 是 ① 真实模型 / ③ 边缘 Access）
```

**实测**：空库干净克隆上 pass=20 fail=0 skip=2（2026-11-06）。

## 就绪快照（一条命令，数字全部现场生成）

```bash
node scripts/readiness-report.mjs --base http://127.0.0.1:8787
```

输出：全量测试通过数、目标验收 pass/fail/skip、①②③ 的凭据状态、线上版本、演练脚本是否就绪，
以及"阻塞项 + 放行命令"。**所有数字来自现场执行**，不是手写，因此不会随代码漂移。

## 验收器自检（防止它变成只发绿灯的装饰）

```bash
./scripts/check-arbiter-bites.sh
```

它会起一个"审批后不产出"的故障实例（工具路径越界 → 工具失败、无产物），然后跑验收，
**要求 ① 在「审批后产出」这一步变红**。实测输出：`✖ 审批后产出 …` + `== 汇总：pass=14 fail=10` + `OK: 验收器会咬人`。

这类"对验收器的测试"应当定期跑：**判据松了，绿灯就是装饰**。

**两个方向都要验**：

```bash
./scripts/check-arbiter-bites.sh             # 故障实例 → ① 必须变红（约 23s）
./scripts/check-arbiter-bites.sh --positive  # 正常实例 → ① 必须全绿（约 3s，证明判据可满足）
```

- 自检现在 **23 秒**跑完（`ACCEPT_ONLY=1` 只跑 ①，`ACCEPT_WAIT_*=20` 把等待压短），**已纳入 `verify-all` 第 8 步**
- 验收器的等待超时可用 `ACCEPT_WAIT_TOOL/APPROVAL/ARTIFACT/FINISH` 调整（默认 180/120/180/120s，面向真实厂商）

## 脚本索引（自动生成）

```bash
node scripts/gen-scripts-index.mjs   # 重建 scripts/README.md
```

`docs-check` 会校验 `scripts/README.md` 与 `scripts/` 目录完全一致：
**新加脚本必须重建索引**，否则复核会红（防止"脚本加了但没人知道它存在"）。

## 浏览器级检查一览（cdp-*.mjs）

这些脚本用 CDP 驱动真实浏览器验证"界面到底有没有做到"。它们不进常规门禁（需要 9222 与 chromium），
但**每一条都对应一个具体承诺**，排查时直接跑对应那条即可。

| 脚本 | 验证什么 | 现状 |
|---|---|---|
| `cdp-public-flow.mjs` | 公网页面全链路：登录 → 输入目标 → 审批卡 → 允许一次 → 产物 | 在用 |
| `cdp-public-pages.mjs` | 公网 Cookie 模式下四页（总览/产物/设置/工作台）都能出数据 | 在用 |
| `cdp-grant-ui-check.mjs` | ② 的 UI 承诺：同会话第二次不再弹卡，改显示「已按会话授权放行」 | 在用 |
| `cdp-cross-session-check.mjs` | ② 的另一半：跨会话必须重新弹卡 | 在用 |
| `cdp-revoke-ui-check.mjs` | 授权生命周期：允许 → 可见 → 撤销 → 清空 → 再调用重新弹卡 | 在用 |
| `cdp-pending-ui-check.mjs` | 刷新后审批卡还原，点「允许一次」后产出出现 | 在用 |
| `cdp-xss-check.mjs` | 会话标题里的 HTML/脚本载荷按纯文本渲染 | 在用 |
| `cdp-artifact-download-check.mjs` | html 产物即使 `inline=1` 也只能下载，不能渲染成页面 | 在用 |
| `cdp-frame-check.mjs` | 点击劫持：iframe 嵌审批页必须被拒绝；顶层直开作对照 | 在用 |
| `cdp-driver-check.mjs` | 状态栏如实显示"演示驱动 / 真实驱动" | 在用 |
| `cdp-429-check.mjs`、`cdp-probe-ui-check.mjs` | 限流提示文案、探针按钮结果展示 | 在用 |
| `cdp-delete-check.mjs`、`cdp-delete-row-check.mjs` | 会话删除（保留会话 vs 删除行两种路径） | 优先用 `check-session-ops.mjs`（确定性临时实例） |
| `cdp-rename-check.mjs`、`cdp-session-filter-check.mjs` | 重命名、会话筛选 | 优先用 `check-session-ops.mjs` |
| `cdp-approval-decided-check.mjs` | 审批后卡片状态与按钮禁用 | 在用 |

**漂移复核（2026-11-07）**：抽了三条最关键的旧脚本，在本轮改动后重新实跑：
- `cdp-xss-check` → `{"injectedImgs":0,"injectedScripts":0,"renderedAsText":true,"ok":true}`
- `cdp-driver-check` → `{"text":"演示驱动（未接模型）","real":"0",…}`（如实反映未接模型）
- `cdp-frame-check` → `iframe 嵌入结果: 不可访问`、顶层直开正常、无控制台报错

其余需要额外入参的（`CK`+`SID` 的审批/跨会话检查）**本轮未跑**，用前先看脚本头部的用法行。

**说明**：带"优先用 …"的几条是早期针对公网写的版本，公网链路抖动会让它们不稳定；
同名的确定性覆盖已移到 `check-*.mjs`（临时实例 + CDP），**保留旧脚本作为历史证据，不再作为门禁**。

## 门禁稳定性自检（4 路并发跑全量）

门禁在生产机上跑，和线上流量抢 CPU；时间敏感用例会因此**假红**，而假红会触发自动回滚。
定期用这个方式压一遍，能提前发现"只在负载下才红"的用例：

```bash
for i in 1 2 3 4; do (node --test --test-concurrency=2 --test-timeout=30000 impl/test/*.test.mjs > /tmp/r$i.log 2>&1; echo "run$i exit=$?") & done; wait
```

- 期望：4 路全部 `pass 254 / fail 0`
- 门禁并发实测：`2 → 69s`、`4 → 37s`、**`6 → 28s`**（3 路并行跑 6 仍全绿）→ 门禁固定用 6
- 2026-11-07 实测：修掉「并发过高 / 固定毫秒断言 / 固定端口 / 单次超时即失败」四类根因后，4 路全绿

## 灾备恢复演练（实测 2026-11-07）

```bash
./scripts/restore-drill.sh 8797            # 用当前库产快照 → 还原 → 起独立实例 → 读数据
./scripts/restore-drill.sh --from-latest   # 用定时器产出的最新备份（灾难现场那份）
```

实测输出（6 项全绿）：

```
✔ 备份产出        cube-20261106-142637.db
✔ 还原副本        restored.db
✔ 还原实例        :8797 /healthz ok
✔ 总览 API 可用   sessions 字段存在
✔ 行数一致        messages=1526
✔ 损坏备份被识别  integrity=*** in database main ***
```

**不碰线上**：全程在临时目录 + 独立端口；最后一项是负向验证（损坏的备份必须被认出来）。

## 定时任务（systemd，unit 已入库到 deploy/）

| 单元 | 频率 | 作用 |
|---|---|---|
| `cube-agent-backup.timer` | 每日 03:30 | `backup.mjs`（VACUUM INTO + 逐表校验，保留 14 份） |
| `cube-agent-restore-drill.timer` | 每月 | `restore-drill.sh`（还原到临时库并起实例验证） |
| `cube-agent-maintenance.timer` | 每月 1 日 04:10 | `maintenance.mjs --prune-events 90` + `--report` |

```bash
sudo cp deploy/cube-agent-*.{service,timer} /etc/systemd/system/ && sudo systemctl daemon-reload
sudo systemctl enable --now cube-agent-backup.timer cube-agent-restore-drill.timer cube-agent-maintenance.timer
```

**实测（2026-11-07）**：手动 start `cube-agent-maintenance.service` → 两个 Exec 均 `status=0/SUCCESS`，
`--report` 输出现状（runs 994 / events 7365 / audit 1007）；因库龄不足 90 天，本次删除 0 行（符合预期）。
