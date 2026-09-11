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
