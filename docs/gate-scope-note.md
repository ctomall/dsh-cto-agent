# 升级门禁范围说明

- 默认跑**冒烟子集**（5 个测试文件）：快，覆盖租户隔离、SSE 续传、升级本身、限流、身份门。
- `UPGRADE_TEST_SCOPE=full`：升级时枚举 `impl/test/*.test.mjs` 全部跑（本机 53 个文件，约 1–3 分钟）。
- 为什么不能传目录：`node --test impl/test` 在 Node 24 会把目录当模块 require，报 `MODULE_NOT_FOUND`（v135→v136 的坑）。
- 门禁失败必回滚：实测返回 `500 {"error":"tests_failed_rolled_back","detail":"…node --test impl/test"}`，线上 SHA 保持旧值。
