# 前端核验与补修记录

日期：2026-11-14。范围为 `rev-ui1.md` 的 AppShell / ChatInput / SessionSidebar 关联项，以及 `rev-ui2.md` 的导入、通用设置、代理显示项。模型设置项已另记于 `verified-plugins-models.md`。此记录区分 root 已实现的修复与补验中实际新发现的缺口，不把静态报告的全部推断直接判为缺陷。

## 已核验的修复

| 报告条目 | 处置与行为 | 验证 |
|---|---|---|
| rev-ui1：输入框发送/停止/上传/错误状态跨会话 | 已有修复 `MemoChatInput key={draftKey}`，本轮保留并补验。草稿和上传归属继续由父层按会话保存。切换会话后本地状态重新创建，A 的异步完成回调仅修改 A 的草稿。 | 新增 A 发送挂起时切 B：B 能编辑，A 成功或失败均不改 B 内容或错误，返回 A 后分别为空或保留原文。已有晚到上传归属、Hero 迁移和 streaming 不多次渲染输入框回归同时通过。未新增真实浏览器停止操作验收。 |
| rev-ui1：侧栏每击键搜索 | root 添加 300 ms 防抖；关闭搜索立即清空查询并撤销未触发的计时器。 | 连续 a/ab/abc 仅回调 abc 一次；关闭后待定 abcd 不触发。服务端匹配不二次过滤、归档匹配、加载更多不能重复提交均通过。 |
| rev-ui1：错误文案硬编码中文 | root 将草稿持久化、模型目录刷新、等待模型应用、应用期间换会话四处文案接入中英字典。 | 逐处源码检查，未为四个文案分别增加运行时测试。 |
| rev-ui1：取回队列图片无发送预算 | root 保留全部取回内容，超限提示并在发送前拒绝超过 20 张或总 base64 预算的草稿。用户可以删减后再发，不静默丢弃排队内容。 | 21 张恢复图片全部显示，尝试发送不调用 onSend。另补下方跨刷新持久化缺口。 |
| rev-ui1：删除 A 晚回将用户从 B 拉走 | root 为删除路径增加当前会话引用守卫，与归档路径一致。 | 删除/归档 A 在途切 B，完成后均不导航；归档失败仍传回确认框。 |
| rev-ui2：切语言中止导入 | root 使 scan 回调不依赖翻译对象，错误文案通过 ref 读取。组件语言变化不会触发清理；真正卸载仍取消导入。 | 真实 I18nProvider 切 zh→en 时，挂起的 NDJSON 请求 signal 未取消、未额外扫描；送达结果后报告显示、会话变更事件发出。卸载时 signal 取消且流 reader 的 cancel 被调用。 |
| rev-ui2：重试次数非法/保存失败显示未保存值 | root 在非法值及保存失败时恢复最近已保存的值，作用域改变时不把旧请求结果写入新作用域。 | 空串、负数、小数、超过 1e9 均回滚且不发 PUT；网络错误、HTTP 500 回滚；保存 6 成功后保存 9 失败恢复 6，7 项通过。 |
| rev-ui2：自动代理伪装成已保存值 | root 将自动探测地址仅放 placeholder；input value 绑定手动保存值或草稿。 | 更新原有期待：自动代理出现时 value 为空、placeholder 有地址、不调用保存；清空手动代理失焦后仍为空；测试请求继续用空 proxy 代表自动模式。共 6 项通过。 |

## 补验中新发现并修复

1. **StrictMode 首次打开导入面板可能显示空列表。** 第一次 effect 的清理会取消初始扫描；第二次 effect 因扫描仍在进行而排队，但原实现会复用已经取消的 controller。新增尊重 AbortSignal 的网络桩后实测失败。现每轮扫描创建独立 controller，取消结果不更新列表，并以 mounted 引用阻止真正卸载后的排队扫描。修复后 StrictMode 第二次扫描成功；真卸载丢弃排队扫描。
2. **取回超发送限制的草稿，在刷新时丢失整份内容。** AppShell 恢复存储时仍将超过 20 张图片或 200,000 字的记录直接跳过，与“取回内容全部保留”的行为冲突；新回归先证实从队列取回、写入存储后重挂载丢失。现恢复阶段保留这些可编辑内容，继续执行整个存储 10,000,000 字符预算与原有结构检查，发送阶段仍严格拒绝超限。分别验证 21 张图片与 200,001 字文本经过真实组件保存/重挂载仍在，尝试发送均被拒绝。

本批新增业务代码仅在 `src/components/SessionImportSection.tsx` 和 `src/components/AppShell.tsx`；通用设置/代理的 root 实现未再次改写。

## 不作为新缺陷或保留边界

- 不同查询或分页上限具有不同响应，旧查询的 ETag 不应直接复用于新查询；换查询回到 200 条初始页也是正常语义。本批修复并测试的是击键防抖，没有声称实现跨查询缓存或完全消除重新读取。
- cookie 有语言偏好时 SSR 与首次水合一致，已有回归通过。cookie 缺失、仅 localStorage 有旧偏好时仍先显示默认中文、水合后迁移偏好并写 cookie；服务端无法直接读取 localStorage。此退化路径保留并明确记录，未宣称 cookie 永久被阻止时首帧也能命中本地偏好。
- `layout.tsx` 的常量主题脚本仍位于 head。中间及最终 production 成品的真实 HTTP HTML 均已验证该脚本存在于 `</head>` 之前，没有观察到报告推测的剥离；无需仅为该推测改动实现。
- 未扩展为所有前端组件全量复审，未运行整仓测试/构建，未触碰 live 30141；没有模型调用或使用用户凭证联网。

## 验证证据

- 最终本批：`ui-final-v2-tests.json` / `.log`，**11 个文件、79 passed、0 failed、0 skipped**，18.63 秒。覆盖导入面板/生命周期/删除刷新、General 重试、代理、AppShell 草稿/输入框渲染隔离/侧栏操作、侧栏搜索分页、队列图片、语言水合。
- 上一批 `ui-final-tests.json` / `.log` 为补草稿恢复前的 77 项，保留历史，不与 79 项累加。
- `ui-draft-recovery-before.log` 保留草稿丢失修复前的失败探针（用例过滤带来的 16 skipped 不属于最终套件）。
- `npx tsc --noEmit --incremental false` 在修复后的当前工作区通过，日志 `ui-typecheck.log` 为空且进程退出 0；先前 root 正在编辑的 project-settings-boundary 语法中间态已消失。

## 中间成品真实浏览器检查（不是最终验收）

`browser-stage1-v2.json`：新隔离 production build `5A6GQiBLKRu9xtl-nlrsS`，Chromium 156.0.8078.4，桌面 1280×800、触屏模拟 390×664，**36/36 通过**。包括匿名 API 拒绝、私有 IPC 登录/地址令牌清理、认证 cookie、SSR 语言和 head 脚本、首页/通用设置/模型设置及顶层技能扩展提示词自动化视图布局、移动收起侧栏 inert、可见触控目标 44px、非法重试输入不落盘且回滚。没有浏览器业务写请求、外部域名请求或运行时错误。

首轮 `browser-stage1.json` 的 4 个命中失败来自探针将模态遮罩下的后台按钮算入活动区域；修正探针仅核验当前模态/侧栏后全过，没有因此修改业务源码。截图保留于 `browser-stage1-v2-*.png`。本次 2516 独立实例及 launcher 已退出并复核无监听，stage 由成品 Agent 回收。后续插件事务等源码仍在变化，证据保持 `final:false`，最终构建需要重新验收。真实手机、iOS/WebKit 未测试。

## 最终成品真实浏览器验收

`browser-final.json` 明确 `final:true`，**37/37 通过**。使用源码冻结后新建的隔离 production 成品 `vHQvRhdHkn-_2oDSQbm-A`，其 748 个源文件快照 SHA-256 为 `5e8e1948ff57ea6eec8573f4a9542d497b1f1bded06e325fb2dbdc18989c7592`，与 `artifact-source-snapshot-final-v2.json` / `artifact-build-final-v2.json` 一致。没有复用中间 `.next` 或在线实例。

Chromium 156.0.8078.4，桌面 1280×800 与触屏模拟 390×664。覆盖匿名 API 401、私有 IPC 令牌登录与地址令牌清理、浏览器 Cookie 认证、SSR zh-CN、主题脚本位于 head、通用设置非法重试输入回滚且不写入、自动代理仅作 placeholder、模型导航状态与实际内容一致、首页/通用设置/模型/技能/扩展/提示词/自动化视图无横向溢出、移动侧栏 inert 与可见控件 44px/中心点可点击。额外人工查看 `browser-final-desktop-models.png` 和 `browser-final-mobile-settings.png`，未发现新的界面问题。

浏览器运行时错误 0、外部域名请求 0、业务写请求 0；使用独立空白数据，无真实模型调用或用户凭证。独立 launcher PID 50856 已退出，2516 无监听；在线 30141 未触碰。保留 `browser-final.json`、`browser-final-server.log` 和 `browser-final-*.png`，探针脚本收尾移入回收站。真手机、iOS/WebKit 不在本次验收范围内。
