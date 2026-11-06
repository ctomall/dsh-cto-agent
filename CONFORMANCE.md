# 文档 ↔ 代码 一致性对账

> 目的：把“文档里有、代码里没有”的漂移变成**显式欠账**，而不是等人踩坑。
> 生成方式：从 `cube-agent-rebuild-prompt-v32.md` 与 `impl/src/*.mjs` 机械提取后人工判读。

## 数据表（文档 §六）

| 表 | 已建 | 说明 |
|---|---|---|
| `approvals` | ❌ | **未建**：审批决定目前写在事件流 + audit_log，没有独立表 |
| `artifacts` | ❌ | **未建**：产物靠事件 + 工作区文件，没有元数据表 |
| `audit_log` | ✅ | 审计 |
| `events` | ✅ | 事件日志（run 内 seq） |
| `kb_docs` | ❌ | 未建（知识库未实现） |
| `messages` | ✅ | 会话消息（本轮补齐） |
| `plugins` | ❌ | 未建（插件管理未实现） |
| `runs` | ✅ | run 状态机 |
| `run_pending` | ✅ | 代码新增：审批快照（跨重启恢复），文档 §六 尚未列 |
| `run_tool_results` | ✅ | 代码新增：工具执行结果缓存（幂等），文档 §六 尚未列 |
| `session_grants` | ✅ | 代码有、文档未列：`session_grants`（会话级授权） |
| `sessions` | ✅ | 会话 |
| `skills` | ❌ | 未建（Skill 功能未实现） |
| `tenants` | ✅ | 租户 |
| `tool_calls` | ❌ | **未建**：工具调用记录在事件流里 |
| `users` | ✅ | 用户 |

## 事件类型（文档 §2.2）

| 事件 | 已实现 | 说明 |
|---|---|---|
| `approval.auto_approved` | ✅ | 代码有、文档 §2.2 未列（已在后续版本补充说明） |
| `approval.decided` | ✅ | 审批决定 |
| `approval.requested` | ✅ | 审批卡 |
| `artifact.created` | ✅ | 产物生成 |
| `reasoning.delta` | ❌ | **未实现**：不转发模型的 reasoning 增量 |
| `run.canceled` | ✅ | 代码有、文档 §2.2 未列（已在后续版本补充说明） |
| `run.failed` | ✅ | 失败/超时终态 |
| `run.finished` | ✅ | 成功终态 |
| `run.paused` | ❌ | **未实现**：暂停用 waiting_approval 状态表达，无独立事件 |
| `run.started` | ✅ | 创建即发 |
| `text.delta` | ✅ | 流式增量 + 收尾单发 |
| `tool.delta` | ❌ | **未实现**：工具执行中无增量输出 |
| `tool.finished` | ✅ | 工具结束（含错误） |
| `tool.started` | ✅ | 工具开始 |

## 前端路由（文档 §7.1）

| 路由 | 已实现 | 说明 |
|---|---|---|
| `/` | ✅ | 单页应用（会话流 + 审批卡 + 产物卡） |
| `/artifacts` | ✅ | 已实现：跨会话产物列表（租户内），可下载、可跳回会话 |
| `/c/:sessionId` | ✅ | 已实现：302 → `/?sid=…`（保留 `?sid=` 作为规范形态） |
| `/kb` | ❌ | **未实现**：知识库未做 |
| `/plugins` | ❌ | **未实现**：插件管理未做 |
| `/settings` | ❌ | **未实现** |
| `/skills` | ❌ | **未实现**：Skill 功能未做 |

## 结论

- 表：文档 13 张，代码落地 9 张（含文档未列的 `session_grants` / `run_pending` / `run_tool_results`），**6 张欠账**。
- 事件：文档 §2.2 要求 12 类，代码实现 9 类，**缺 3 类**（`reasoning.delta` / `tool.delta` / `run.paused`）。
- 欠账不是缺陷，但**必须是显式欠账**：本文件存在的意义是让“没做”可被检索，而不是靠记忆。
- 更新规则：动文档 §六/§2.2/§7.1 时同步更新本文件，否则视为文档漂移。
- 生成脚本只做机械提取，**计数与说明需人工复核**（本文件首版就出现过计数错误，已修）。

## 索引（性能）

| 索引 | 作用 |
|---|---|
| `idx_messages_session (tenant_id, session_id)` | 会话历史 |
| `idx_sessions_tenant (tenant_id)` | 会话列表 |
| `idx_audit_tenant (tenant_id)` | 审计查询 |
| `idx_runs_session (tenant_id, session_id)` | 会话级 pending/active/artifacts |
| `idx_runs_status (status)` | 启动收敛扫描 |

用例 `impl/test/indexes.test.mjs` 断言 `EXPLAIN QUERY PLAN` 必须是 `SEARCH ... USING INDEX`，防止后续改查询退化成全表扫。
