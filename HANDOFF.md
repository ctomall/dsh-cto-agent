# 交接：两处未完成项与放行步骤

> 现状（`scripts/acceptance.sh` 输出）：**pass=22 fail=0 skip=2**

<!-- acceptance: pass=22 fail=0 skip=2 -->
<!-- tests: 282 -->
<!-- test-files: 110 -->
> 两个 SKIP 不是"大概做完了"，是**没做**。下面是把它变成 PASS 的完整步骤，任何有权限的人照着做即可。


## 当前状态一览（2026-11-06，随本轮实跑更新）

| 项 | 状态 | 证据 |
|---|---|---|
| ② 会话级审批 scope | **PASS** | 同会话二次放行、跨会话不继承、撤销即失效、UI 承诺与行为一致 |
| ① 真实模型 loop | **SKIP** | 结构性验收已成立：反事实证明序列由模型×策略决定；公网页面「输入→审批→产出」已实测；崩溃/重启/并发/形状护栏齐全；**只缺 key** |
| ③ Cloudflare Access + 边缘限流 | **SKIP**（应用层已就绪） | 应用层：身份门、租户隔离、分桶限流、升级令牌、安全响应头（公网实测）；边缘脚本 `cf-access-setup.sh` 支持 dry-run 结构自检；**只缺 CF 三件套** |

- 测试：**282 通过 / 110 个测试文件**；升级门禁跑全量（`UPGRADE_TEST_SCOPE=full`，`--test-concurrency=6`，**约 33s**）
- 公网四页（工作台/总览/产物/设置）在 Cookie 模式下均已实测出数据（verdict.ok=true）
- 基础设施修复（2026-11-06）：隧道 `quic → http2`（QUIC 握手失败）、`net.ipv4.tcp_mtu_probing=1`
  （PMTU 黑洞导致约 30% 丢包）→ 公网成功率 7/10 → 9-10/10
- **已知未验证（不是"没做"，是"做不了/没测到"）**：
  1. 真实厂商的 tool_call 行为（缺 `MODEL_*`）
  2. Cloudflare 边缘 Access 与边缘限流（缺 CF 三件套）
  3. 公网路径上的限流行为（本机打不出来，见 RUNBOOK 的对照实验）
  4. 真实重启演练（会中断本机其它服务，未做）

---

## ① 接通真实模型 loop（当前 SKIP）

**缺什么**：`MODEL_BASE_URL` / `MODEL_NAME` / `MODEL_API_KEY`（或 `MODEL_API_KEY_FILE`）。

**放行步骤**（2026-11-06 修订：原来的第 1/2 步与 `unblock.sh` 重复，已合并）

```bash
# 0) 先验端点兼容性（不发真实业务请求，只探形状）——这一步能避免"接上才发现不兼容"
node scripts/provider-conformance.mjs --base <BASE_URL> --model <MODEL> --key <KEY>

# 1) 一条命令完成：写 key(0600) + 写 env 三行 + 重启 + 探针 + 端到端
#    （--probe 真发一次请求；--verify 跑「目标→模型选工具→审批→产出」）
scripts/unblock.sh --model-key '<KEY>' --base-url <BASE_URL> --model <MODEL> --probe --verify

# 2) 看 ① 是否 PASS（逐步输出，不依赖 --require-all）
./scripts/acceptance.sh | sed -n '/== ①/,/== ②/p'
```

> **注意**：此时**不要**用 `acceptance.sh --require-all`——③ 仍是 SKIP，require-all 会按设计返回 3。
> ① 的五条断言行（driver 非 fake / 模型选择了工具 / 审批暂停 / 审批后产出 / run 正常收尾）全 ✔ 即算通过。

**验收判据**：`/api/model/status` 返回 `real:true`；`first-real-run.sh` 打印「① 真实链路通过」；
验收器 ① 段五行全绿（可用 `scripts/check-acceptance-with-mock-model.sh` 先看"全绿长什么样"）。

**回滚**：删掉 `/etc/cube-agent/env` 里的 `MODEL_*` 三行 → 重启（会退回 fake，`model_real` 变 0）。

---

## 已就绪的运维/安全能力（2026-11-06 收敛）

| 能力 | 位置 | 复核方式 |
|---|---|---|
| 部署与开发解耦 | 服务跑 `/opt/cube-agent`，单元 `WorkingDirectory=/opt/cube-agent/impl` | `systemctl show -p WorkingDirectory --value cube-agent.service` |
| 一键升级（ff-only + 测试门禁 + 回滚） | `/api/admin/upgrade`、`UPGRADE_RUN_TESTS=1` | 调用后用 `/api/version` 比对；门禁失败会 `rolled_back` |
| 部署完整性检测 | `acceptance.sh` 的「部署目录干净」 | 克隆有未提交改动即 FAIL |
| 定时备份 | `cube-agent-backup.timer`（03:30，Persistent） | `systemctl list-timers cube-agent-backup.timer` |
| 恢复演练（含负向） | `scripts/restore-drill.sh 8790 --from-latest` | 最新备份 `integrity_check` + 还原实例 + 破坏副本必须被识别 |
| 安全契约与租户矩阵 | `SECURITY.md`、`impl/test/tenant-matrix.test.mjs` | `node --test` |
| 用例有效性（变异探针） | `scripts/mutation-probe.sh` | 注入实现变异，关键用例必须变红 |
| 一键复核 | `scripts/verify-all.sh` | SKIP 时 exit 3，不伪装通过 |

## ② 会话级审批 scope（已完成，保留说明）

已在 `session_grants` 落库，`allow_session` 生效、可撤销、自动放行写审计。判据见 `acceptance.sh` 的 6 条断言。

---

## ③ Cloudflare Access（当前 SKIP）

**缺什么**：`CLOUDFLARE_API_TOKEN`（Access: Apps 编辑 + Zone: Rate Limit 编辑）、`CF_ACCOUNT_ID`、`CF_ZONE_ID`。

**放行步骤**

```bash
# 1) dry-run 看将要发什么（不触网）
ALLOW_EMAILS=you@example.com scripts/cf-access-setup.sh --dry-run

# 2) 真正创建（Access 应用 + 邮箱策略 + 边缘限流）
CLOUDFLARE_API_TOKEN=... CF_ACCOUNT_ID=... CF_ZONE_ID=... \
ALLOW_EMAILS=you@example.com scripts/cf-access-setup.sh

# 3) 验收：未登录浏览器应被 CF 拦截并跳转登录页
curl -s -o /dev/null -w '%{http_code}\n' https://cto.ila3.top/        # 期望 302 → CF Access
./scripts/acceptance.sh --require-all                                  # ③ 必须无 SKIP
```

**验收判据**：未授权访问被 CF 拦截；授权后可正常访问页面与 API；`/api/admin/upgrade` 仅授权主体可达（已有 token + IP 白名单双保险）。

**回滚**：Cloudflare 后台删除对应 Access 应用；或 `DELETE /accounts/{id}/access/apps/{app_id}`。应用层门（`APP_PASSWORD`）仍在，删掉 CF Access 不会导致全裸。

---

## 怎么判断"整体完成"

```bash
./scripts/acceptance.sh --require-all && node --test impl/test/*.test.mjs
```

`--require-all` 在仍有 SKIP 时返回 3。**只有 exit 0 才算三项全绿。**

## 守则（别绕过）

- 升级只走 `/api/admin/upgrade` 或 `scripts/upgrade.sh`（ff-only + 测试门禁 + 失败回滚），不要手工 `git pull` 后直接重启
- **不要直接改 `/opt/cube-agent` 里的文件**：验收器的「部署目录干净」会立刻红；改代码只改开发工作区并走提交推送
- 密钥只进 `/etc/cube-agent/`（0600）或环境变量，**永不入库**
- 验收器报 SKIP 就如实记录 SKIP，不要改判据凑 PASS

> ③ 拿到凭据后：`./scripts/check-cf-edge.sh`；无凭据可用 `EDGE_ONLY=1` 只验边缘行为。
> 现状实测（2026-11-07）：未授权仍落在应用层 `/login`、升级接口返回应用层 401 —— 边缘未上。
