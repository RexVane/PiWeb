# 历史分页与图片展示补齐

为root收口后的有界快照补可查看的历史入口；不删除原会话，不串接无限消息数组。

- `SessionHistory`独立模态每页最多100条，before向较早、after向较新，随时回最新页；成功替换页面，失败保留当前页并可重试；切会话/关闭取消请求，晚到页不会显示到其他会话。
- 明确旧消息仍保存在会话中；长内容预览标记和完整JSONL导出入口常驻。展示消息、摘要、命令、折叠思考和工具记录，本轮不增加轨迹专用UI。
- `/api/sessions/[id]/history`先验证session路径，再调用getManaged/getSessionHistory，不启动Agent。before/after互斥、非负安全整数、limit为1…100；错误不返回系统路径，响应no-store。
- `/api/sessions/[id]/images`只按persisted entry/part查图，响应no-store/nosniff和raster MIME白名单。session路径受既有session store约束；GET走既有proxy认证。
- `ImageViewer`/`PreviewImage`和`ChatWindow`用户、助手、过程图片均接受服务端同源URL，缩略图lazy/async；不使用空base64生成假图，object URL的外部地址/可执行scheme不会加载。

验证：API/历史UI2份16项全部通过，覆盖页替换/双向游标/最新/重试/会话隔离、缩略图和光箱及聊天图片URL、非法scheme、分页边界、MIME、路径不泄漏。现有ChatWindow compaction/round-badge测试通过。最新 `tsc --noEmit --incremental false` 全过。

AppShell入口、snapshot.history和底层historyPage/previewMessage由root集成；正式生产验收等root在仓库外隔离stage运行，不触当前live。

末读补了图片URL规范化边界：根相对字符串中的换行/制表符会被浏览器移除，`/\n/external.example/...` 可能变为外部URL。对象图片URL现在拒绝反斜杠和控制/空白字符，已审批的Markdown string图片路径保持既有流程。新增三种真实URL规范化回归；历史UI和既有图片预览两份共15项全过（00:19:56）。
