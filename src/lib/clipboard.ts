/**
 * 剪贴板工具：优先用异步 Clipboard API，非安全上下文（局域网 http）退回 textarea + execCommand。
 * 从 ChatWindow 抽出来共用（消息操作行与提示词面板都用它）。
 */
export async function copyText(text: string): Promise<boolean> {
	try {
		if (navigator.clipboard?.writeText) {
			await navigator.clipboard.writeText(text);
			return true;
		}
	} catch {
		// Non-secure local-network contexts need the legacy fallback below.
	}
	const field = document.createElement("textarea");
	field.value = text;
	field.style.position = "fixed";
	field.style.opacity = "0";
	document.body.appendChild(field);
	field.select();
	try {
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		field.remove();
	}
}
