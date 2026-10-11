/**
 * 按字节截断但不切开 UTF-8 多字节字符：边界落在字符中间时，把这个不完整的字符整个丢掉，
 * 否则 toString("utf8") 会在末尾吐出 U+FFFD（中文预览截断处出现乱码方块）。
 */
export function utf8Prefix(bytes: Buffer, maxBytes: number): Buffer {
	if (bytes.length <= maxBytes) return bytes;
	let end = maxBytes;
	// bytes[end] 是第一个被丢掉的字节；它是续字节（10xxxxxx）说明字符从前面开始，最多回退 3 步
	while (end > 0 && end > maxBytes - 4 && (bytes[end] & 0xc0) === 0x80) end -= 1;
	return bytes.subarray(0, end);
}

export interface SanitizedToolOutput {
	text: string;
	encodingLoss: boolean;
}

/**
 * Legacy Windows PowerShell sessions may contain U+FFFD because output bytes
 * were decoded before PowerShell switched to UTF-8. The original bytes are no
 * longer recoverable, so retain readable lines and flag the loss for the UI.
 */
export function sanitizeToolOutput(value: string): SanitizedToolOutput {
	if (!value.includes("\uFFFD")) return { text: value, encodingLoss: false };
	const readableLines = value
		.split(/\r?\n/)
		.filter((line) => !line.includes("\uFFFD"));
	return {
		text: readableLines.join("\n").replace(/\n{3,}/g, "\n\n").trim(),
		encodingLoss: true,
	};
}
