/**
 * 技能命令展开的识别。
 *
 * 用户在输入框里发 `/skill:name args` 时，pi 会在 `_expandSkillCommand` 里把 SKILL.md 正文
 * 展开成提示词，格式是：
 *
 *   <skill name="computer-use" location="/path/SKILL.md">
 *   References are relative to /path.
 *
 *   ...正文...
 *   </skill>
 *   \n\n参数（有参数时才会追加）
 *
 * 这段展开文本会作为用户消息存进会话，所以重新打开会话时它依然在。直接渲染就是一大段
 * SKILL.md 正文；这里把它认出来，只留技能名给界面显示（正文与参数都不展示）。
 *
 * 保守起见只在整条消息「以 <skill 开头」时才认，避免把正文里恰好引用了这个标签的普通消息误判。
 */

export interface ExpandedSkill {
	/** 技能名（pi 展开时写入的 name 属性） */
	name: string;
	/** 用户在技能名后面打的正文（展开后追加在 `</skill>` 之后；没有则为空串） */
	args: string;
}

/** 整条消息就是一个技能展开时返回技能名与参数，否则返回 null */
export function parseExpandedSkill(text: string): ExpandedSkill | null {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("<skill ")) return null;
	const open = /^<skill\s+([^>]*)>/.exec(trimmed);
	if (!open) return null;
	const attrs = open[1];
	const name = /\bname\s*=\s*"([^"]*)"/.exec(attrs)?.[1]?.trim();
	if (!name) return null;
	// 必须能找到对应的闭合标签，才认定这是一次完整的展开（半截内容不认）
	const close = trimmed.lastIndexOf("</skill>");
	if (close < 0) return null;
	// 参数在闭合标签之后，与技能正文同属一条用户消息（pi 不单独发）
	return { name, args: trimmed.slice(close + "</skill>".length).trim() };
}

/**
 * 拿用户消息当标题 / 摘要时用的文本：技能展开还原成用户当初打的 `/skill:name 参数`，
 * 别的原样返回。会话列表、窗口标题、增长树的轮次标题都走它，不再露出 `<skill name=…>` 和 SKILL.md 正文。
 */
export function promptTitleText(text: string): string {
	const skill = parseExpandedSkill(text);
	if (!skill) return text;
	return skill.args ? `/skill:${skill.name} ${skill.args}` : `/skill:${skill.name}`;
}
