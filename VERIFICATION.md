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
✔ node --test        127/127 通过
✔ secret-scan        pass=6 fail=0
✔ a11y-contrast      全部达标
✔ ratelimit-check    pass=4 fail=0
○ acceptance         pass=18 fail=0 skip=2（有 SKIP）
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
scripts/unblock.sh --model-key sk-... --probe   # 写盘 + 重启 + 自检
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

| 能力 | 命令 |
|---|---|
| 在线备份（自校验） | `sudo node scripts/backup.mjs --db /var/lib/cube-agent/cube.db --out /var/backups/cube-agent` |
| 恢复演练（不碰线上） | `sudo ./scripts/restore-drill.sh` |
| 升级（仅 ff-only，分叉 409） | `./scripts/upgrade.sh` |
| 模型接入体检 | `./scripts/preflight-model.sh` |
| 安全契约 | `SECURITY.md` |
| 文档↔代码欠账 | `CONFORMANCE.md` |
| 阻塞说明 | `HANDOFF.md` |

## 当前结论（2026-11-06）

| 计划 | 状态 | 差距 |
|---|---|---|
| ② 会话级审批 scope | **PASS** | — |
| ① 真实模型 loop | **SKIP** | 只缺 `MODEL_*`；结构与持久化已完备 |
| ③ CF Access + 限流 | 应用层 PASS / 边缘 **SKIP** | 只缺 CF 三件套 |
