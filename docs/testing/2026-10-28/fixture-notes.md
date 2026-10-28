# 浏览器测试数据

测试数据仅为本次测试生成，业务代码未更改。临时目录记录在父代理运行上下文，测试结束后由父代理移入废纸篓。

- 隔离 `agent`：仅测试用 models/settings/auth、会话、skill 与 prompt。
- 隔离 `home`：Node ESM preload 只替换 `node:os.homedir()` 并同步 builtin ESM exports，不设置或更改 `HOME`。
- 隔离 `workspace`：README、TypeScript、中文 Markdown、长文本和 SVG 图片；Git 基线、暂存修改、未暂存修改和未跟踪文件。
- 预制 v3 Pi 会话：用户消息、思考、`read` 工具调用与结果、Markdown 正文、代码、表格、引用和本地文件链接。
- 两条 Claude 来源对话：用于扫描、筛选、批量导入、归档与恢复流程。
- 本机确定性 OpenAI Chat Completions provider：只监听 `127.0.0.1:34128`，不向外联网、不使用真实凭据。它用于重复触发确定的流式、取消、队列、错误与选择题状态，不能替代真实模型能力测试。

Provider 指令：普通消息返回分片 Markdown；`[slow]` 每 700ms 返回一个片段，持续足够长便于测试取消/插话/队列；`[ask]` 调用两题（单选和多选）`ask_user_question`；`[tool]` 调用 `read README.md`；`[error]` 返回 HTTP 429。工具结果返回后，再次请求会输出正常 Markdown，避免重复工具调用。

验证：SDK `SessionManager.listAll()` 能列出预制会话和 4 条消息；SDK `ModelRuntime.create({allowModelNetwork:false})` 能识别并认证 `ui-fixture/test-model`；SDK `streamSimple` 实际调用本机 provider，收到完整 Markdown 并以 `stop` 结束。
