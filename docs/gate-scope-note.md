# 升级门禁范围说明

- 默认跑**冒烟子集**（5 个测试文件）：快，覆盖租户隔离、SSE 续传、升级本身、限流、身份门。
- `UPGRADE_TEST_SCOPE=full`：升级时**按仓库根**枚举 `impl/test/*.test.mjs` 全部跑（本机 53 个文件）。
- 两个必须记住的坑：
  1. `node --test impl/test` 在 Node 24 会把目录当模块 require，报 `MODULE_NOT_FOUND`——不能传目录。
  2. 服务的 cwd 是 `<repo>/impl`，枚举必须显式基于**仓库根**；否则 ENOENT 后静默回退冒烟集，**看起来是全量、实际只跑了 5 个**。
- 门禁失败必回滚：实测返回 `500 {"error":"tests_failed_rolled_back", …}`，线上 SHA 保持旧值。

- 门禁超时：`UPGRADE_TEST_TIMEOUT_MS`（下限 10s，默认 180s）。超时与"测试失败"分开报（`tests_gate_timeout(Nms)`），两者都会回滚。
- 每次升级响应里返回 `testsMs`（门禁实际耗时），便于发现耗时漂移。
