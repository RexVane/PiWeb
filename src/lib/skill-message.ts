/** Presentation-only view of the SDK's expanded /skill message.
 * Keep the original message intact for model context, export and editing.
 * Only the complete, leading SDK envelope is recognized; examples and fenced code
 * in ordinary messages must remain ordinary Markdown.
 */
export function parseSkillMessage(text: string): { name: string; location: string; content: string; userMessage: string } | null {
	const match = /^<skill name="([^"\r\n]+)" location="([^"\r\n]+)">\r?\n([\s\S]*?)\r?\n<\/skill>(?:\r?\n\r?\n([\s\S]*))?$/.exec(text);
	return match ? { name: match[1], location: match[2], content: match[3], userMessage: match[4]?.trim() ?? "" } : null;
}
