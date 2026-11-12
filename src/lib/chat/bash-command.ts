/**
 * `!` 命令：输入框里以 `!` 开头的内容直接在工作区跑（pi 终端的 bash 模式），不经过模型。
 * `!!` 开头时结果不进模型上下文。规则与 pi 一致，另外排除两种明显不是命令的写法。
 */
export interface BashCommand {
	command: string;
	excludeFromContext: boolean;
}

export function parseBashCommand(text: string, hasAttachments = false): BashCommand | null {
	// 带图片的是发给模型看的消息；Markdown 图片 `![说明](地址)` 开头的也是（常见于粘贴）
	if (hasAttachments || !text.startsWith("!") || text.startsWith("![")) return null;
	const excludeFromContext = text.startsWith("!!");
	const command = text.slice(excludeFromContext ? 2 : 1).trim();
	// 只有感叹号（"!"、"!!"）不是命令，照常当文字发
	return command ? { command, excludeFromContext } : null;
}
