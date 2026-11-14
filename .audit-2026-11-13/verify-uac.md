# UAC 提权通道实测（lead，2026-11-13 19:5x）

对象：审计报告附录 C 第 5 条「UAC 提权未实测」——即沙箱里的 Low 完整性进程能否用 `Start-Process -Verb RunAs` 一步跳出所有边界（sandbox P2-10）。

## 1. 本机 UAC 策略（注册表实测）

```
HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System
  EnableLUA                   = 1     ← UAC 开启
  ConsentPromptBehaviorAdmin  = 5     ← 非 Windows 二进制：提示"是/否"（默认值，**不是** 0=不提示直接提权）
  ConsentPromptBehaviorUser   = 3     ← 标准用户：提示输入管理员凭据
  PromptOnSecureDesktop       = 1     ← 提示在安全桌面（屏幕变暗，普通进程无法代点）
  EnableInstallerDetection    = 1
  FilterAdministratorToken    = (空)  ← 未启用"管理员批准模式对所有账户生效"的额外限制
```

## 2. 当前进程的完整性/组成员

```
whoami /groups
  Mandatory Label\Medium Mandatory Level         S-1-16-8192
  BUILTIN\Administrators                         S-1-5-32-544   "Group used for deny only"
```

即：当前是**管理员账户的非提权进程**（Medium），Administrators 组为 deny-only。这也是 PiWeb 宿主进程的起点。

## 3. 结论

| 问题 | 结论 | 依据 |
|---|---|---|
| Low 进程能否**静默**提权（无人值守） | **不能** | `ConsentPromptBehaviorAdmin=5` 表示需要用户点"是"；`PromptOnSecureDesktop=1` 让提示显示在安全桌面，普通进程既不能代点也不能遮挡/伪造它 |
| Low 进程能否**发起**提权请求（弹框） | **能（机制可达）** | `runas` 动词由 AppInfo 服务处理，不要求调用方持有特权；受限令牌不影响这个 IPC 通道。**未实测实际弹框**——那会在你桌面弹窗并需要你点"是/否"，属于干扰操作，故按静态机制结论处理 |
| 用户误点"是"之后 | **完全跳出所有边界（High 完整性）** | 这是设计使然，不是 PiWeb 的漏洞：任何程序都能提示提权。风险点是**模型可以主动发起这个提示**（`powershell -c "Start-Process cmd -Verb RunAs"`），文案由模型控制，具备钓鱼条件 |
| 是否应升级为 P0 | **不升，维持 P2-10** | 需要用户主动点击 + 安全桌面不可伪造；它属于"社交工程面"而非"自动逃逸"。但应在 `docs/workspace-isolation.md` 的"不限制的东西"里显式写上这条（现在没写） |

## 4. 可选的加固（低成本）

1. 沙箱启动时给子进程设置 `PROCESS_CREATION_MITIGATION_POLICY` 里能拦的部分有限，**真正有效的是 UI 层**：不给模型 `powershell`/`pwsh`（现状已如此，readonly/workspace 档都拒），`bash` 档才是入口 → 在 workspace 档的 shell 里禁掉 `runas` 不现实（任意程序都能弹），只能靠提示与文档。
2. 文档补一条：模型在受限档仍可发起 UAC 提示，请只在看懂来源时点"是"。
3. 长期：给沙箱子进程换 Job Object + `JOB_OBJECT_UILIMIT_*`（限制 UI 能力）能减少一部分（不拦 UAC，但拦窗口/剪贴板）。

## 5. 仍未验证

- 实际弹框与点击"是"后的行为（需要人点，属于会打断用户的交互）。
- `EnableLUA=0` 的机器上（UAC 关闭）这一步会**变成静默提权**——那种环境下 P2-10 应该直接算 P1。本机不适用。
