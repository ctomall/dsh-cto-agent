# 阶段 1 spike 结论：代码已跑，结论是「未通过，但推翻了文档的一条核心假设」

> 产物：`cube-agent/impl/spike-load-real-plugin.mjs`（可执行）。原始输出 `spike-output.log` 已从仓库移除
> （历史运行产物不入库，避免过期日志冒充当前证据）；如需复跑：直接执行那个 spike 脚本。
> 环境：Node **v24.22.2**；`@deepseek-ai/dsh` **0.2.1-rc.5**；`@deepseek-ai/cordis` **4.0.5**
> 方式：真实 `Context` + 真实 `@deepseek-ai/*` 包，不使用文档推断

---

## 一、跑通了什么

| 断言 | 结果 | 证据 |
|---|---|---|
| 真实 Cordis Context 可创建 | ✅ | `ctx created: Context` |
| 真实服务插件可加载并提供服务 | ✅ | `SystemPrompt → ctx.systemPrompt` 存在 |
| `ToolRuntime` 可加载并提供 `tools` | ✅ | `ctx.tools` 类型为 object；前提是先提供 `systemPrompt`（`ToolRuntime.inject=["systemPrompt"]`） |
| 插件 disposer 可正常卸载、不抛错 | ✅ | `ctx.plugin()` 返回 disposer，卸载流程无异常 |

**意义**：P0-1 里"兼容层必须提供宿主 shim 才能加载生态插件"这个方向是**可行的**——模块能解析、服务能 provide。

## 二、没跑通什么（阶段 1 判定：未通过）

| 断言 | 结果 | 原因（实测） |
|---|---|---|
| 工具插件注册工具 | ❌ `toolCount: 0` | `dsh-tool-schedule` 的 `package.json` 声明 `inject: ["tools"]`，但 `apply()` 内部写的是 `ctx.inject(["schedule"], …)` |
| 调用工具 | ❌ 无法进行 | 没有注册项可调用 |
| 卸载后注册表归零 | ⚠ 0 → 0 | 因为从未注册，此断言**不构成有效证据**，不能算通过 |

## 三、四条硬结论（都有机器输出背书）

**结论 1：声明 `inject` 不可信，不能只按它构建依赖图。**
`dsh-tool-schedule` 声明 1 个依赖，实际需要 2 个（多一个 `schedule`）。兼容层若按 `package.json.inject` 判"缺依赖即拒绝"，会**放过一个加载后静默无工具的插件**——比报错更难排查。

**结论 2：`schedule` 服务自身是一条 5 层依赖链。**
`ScheduleService.inject = ["agents","sessions","storageDomain","sessionController","sessionPersistence"]`。5 个都没提供时，插件**不报错、不激活、不提供 service**（静默失败）。

**结论 3：六个真实工具插件的依赖面 = 9 个不同 service。**

| 插件 | 声明的 inject |
|---|---|
| `dsh-tool-fs` | `tools, fs, systemPrompt, workingDirectory` |
| `dsh-tool-present` | `tools, fs, sessionProjections, workingDirectory` |
| `dsh-tool-goal` | `agents, goals, tools, systemPrompt, sessionProjections` |
| `dsh-tool-jobs` | `tools, jobs, systemPrompt` |
| `dsh-tool-ask-user` | `tools, userQuestions` |
| `dsh-tool-schedule` | `tools`（实际还需 `schedule`） |

**文档 §3.4 的兼容最小集是 6 个**（`tools/models/sessions/workspace/approvals/events`），实测**缺 8 个**：`fs`、`systemPrompt`、`workingDirectory`、`sessionProjections`、`agents`、`goals`、`jobs`、`userQuestions`（外加 `schedule` 及其 5 层链）。

**结论 4：`schemas()` 无 scope 时返回空**，说明"注册即可见"不成立；工具可见性与 scope/激活状态相关。文档 §3.5 的"加载即通过"验收口径不成立。

## 四、对文档的影响（下一步要改的地方）

| 编号 | 需要新增/修改 | 理由 |
|---|---|---|
| **新 P0** | §3.4 的 service 最小集从 6 项扩为实测依赖面，并区分"必须实现 / 可降级 / 不支持" | 结论 3：6 项撑不起任何真实工具插件 |
| **新 P0** | 增加红线：「不得以 `package.json.inject` 作为依赖判定的唯一依据，必须做运行时激活探测」 | 结论 1：声明与实现不一致 |
| **改** | §3.5 兼容验收拆两级：C2-a 服务插件可 provide；C2-b 工具插件可注册且可调用 | 结论 4：加载 ≠ 可见 ≠ 可调用 |
| **改** | §十一 增加"静默不激活"检测用例：加载后 N 秒内注册表为 0 即判失败 | 结论 2：缺依赖不报错 |

## 五、下一步实验（按成本排序，不一次性做完）

1. **补齐到 13 个 service 的空实现**（每个返回最小可用值），重跑 spike，看 `schedule` 服务能否 provide —— 目标：让 `toolCount > 0` 成立。
2. 若服务链仍打不通，改用依赖最少的插件（`dsh-tool-ask-user`，2 个依赖）做 C2-b 验证。
3. 打通后补"卸载归零"的真实断言（此时 0 才有意义）。

## 六、坦白

- 阶段 1 **没有通过**。这一轮的产出是"把一条假设打穿了"，不是"兼容层跑通了"。
- 没有提交任何"看起来能跑"的代码；spike 是诊断工具，不是产品代码。
- 产品代码（Gateway / TenantRuntime / 存储）**仍未开始**——按文档 §零 执行纪律第 1 条，需要架构确认，但也必须承认：三轮文档迭代之后才动第一行代码，节奏是慢的。
