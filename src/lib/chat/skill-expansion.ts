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
}

/** 整条消息就是一个技能展开时返回技能名，否则返回 null */
export function parseExpandedSkill(text: string): ExpandedSkill | null {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("<skill ")) return null;
	const open = /^<skill\s+([^>]*)>/.exec(trimmed);
	if (!open) return null;
	const attrs = open[1];
	const name = /\bname\s*=\s*"([^"]*)"/.exec(attrs)?.[1]?.trim();
	if (!name) return null;
	// 必须能找到对应的闭合标签，才认定这是一次完整的展开（半截内容不认）
	if (!trimmed.includes("</skill>")) return null;
	return { name };
}
