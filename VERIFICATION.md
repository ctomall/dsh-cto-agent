# 一页验证

> 用途：任何人（包括未来的我）不需要回忆，按下面的命令就能复核三项计划的真实状态。
> 一键跑全部：`./scripts/verify-all.sh`（有 SKIP 时 exit 3，不伪装成通过）

## 一键

```bash
./scripts/verify-all.sh                 # 本机
./scripts/verify-all.sh https://cto.ila3.top   # 公网
```

输出形如：

```
✔ node --test        278/278 通过
✔ secret-scan        pass=6 fail=0
✔ a11y-contrast      全部达标
✔ ratelimit-check    pass=4 fail=0
○ acceptance         pass=22 fail=0 skip=2（有 SKIP）
== 结论：pass=4 fail=0 skip=1 → 目标未完成
```

## ② 会话级审批 scope — **PASS**

```bash
./scripts/acceptance.sh http://127.0.0.1:8787 | grep -A4 '②'
```

期望：`首次要求审批 approval.requested` → `同会话第二次免审批 auto_approved` → `撤销会话授权 1 条`。

补充证据：`impl/test/grants-isolation.test.mjs`（跨租户/跨会话/跨工具均不继承）、`impl/test/tenant-matrix.test.mjs`（10 条路径跨租户全 404）。

## ① 真实模型 loop — **SKIP（缺 MODEL_*）**

已就绪、可自测的部分：

```bash
# 脚本自身可用（用本地 mock provider 验证，不花钱）
node scripts/mock-provider.mjs 8796 &
MODEL_BASE_URL=http://127.0.0.1:8796/v1 MODEL_NAME=mock MODEL_API_KEY=sk-mock \
  PORT=8797 DB_PATH=/tmp/fr.db WORKSPACE_ROOT=/tmp/fr-ws node impl/src/server.mjs &
PW= TOK=tok_a ./scripts/first-real-run.sh http://127.0.0.1:8797
```

期望：事件序列 `run.started → text.delta → tool.started → approval.requested → approval.decided → tool.finished → artifact.created → run.finished`。

接上真 key 后：

```bash
scripts/unblock.sh --model-key sk-... --verify   # 写盘 + 重启 + 探针 + 端到端
./scripts/first-real-run.sh                     # 真实链路（driver 必须 real）
./scripts/acceptance.sh --require-all           # 必须 exit 0
```

**未验证的部分**：模型决策的真实性（当前 `driver=fake`）。

## ③ Cloudflare Access + 限流 — **应用层 PASS / 边缘 SKIP**

应用层证据：

```bash
./scripts/acceptance.sh http://127.0.0.1:8787     # 未登录 401/302、已登录 200、跨站 403、升级接口需凭据
./scripts/ratelimit-check.sh                       # api 桶第 60 次 429、retry-after、桶隔离
./scripts/secret-scan.sh                           # 密钥不入库
```

边缘（Cloudflare Access）需要 `CLOUDFLARE_API_TOKEN` + `CF_ACCOUNT_ID` + `CF_ZONE_ID`：

```bash
scripts/unblock.sh --cf-token ... --cf-account ... --cf-zone ... --allow-emails you@example.com
```

## 运维能力（支撑「可上线」）

验收含「部署目录干净」一项：`/opt/cube-agent` 克隆必须无未提交改动，且 HEAD 与线上一致（防热改线上）。

| 能力 | 命令 |
|---|---|
| 在线备份（自校验） | `sudo node scripts/backup.mjs --db /var/lib/cube-agent/cube.db --out /var/backups/cube-agent` |
| 恢复演练（不碰线上） | `sudo ./scripts/restore-drill.sh` |
| 升级（仅 ff-only，分叉 409） | `./scripts/upgrade.sh` |
| 模型接入体检 | `./scripts/preflight-model.sh` |
| 安全契约 | `SECURITY.md` |
| 文档↔代码欠账 | `CONFORMANCE.md` |
| 阻塞说明 | `HANDOFF.md` |


## 已撤回的"缺陷"（2026-11-06，公网环境）— 实为测量误差

曾记录「产物页在公网 Cookie 模式下不渲染数据」。**该结论已被推翻**：

| 环境 | 结果 |
|---|---|
| 本机 `?token=`（无门禁） | `count=200 个`、`status=就绪`、200 行 |
| 本机 口令门（Cookie 模式） | `count=200 个`、`status=就绪`、200 行 |
| **公网 https://cto.ila3.top（Cookie 模式）** | **`count=200 个`、`status=就绪`、200 行**（两次独立复测） |

同类误报还有一处：**总览页的「用量」pill** 曾显示 `用量 -`，同样怀疑是缺陷；实测
`/api/usage` 返回 200（runs 430），并在 5s 后正常显示 `近 7 天 · 430 次运行 · 0 tokens`。

原因：前几次是在页面只等 `readyState=complete` 后固定 sleep 3–4 秒就读 DOM；公网链路上
页面要顺序发多个请求（`/api/me → /api/version → /api/model/status → /api/artifacts`；
总览还有第二条 `/api/usage`），**读得太早，读到的是初始占位符**。改为轮询到数据出现（最多 60s），5s 即就绪。

教训：**"没数据"要先区分"没跑到"和"没跑完"**。测量前必须定义"就绪信号"，而不是睡固定秒数。

## 全面复验记录（2026-11-06 07:5x UTC）

| 检查 | 命令 | 结果 |
|---|---|---|
| 全量测试 | `node --test impl/test/*.test.mjs` | **175 / 175** |
| 目标验收 | `./scripts/acceptance.sh http://127.0.0.1:8787` | pass=22 fail=0 skip=2 |
| 一键复核 | `./scripts/verify-all.sh` | pass=6 fail=0 skip=1 |
| 恢复演练（最新备份） | `./scripts/restore-drill.sh 8797 --from-latest` | pass=7 fail=0 |
| 孤儿 run 收敛 | `./scripts/orphan-drill.sh 8798` | pass=7 fail=0 |
| 重启韧性（SIGKILL） | `sudo ./scripts/restart-drill.sh … --sigkill` | pass=9 fail=0 |
| 并发冒烟（8 路） | `./scripts/concurrency-smoke.sh http://127.0.0.1:8787 8` | pass=4 fail=0 |
| 密钥外泄（日志/库） | `./scripts/secret-leak-scan.sh` | pass=3 fail=0 |
| 文档对账 | `./scripts/docs-check.sh` | pass=8 fail=0 |

运行态：`sessions 194 / runs 513 / events 3837 / audit 501 / running 0 / waiting 0`，线上 SHA `3d476c0`。

公网抽样（各 3 次）：`/healthz 200,000,200`、`/login 200,200,200`、`/api/sessions 401,401,000`；
同一时刻本机 `200,200,200` —— **丢包在出网链路**，见 RUNBOOK「公网链路现状」。

## 当前结论（2026-11-06）

<!-- acceptance: pass=22 fail=0 skip=2 -->

| 计划 | 状态 | 差距 |
|---|---|---|
| ② 会话级审批 scope | **PASS** | — |
| ① 真实模型 loop | **SKIP** | 只缺 `MODEL_*`；结构与持久化已完备 |
| ③ CF Access + 限流 | 应用层 PASS / 边缘 **SKIP** | 只缺 CF 三件套 |
