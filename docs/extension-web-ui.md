# 扩展的网页 UI（JSON UI 桥）

维护日期：2026-11-18。pi 扩展可通过 `ctx.ui.custom()` 构造终端组件；PiWeb 能尝试读取其 `render(width)` 结果，但不能复现终端交互。需要网页交互时，扩展给出一棵**白名单节点组成的 JSON 树**，PiWeb 用自己的组件渲染。

样式跟随网页主题，扩展不需要另打包前端。桥接层裁剪节点，不接收任意 HTML、JavaScript 或 DOM 操作；扩展自身仍在宿主进程运行，这个 UI 协议不构成扩展代码隔离。

## 用法

```ts
import { piwebUi } from "./lib/piweb-ui";

// 在扩展命令的 handler 中；helper 随样例提供，不依赖 PiWeb 源码。
const web = piwebUi(ctx.ui);
if (!web) return; // 此处分支可调用你原来的终端渲染器。

const result = await web.web({
  type: "box",
  direction: "column",
  children: [
    { type: "text", text: "Tasks 3/7", tone: "accent" },
    { type: "list", selected: 1, items: [
        { label: "写测试", description: "in progress", action: "task:1" },
        { label: "改文档", description: "todo", action: "task:2" },
    ]},
    { type: "progress", value: 0.43, label: "完成度" },
  ],
}, { title: "任务", timeout: 60_000 });
if (result?.action === "task:1") {
  // 按扩展自己的业务规则处理选择。
}
```

返回**用户的选择**：

- 点了 `list` 项 → `{ action: "task:1" }`
- 提交了 `form` → `{ values: { 字段名: 值 } }`
- 用户取消、超时、中止或会话销毁 → `undefined`。

`web()` 在没有浏览器观看时仍保留待回答请求，用户返回会话后可以作答；默认超时 10 分钟，`timeout` 单位为毫秒。无人值守自动化则立即返回 `undefined`，并报告交互不可用，不等待用户或自动批准操作。底层入口还接受 `signal`（`AbortSignal`）和 `text`（纯文本兜底）；样例 helper 只声明常用的 `title` / `timeout`。

返回值来自浏览器，不要仅凭类型声明就执行删除、写入或其他有影响的操作。扩展仍应检查 `action` 是否在自己展示的选项中、表单字段名及值是否有效，并处理取消。这个桥不提供额外权限批准。

## 节点表

| type | 字段 | 渲染成 |
|---|---|---|
| `box` | `direction?: "row" \| "column"`、`gap?: 0..24`、`children` | 布局容器 |
| `text` | `text`、`tone?`（default/muted/accent/success/warning/danger）、`mono?` | 段落 |
| `list` | `items[{label, description?, action?, disabled?}]`、`selected?` | 可点列表 |
| `table` | `columns: string[]`、`rows: string[][]` | 表格 |
| `progress` | `value: 0..1`、`label?` | 进度条 |
| `code` | `text`、`language?` | 等宽代码块 |
| `form` | `fields[{kind: input/select/confirm, name, label, placeholder?, value?, options?}]`、`submitLabel?` | 表单 |

## 限制（服务端强制，超了截断或丢弃）

| 项 | 上限 |
|---|---|
| 树深 | 10 层（根为第 1 层） |
| 节点总数 | 400 |
| 单段文本 | 4000 字符（`code` 8000） |
| box 子节点 | 60 |
| list 项 | 200；label / action 各 400 字符，description 800 字符 |
| table | 200 行 × 12 列；列名 120 字符，单元格 400 字符 |
| form | 20 个字段；name 80 字符，label / placeholder 200 字符，初始 value 400 字符 |
| select options | 每字段 60 项，每项 200 字符 |
| 标题 / submitLabel | 200 / 80 字符 |

未知的 `type` 会被丢弃，不会报错——扩展写错了不该让会话崩。

## 没适配的扩展怎么办

`ctx.ui.custom()` 收到兼容的终端组件时，会用简化的终端/主题对象构造组件，调用一次 `render(80)`，去掉 ANSI 控制序列后作为**只读文本**显示。最多取 200 行，并受到代码节点 8000 字符的限制。它不转发键盘输入、不进行终端重绘，也不能完成依赖 `done()` 的终端交互；构造或渲染失败时返回 `undefined`，不保证任意终端组件都能显示。自定义页眉、页脚和编辑器仍无网页对应物。

## 迁移一个扩展的步骤

1. 找到所有 `ctx.ui.custom(...)`、以及自定义的卡片/面板渲染；
2. **保留**终端那一份，另加一个 PiWeb 分支：用同一份数据组装树，调 `ctx.ui.web(tree)`；
3. 用 `piwebUi(ctx.ui)` 检查 PiWeb 能力，避免直接访问官方 SDK 类型里没有的 `web` 字段；
4. 共用业务数据，分别处理网页返回值与终端输入，并覆盖取消、超时和无人值守分支。

```ts
const web = piwebUi(ctx.ui);
if (web) return web.web(tree);             // PiWeb
return ctx.ui.custom(terminalComponent);   // 终端
```

可运行样例见 [examples/piweb-extensions](../examples/piweb-extensions/README.md)。协议实现与类型分别在 [extension-ui.ts](../src/lib/extension-ui.ts) 和 [types.ts](../src/lib/types.ts)；UI 改动需同时核对这两个入口及相应组件测试。
