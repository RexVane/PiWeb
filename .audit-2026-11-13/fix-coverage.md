# 分支覆盖门槛

2026-11-14，补报告 §6 测试缺口 #17，保留历史覆盖率原始证据。

- 将精确匹配 Vitest 5.0.5 的 `@vitest/coverage-v8@5.0.5` 加入 devDependencies 和 lockfile；不依赖开发机曾经临时安装的 provider。
- `vitest.config.ts` 使用 v8，覆盖 `src/**`，输出 json-summary / text-summary；全局 branches 门槛 70%。
- 独立关键模块 branches 门槛暂定 `usePiWeb.ts` 53%、`git-service.ts` 42%，依据修复前实测 53.11% / 42.85%；最终完整回归后核对新实测，不以旧数据冒充修复后结果。
- `PIWEB_COVERAGE=1` 开启配置，CI 在已有 `npm run check` 的唯一测试轮次中启用，结果写 runner.temp；无重复全量测试。开发机也可使用 `--coverage`。
- `PIWEB_COVERAGE_REPORT_DIR` 可为每轮指定新目录，避免覆盖原审计证据。

已验证：最新 `tsc --noEmit --incremental false` 通过，配置/依赖/CI diff-check 通过。最终完整覆盖率由 root 统一执行，尚未在本区域重复整跑。

安装时出现既有 jsdom 30.0.1 engine 提示：要求 Node ^22.22.2 / ^24.15.0 / >=26，本机 24.12.0 和旧 CI 22.19.0 不在支持范围。未因此变更产品 Node 最低版本；CI 运行版本由 root 统一调整。

CI矩阵现用Node22.22.2 / 24，任务预算升为45分钟容纳带插桩回归、构建和实际成品安装；产品engine最低22.19.0保留。`check.yml` 和独立联网 `remote-e2e.yml` 解析正常，typecheck再次通过。
