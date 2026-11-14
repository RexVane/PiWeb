# Remote / models 修复记录

2026-11-13，保留用户要求的默认认证、动态二维码以及统一连接体验。本区域没有停止既有 PiWeb，没有访问带用户key的真实provider服务。

| 条目 | 结果 |
| --- | --- |
| P2-66 / P2-114 | 远程引擎由独立Node IPC watchdog所有：父Next意外退出/IPC断开时清理engine树；Windows taskkill /T /F，POSIX独立process group。supervisor主动停止也复用相同tree终止函数，并等待pending kill集合完成。测试用真engine子进程验证父IPC断开后的引擎消失。 |
| P2-71 / P3-24 | stopLan等待正在listen的promise，用独立lan generation取消迟到成功；后来的新start排在stop后。listen成功移除临时error监听，再挂持续error处理，更新UI状态并清隧道。manual startPublic也开启automatic retry。 |
| P2-103（Windows隧道fixture部分） | POSIX shebang fixture改为.cjs，由watchdog用node执行，移除Windows skipIf。11项API/process/http隧道生命周期在Windows真正执行通过。workspace picker 5项由另一owner修。真cloudflared E2E CI不在本子任务本机执行。 |
| P1-18 | SDK getError成为明确catalog错误，避免坏配置成功返回部分目录；临时checkAuth错误不存60秒缓存，并传authError到精简API和设置页可见提示。 |
| P1-18(c) / P2-110 | 能力映射增加limit.context/output、max_tokens、contextWindow/maxTokens、capabilities.image_input、structured reasoning.supported、image/* MIME。目录排除明确image/video/embedding等non-chat type；未知能力仍不猜。 |
| P1-27 | HTTP/HTTPS model discovery Agent跟随NODE_USE_ENV_PROXY配置；代理连接前先解析并拒绝任意私网地址，直连仍lookup pin公共地址，redirect依然拒绝，响应仍4MiB上限。 |
| P2-26 | 非空enabledModels无匹配时，pickInitialModel不再从允许范围外挑默认模型，与模型选择器的候选集合一致；相关配置/API专项通过。 |
| P2-27 | 用jsonc-parser leaf edits保留原BOM、未改的comments和trailing commas；SDK验证与revision锁保留。 |
| P2-28 | headers里的auth/cookie/token/key/secret以及!command脱敏，安全字段可见；保存保留同provider隐藏值。 |
| P2-30 | 列目录不执行models.json apiKey/header命令：命令provider跳过checkAuth，返回明确说明；scope matching用available snapshot避免再次credential执行。 |
| P2-70 | README_zh.md与实际网络策略一致：默认认证开启、设置代理覆盖环境/系统、生产自动准备统一单二维码，120秒过期且一次性；删除旧公网默认关闭和手动开启说明。 |
| P3-28 | 精简API带model.input，让发送端可以提前判断图像能力；authError也不被精简映射丢弃。 |
| P3-29 | provider usage复用4MiB bounded JSON reader。 |
| P3-16 | 最新UI实际只有displayName，不能编辑provider ID；保留内部ID格式/重复防守，新回归验证displayName为__proto__/existing仍保留gateway身份。 |
| Cold model catalog | cold session读取JSONL头16KiB内的cwd并用workspace私有目录；不会因为peek runtime不存在回global目录；pending session必须给cwd，不默选其他workspace。 |
| Launcher auth互操作 | final端口同步PORT与PIWEB_PORT；warmup消费token后，浏览器打开前重新读服务端发布的当前token。 |

验证：16份223项通过（23:08:41开始，30.39秒），涵盖models CRUD/auth/discovery/JSONC/credential/context/capability、ModelsSection roundtrip、remote自动重连与Windows fixture、stop/error及真watchdog断开。此后增加launcher warmup旋转token专项测试并另验收。`tsc --noEmit --incremental false` 全过。

产品策略P2-68/69按父Agent遵循用户统一远程需求裁定；RemoteSection/pair API及README文案由父Agent完成。这里不增加LAN/public双入口按钮，不改变用户要求的动态码产品流程。

末次补验：局域网转发入口在收到请求头时直接执行共享request guard，包括Expect；公网也经过同一入口。向上游立即flush头部，preload尊重独立入口自己的Expect处理，避免匿名请求先收到100 Continue。真实socket包含Content-Length/chunked/Expect三种remote head-only请求，立即401且未触及上游。remote/HTTP/update9份117项通过。

本机启动器改用持令牌文件凭据的私有IPC取得/刷新有效token；失联不使用未验证旧值，文件读取和验证间旋转时只重读重试一次。端点使用realpath及Windows大小写归一，目录junction/symlink别名也能复用同一实例。相关IPC/launcher/install4份54项通过。

P2-30补了真实SDK全链路而非fake runtime：隔离models/auth/store目录的models.json apiKey命令、header命令、auth.json key命令三种情况，默认ModelRuntime.create、refresh allowNetwork:false、getAvailable、checkAuth都没有执行marker。SDK当前check/read已识别命令且不求值，因此无需用私有SDK字段或删掉目录刷新来规避；页面列表仍跳过命令provider的主动check并显示说明。

P2-103最终补验（2026-11-14 00:13）：真实 cloudflared 2026.10.0，在仓库外独立 agentDir / 随机空闲端口，局域网注入代理 → 真隧道 → 公网页面 → 配对发码 → 公网兑换303 → Secure/HttpOnly Cookie → SIGNED-IN → 旧码不可复用，**1项执行并通过，39.29秒**；原始 `.audit-2026-11-13/tunnel-final.json`。Host fixture明确加入测试allowlist，未跳过前置guard；临时文件夹按用户规则送回收站。新增 `remote-e2e.yml` 在Linux/Windows push/PR执行真实联网链路，官方release固定版本及已核验SHA256。CI代码已核验YAML；本机仍不代替Linux/远端CI结果。

P2-70中文文档已对齐默认认证、设置代理覆盖环境/系统代理、自动统一二维码（120秒/一次性）和生产自动准备连接，删除旧“公网默认关闭/手动开启”说明，保留单二维码产品约束。

P2-103另5项Windows picker已真正执行：只替换APP_ROOT中的交互脚本，用真实powershell.exe、生产-STA/-File参数和UTF8输出；成功/取消/失败/无效路径/远程不调用全过。无需修改workspace-store实现，移除posixPicker skip与白名单。picker+skip守卫两份最终11项全过（00:35:13）。主回归仅允许独立remote-e2e job覆盖的那一条网络用例在PIWEB_TEST_TUNNEL!=1时跳过；独立联网job同样执行JSON skip守卫，启用联网后任何跳过都失败。

P2-26源码核对：非空enabledModels无匹配时pickInitialModel不再从范围外挑默认模型，与选择器一致。P2-32服务端保存已触发每会话reload/swapCurrentModelObject，busy留待轮结束；API改为requiresSessionReopen:false，避免旧提示强制重开。API配置37项通过（00:38:48）；ModelsSection持久提示/回调与AppShell目录刷新由data/root完成，reload失败仍须明确显示并可重试，不将“自动尝试应用”冒充全部成功。

P3-26最后API收口：models GET/POST、models/defaults GET、update GET/POST统一apiError，不返回500中的系统路径/命令/凭据细节；400验证和409配置/更新冲突保留可区分状态，null模型body也按400处理。成功及失败均no-store，未知失败有中文重试提示，已知OS类别仍保留errorCode。4份API/config专项64项全过（00:51:11），最新tsc及diff-check通过。
