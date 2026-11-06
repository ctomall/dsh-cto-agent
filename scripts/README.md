# scripts 索引（自动生成）

> 由 `node scripts/gen-scripts-index.mjs` 生成，**不要手改**。
> `docs-check` 会校验：这里列出的脚本必须与目录里的一致（防止"脚本加了但没人知道"）。

| 脚本 | 用途 |
|---|---|
| `a11y-contrast.mjs` | 对比度自检：按 WCAG AA 校验关键前景/背景组合（正文 4.5:1，大字 3:1）。 |
| `acceptance.sh` | 目标验收器：把 ①②③ 三项变成机器可判定的 PASS/FAIL/SKIP。 |
| `artifact-xss-drill.sh` | 产物文件名载荷演练（可重复、零生产影响）：库副本 + 临时实例 + 浏览器检查。 |
| `backup.mjs` | 用法：node scripts/backup.mjs [--db /var/lib/cube-agent/cube.db] [--out /var/backups/cube-agent] |
| `cdp-429-check.mjs` | （无说明） |
| `cdp-approval-decided-check.mjs` | （无说明） |
| `cdp-artifact-download-check.mjs` | 浏览器级验证：html 产物即使带 inline=1 也只能"下载"，不能被渲染成页面。 |
| `cdp-cross-session-check.mjs` | ② 的另一半：会话授权不跨会话继承。A 会话批准后，B 会话同一工具必须重新弹卡。 |
| `cdp-delete-check.mjs` | （无说明） |
| `cdp-delete-row-check.mjs` | 会话行删除的干净校验：停在「保留会话」上，删除另一个会话（避免导航换掉 JS 上下文）。 |
| `cdp-driver-check.mjs` | 运行时校验：状态栏必须如实显示驱动。 |
| `cdp-frame-check.mjs` | 点击劫持复现：用 iframe 嵌审批页，浏览器必须拒绝渲染；同时用"顶层直接打开"做对照。 |
| `cdp-grant-ui-check.mjs` | ② 的 UI 承诺实测：同会话第二次调用不再弹审批卡，改为「已按会话授权放行」；并校验每轮一个助手块。 |
| `cdp-pending-ui-check.mjs` | 浏览器实测：刷新后审批卡还原 → 点「允许一次」→ 产出出现、状态完成。 |
| `cdp-probe-ui-check.mjs` | （无说明） |
| `cdp-public-flow.mjs` | 公网页面全链路（不含真实模型）：登录 → 输入目标 → 审批卡 → 点「允许一次」→ 产物卡 |
| `cdp-public-pages.mjs` | 公网 Cookie 模式下逐页检查：总览 / 产物 / 设置 / 工作台 |
| `cdp-rename-check.mjs` | 浏览器实测重命名：双击标题 → 输入 → Enter，随后核对 DOM 与 API。 |
| `cdp-revoke-ui-check.mjs` | ② 的授权生命周期：允许 → 面板可见 → 撤销 → 面板清空 → 再次调用重新弹卡。 |
| `cdp-session-filter-check.mjs` | （无说明） |
| `cdp-xss-check.mjs` | 浏览器级 XSS 检查：会话标题里的 HTML/脚本载荷必须被当作纯文本渲染。 |
| `cf-access-setup.sh` | 为 cto.ila3.top 配置 Cloudflare Access + 速率限制。 |
| `check-acceptance-with-mock-model.sh` | 用"本地 mock 模型 + 临时实例"跑一遍验收器：证明 ① 的断言**可满足**（真驱动、事件由模型决定）， |
| `check-approval-truncation.mjs` | 浏览器级验证：超长参数被截断时，审批卡必须显示「参数较长，已截断显示」。 |
| `check-arbiter-bites.sh` | 验收器"咬人"自检：人为制造"审批后不产出"，验收 ① 必须变红。 |
| `check-boot-hang.mjs` | 浏览器级验证：boot 中某一步"卡住不返回"时，页面仍必须完成绑定（筛选可用）。 |
| `check-boot-resilience.mjs` | 浏览器级验证：boot 期间某个接口失败（模拟丢包），页面仍必须渲染会话列表。 |
| `check-cf-edge.sh` | ③ 的边缘验收（需要 Cloudflare 凭据）。**注意：本脚本尚未用真实凭据运行过**—— |
| `check-cf-proxy.sh` | ③ 的前置条件检查：域名必须先被 Cloudflare 代理（橙云），否则 Access / 边缘限流都无从谈起。 |
| `check-double-submit.mjs` | 浏览器级验证：连按两次发送，只能创建一个 run（真模型下每次都计费）。 |
| `check-empty-answer-note.mjs` | 浏览器级验证：模型只输出思考、没有正文时，界面必须给出说明（而不是只显示"完成"）。 |
| `check-failure-reason.mjs` | 浏览器级验证：三类失败都要在界面上给出原因（状态栏 + 失败卡片）。 |
| `check-first-real-run.sh` | 验证"操作者拿到 key 后的第 5 步"（first-real-run.sh）本身可用： |
| `check-no-dup-stream.mjs` | 浏览器级验证：同一 run 只订阅一次 → 助手文本不重复、产物卡只有一张。 |
| `check-send-before-session.mjs` | 浏览器级验证：会话列表还没回来（或很慢）时立刻发送，也必须能建出 run。 |
| `check-session-ops.mjs` | 浏览器级验证（确定性、临时实例）：会话筛选 → 重命名 → 两段删除 |
| `check-slow-model-flow.mjs` | 端到端"慢模型"演练（尽量贴近 ① 的验收形状，但不依赖真实厂商）： |
| `check-streaming-deltas.mjs` | 流式分片的渐进渲染：模型分多片返回时，界面应在过程中就看到文字增长， |
| `concurrency-smoke.sh` | 并发冒烟：同时发起 N 个 run，全部批准后校验 |
| `doc-append.mjs` | 往回流文档插入一段内容，并且**插入后自检**： |
| `docs-check.sh` | 文档体检：让文档里的数字与命令跟着代码走，而不是靠人记得改。 |
| `first-real-run.sh` | 真模型接入后的"第一次验收"：一条命令跑完 目标→工具→审批→产出，并打印证据。 |
| `lib-login.sh` | 共享：登录并容忍 429（验收器跑过登录爆破后，登录桶可能还在窗口内） |
| `maintenance.mjs` | node scripts/maintenance.mjs [--db PATH] [--report\|--prune-events N] |
| `mock-provider.mjs` | OpenAI 兼容的本地 mock（流式），只为验证"接线"：先给 tool_call（需审批），再给最终文本。 |
| `model-doctor.mjs` | 模型配置自检：一眼看出线上是真模型还是假模型；--probe 会真发一次请求。 |
| `mutation-probe.sh` | 变异探针：故意改坏一处实现，确认测试会红——证明这套测试真的在管事，而不是全绿摆设。 |
| `mutation-sweep.sh` | 变异批量扫描：逐条改坏实现 → 跑全量测试 → 记录"是否变红" → 还原。 |
| `orphan-drill.sh` | 孤儿 run 演练：模拟「工具执行中途进程被杀」，验证启动收敛把 running 标成 failed。 |
| `preflight-model.sh` | 接通真实模型前的体检：缺什么、地址通不通、key 文件权限对不对。 |
| `provider-conformance.mjs` | 给定任意 OpenAI 兼容端点，逐项验证"我们的驱动是否与它兼容"。 |
| `ratelimit-check.sh` | 限流证据：在临时实例上把 api 桶打满，验证 429 + retry-after + 桶之间互不影响。 |
| `readiness-report.mjs` | 生成"当前就绪状态"快照：所有数字都来自现场执行，不手写。 |
| `restart-drill.sh` | 重启韧性演练：审批挂起时重启服务，恢复后批准，必须「只执行一次」。 |
| `restore-drill.sh` | 恢复演练：把备份还原到临时库，用独立实例起一遍，验证数据可用——不碰线上。 |
| `round-close.mjs` | 回合收口的硬约束：**文档补丁先落地并自检通过，才允许写投递记录**。 |
| `secret-leak-scan.sh` | 密钥外泄扫描：口令/令牌会不会出现在「日志」或「数据库行」里。 |
| `secret-scan.sh` | 目标约束自查：「密钥不入库」。 |
| `unblock.sh` | 解除阻塞：把"缺凭据"这件事压缩成一条命令。 |
| `upgrade.sh` | 一键在线升级：fetch → 判断落后 → 快进合并 → 跑测试 → 重启服务 |
| `verify-all.sh` | 一条命令跑完所有可自动验证的证据，并给出统一结论。 |
| `verify-online.sh` | 线上验收：先等就绪，再逐项断言。避免"重启窗口"被误记成故障。 |
| `verify-persistence.sh` | 持久化演练：造一条数据 → 重启服务 → 读回来。会重启 cube-agent.service。 |
