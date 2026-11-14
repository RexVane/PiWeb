# 服务端与启动脚本死代码清理

日期：2026-11-14。范围：src/lib、src/app/api、scripts、bin。未修改前端、产品文档、SDK 或在线服务；未删除整文件、目录或用户数据。

## 入口与引用核对

已阅读安装版 Next 16.4.5 的 `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` 和 `01-app/02-guides/instrumentation.md`。HTTP 方法导出、dynamic/runtime 配置、instrumentation.register 均为框架消费的入口，不以没有静态 import 判死代码。

编译器检查采用 `tsc --noEmit --incremental false --noUnusedLocals --noUnusedParameters`。修改前证据为 `dead-code-types-diagnostic.log`；修改后 `dead-code-types-after.log` 中本区已无 unused 诊断，剩余测试文件提示交由主 Agent/对应责任方处理。未改项目编译选项以隐藏提示。

scripts/bin 使用已安装 Babel parser 读取声明与引用，再人工核对 package.json、工作流、启动器、运行时和测试。对全部 src/lib 文件另查文件名引用，未发现无任何入口线索的孤立模块；此检查只作候选筛选，不能代替动态引用判断。

## 首轮清理的 17 个文件

| 文件 | 清理内容与引用证据 |
|---|---|
| src/app/api/prompts/route.ts | 私有 hotSession 的 cwd 参数未读取；唯一调用同步去掉该实参。GET 中工作区规范化与传给 listPromptSources 的 cwd 保留。 |
| src/app/api/workspaces/route.ts | getPinnedSessions 仅在 import 出现；GET 实际调用 getWorkspaceRegistry，移除多余导入。 |
| src/lib/agent-manager.ts | readFileSync、loadProjectContextFiles 仅 import；私有 describeEscalatedToolCall 无调用，移除。私有 abortRunAndWaitIdle 的 abortBash 标志未读取，两个调用统一保留原停止逻辑。公开 takeWritePatch 的第一个参数未使用但被 tests/write-diff 与事件处理按位置调用，仅改名 _cwd 保留接口。WRITE_PATH_FIELDS 仍被策略判定使用，未删除。 |
| src/lib/automations/runner.ts | listAutomations 仅 import；sawIdle 只初始化及赋值、从不读取，移除。真正结束信号 settledResolve 和忙态等待保留，未改变任务完成判断。 |
| src/lib/files-service.ts | exec=promisify(execFile) 无调用，连同两个仅用于它的导入移除；实际流式索引使用 spawn 保留。 |
| src/lib/growth-tracker.ts | needsInit 仅初始化及赋值、无读取；移除该状态并纠正相邻注释。consentRequest、同意判断与重试逻辑保留。 |
| src/lib/models-service.ts | 本地导入的 BalanceDetailKey 未使用，移除该 type import；向路由/客户端公开的 type re-export 保留。 |
| src/lib/pi.ts | readJsonObjectSync 仅 import，设置当前使用 JsoncSettingsStorage/readJsoncSettingsObjectSync，移除旧导入。 |
| src/lib/plugins-service.ts | fs/promises 仅 import，事务和配置写入已通过专用模块，移除多余导入。 |
| src/lib/remote/mobile-proxy.ts | checkExpectation 回调 req 不读取，但第二个位置必须是 response；仅改名 _req 保留事件签名与 417 行为。 |
| src/lib/sandbox/windows-acl.ts | ConvertStringSidToSidW 只创建 FFI 绑定、没有调用；移除无用绑定。实际令牌/ACL/进程 API 不变。 |
| src/lib/session-import/claude.ts | fs/promises 仅 import；实际读取由有界 files helper 执行，移除多余导入。 |
| src/lib/session-import/dsh.ts | fs/promises 仅 import；实际读取通过 zstd/files helper，移除多余导入。 |
| src/lib/session-import/grok.ts | fs/promises 仅 import；实际读取通过有界 files helper，移除多余导入。 |
| src/lib/session-import/oc-family.ts | ImportedMessage type、zcodeDb/opencodeDb 导入无读取；实际数据库路径通过 FamilyOptions.dbPath 注入，保留适配功能。 |
| src/lib/session-import/writer.ts | ImportedEntry 本地 type import 未使用，移除，导入格式类型定义不变。 |
| src/lib/web-auth.ts | 私有 decodeBase64Url 无调用，其独占依赖 encodeBase64Url/BASE64URL_PATTERN 一并移除。真正 cookie 编解码仍委托 scripts/web-auth-protocol.mjs，签名/严格校验逻辑未移除。 |

## 保留的容易误判入口

- bin/piweb.js：package.json.bin 与 start 指向它；bin/pi.js：npm run web 兼容入口。
- build/dev/postinstall/release/verify-package、图标同步脚本：package.json.scripts 明确引用。
- scripts/testing/prepare-sdk-tools.mjs、check-skips.mjs：check/remote-e2e CI 工作流引用。
- scripts/remote-engine.mjs：remote/supervisor.ts 以进程路径启动。
- scripts/pick-folder.ps1：workspace-store.ts 原生文件选择动态启动。
- scripts/http-request-guard.mjs、lock-child.mjs：启动器或 lock-child-env.mjs 以 NODE_OPTIONS --import 预加载。
- scripts/runtime/check-installed.mjs：verify-package.mjs 以已安装包路径执行；runtime-require/process-identity 等同时被脚本与服务端引用。
- scripts/apply-global.mjs：有明确手工维护 CLI、apply-global 测试及历史使用记录。不是无人引用废文件。
- scripts/web-auth-constants.mjs 与 update-environment.mjs 中少数常量在本文件只声明一次，但由其他模块导入；这些公开导出保留。
- package.json.files 包含 src/scripts/bin，说明它们随包发布；没有仅凭发布白名单认定任一模块必需，也没有仅凭静态 import 缺失将入口删除。

本区没有能够安全整文件或整目录删除的候选，因此没有提交需要批准的删除清单。

## 验证

- `dead-code-backend-tests.json` / `.log`：9 文件，134 passed / 0 failed / 0 skipped，30.14 秒。复用原有 write-diff、停止恢复、自动化、真实 Git 轨迹、认证、会话导入、文件服务、路由错误及 Windows 实际隔离回归；没有为简单删导入新增镜像测试。
- `dead-code-backend-typecheck.log`：标准 `tsc --noEmit --incremental false` exit 0。
- `git diff --check -- src/lib src/app/api scripts bin` exit 0；另有既存 github-identity 换行格式提醒，不是错误。

所有变更仅清理确定不使用的声明或私有参数，未进行架构改写；没有声称静态检查能证明整个项目不存在任何动态死代码。

## 导出符号补查

额外解析 src/lib、scripts、bin 的具名导出，在整个 src/tests/scripts/bin/examples/.github 和 docs、README、package.json、Next 配置中查调用/导入/动态字符串引用。导出类型、本文件内部仍调用的 helper、CLI/框架入口、测试接口均保留；没有为了消除候选而取消 export。

经主 Agent 确认后，清理以下三个全项目仅有声明、且当前实现已有替代的导出：

| 文件 / 导出 | 引用与替代证据 |
|---|---|
| scripts/file-lock.mjs / processAlive | 无调用或导入；锁归属和子进程判断实际直接使用 processIdentityAlive(pid, birth)，tests/file-lock 也直接验证后者。仅删除旧别名，不删仍使用的 processIdentityAlive 导入。 |
| src/lib/pi.ts / invalidateSettingsManagers | 无调用或导入；旧实现发起不等待的 reload 并清 packageManagerCache。当前 pi-settings 调用可等待的 reloadSettingsManagers，reloadAllLoaders 复用该流程并清缓存；保留这些有效入口。 |
| src/lib/jsonc-settings-storage.ts / editJsoncSettingsText | 无调用或导入；只是 objectFrom+私有edit 的无锁包装。实际 SDK/HTTP 写入通过 mutateJsoncSettingsFileSync/withJsoncSettingsFileSync 执行，保留其中仍被调用的 objectFrom 和 edit。 |

remote/mobile-proxy.ts 的 injectStyle 同样无本仓调用，但明确标为 deprecated 兼容名字，按兼容要求保留。其余“无外部引用”的导出中，常量/工具仍被本文件使用，类型用作返回值和公开结构；均不视为死实现。

补查清理后共触及本区 19 个不同文件，没有整文件/目录删除。`dead-code-exports-tests.json` / `.log`：2 文件 21 passed / 0 failed / 0 skipped，9.64 秒，涵盖真实进程锁与设置跨进程等待；`dead-code-exports-typecheck.log`：类型检查 exit 0。三个名称再次全范围搜索为零命中；限定 diff --check 通过。源码冻结，主 Agent 可执行最终整仓回归。
