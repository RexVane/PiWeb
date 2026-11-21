# PiWeb 扩展样板（JSON UI）

三个可复制的样板，演示同一份扩展数据如何分别提供终端面板和 PiWeb 网页面板。维护日期：2026-11-18。

| 文件 | 演示什么 | 命令 |
|---|---|---|
| `todo-panel.ts` | 进度条 + 可点列表 + 点完回传 action | `/todo` |
| `review-gate.ts` | 代码块 + 用列表当操作按钮 + 二级面板 | `/review` |
| `status-board.ts` | 表格 + 表单（input / confirm）提交回传 values | `/board` |
| `lib/piweb-ui.ts` | 节点构造器 + `piwebUi(ctx.ui)` 判定 + 终端兜底 | — |

> `lib/` 是有意放成子目录的：pi 只自动加载扩展目录**第一层的 `.ts`** 与 `*/index.ts`，
> 所以辅助文件放在 `lib/` 里不会被当成扩展加载，但可以被 `import` 进来。

## 怎么试

从本仓库根目录执行。下面使用默认 agent 目录；设置过 `PI_CODING_AGENT_DIR` 时改用对应路径。先检查目标同名文件，已有自己的修改时不要直接覆盖。

PowerShell：

```powershell
$extensionDir = Join-Path $env:USERPROFILE '.pi\agent\extensions'
New-Item -ItemType Directory -Path (Join-Path $extensionDir 'lib') -Force | Out-Null
Copy-Item -LiteralPath 'examples/piweb-extensions/todo-panel.ts', 'examples/piweb-extensions/review-gate.ts', 'examples/piweb-extensions/status-board.ts' -Destination $extensionDir
Copy-Item -LiteralPath 'examples/piweb-extensions/lib/piweb-ui.ts' -Destination (Join-Path $extensionDir 'lib')
```

Bash：

```bash
# 注意：pi 只发现扩展目录「第一层」的 .ts 和「*/index.ts」，所以不能整个塞进子目录
EXT=~/.pi/agent/extensions
mkdir -p "$EXT/lib"
cp examples/piweb-extensions/todo-panel.ts examples/piweb-extensions/review-gate.ts examples/piweb-extensions/status-board.ts "$EXT/"
cp examples/piweb-extensions/lib/piweb-ui.ts "$EXT/lib/"

# 想只在某个项目里用：放到 <项目>/.pi/extensions/（同样平铺），并确保项目已信任
```

装完从**侧栏 → 扩展**进入资源页，选择目标工作区并刷新列表。默认位置对应个人、本地来源；放在项目 `.pi/extensions/` 时对应项目来源，先信任该项目。扩展页已独立于设置面板。

资源变化会在读取和会话执行边界检测；手动刷新可重新检查。正在执行的会话需等待空闲后应用，留意加载错误或延后应用提示，再调用命令。

然后在 PiWeb 里开个会话，输入 `/todo`、`/review`、`/board`：

- **PiWeb**：会弹出网页风格的卡片（进度条、列表、表格、表单）
- **pi 终端**：同一个命令走原来的字符渲染

## 写自己的扩展时

1. 复制 `piweb-ui.ts` 到你的包里（它不依赖 PiWeb 源码）；
2. 把“要显示什么”拼成树：`col(...)` / `txt(...)` / `list(...)` / `table(...)` / `form(...)`；
3. 打开方式：

```ts
const web = piwebUi(ctx.ui);
if (web) {
  const result = await web.web(tree, { title: "我的面板" });
  // result: { action } | { values } | undefined
  // 检查 action、字段名及值；取消、超时、中止、无人值守均可能无结果。
} else {
  await openTerminalPanel(ctx.ui, { render: (w) => lines }, { title: "我的面板" });
}
```

4. 没有 `web` 分支时，兼容终端组件的单次 `render(80)` 结果可作为只读文本显示；不支持键盘交互或持续重绘，依赖真实终端的组件仍可能没有结果。

`web()` 默认等待最多 10 分钟；浏览器暂时离开后可回到会话作答。无人值守会话中的交互立即报告不可用，所以这些交互式示例不适合作为无人值守会话的入口。扩展仍在宿主执行；JSON UI 白名单只约束页面渲染，不隔离扩展代码。

完整的节点表、字段含义、服务端限制见 [docs/extension-web-ui.md](../../docs/extension-web-ui.md)。
