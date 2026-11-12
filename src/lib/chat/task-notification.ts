/** Claude Code 后台任务自动生成的完整通知信封；普通提问、引用和代码块不匹配。 */
export function isClaudeTaskNotification(content: unknown): boolean {
	let text: string;
	if (typeof content === "string") text = content;
	else if (Array.isArray(content) && content.length > 0 && content.every((block) => block?.type === "text" && typeof block.text === "string")) {
		text = content.map((block) => block.text).join("\n");
	} else return false;
	const envelope = /^\s*<task-notification>([\s\S]*?)<\/task-notification>\s*$/.exec(text);
	if (!envelope || /<\/?task-notification>/.test(envelope[1])) return false;
	return /<task-id>[^<>]+<\/task-id>/.test(envelope[1])
		&& /<status>[^<>]+<\/status>/.test(envelope[1])
		&& /<summary>[\s\S]+?<\/summary>/.test(envelope[1]);
}
