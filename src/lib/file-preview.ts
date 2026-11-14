export interface DecodedFilePreview {
	content: string;
	binary: boolean;
	encoding?: "utf-8" | "utf-16le" | "utf-16be";
	encodingUnsupported?: boolean;
}

/** Decode only the bounded preview; incomplete boundary characters stay buffered. */
export function decodeFilePreview(bytes: Buffer, maximumBytes: number, truncated: boolean): DecodedFilePreview {
	let offset = 0;
	let encoding: NonNullable<DecodedFilePreview["encoding"]> = "utf-8";
	if (bytes.subarray(0, 4).equals(Buffer.from([255, 254, 0, 0])) || bytes.subarray(0, 4).equals(Buffer.from([0, 0, 254, 255]))) {
		return { content: "", binary: false, encodingUnsupported: true };
	}
	if (bytes[0] === 255 && bytes[1] === 254) { encoding = "utf-16le"; offset = 2; }
	else if (bytes[0] === 254 && bytes[1] === 255) { encoding = "utf-16be"; offset = 2; }
	else if (bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) offset = 3;
	const body = bytes.subarray(offset, maximumBytes);
	if (encoding === "utf-8" && body.includes(0)) return { content: "", binary: true };
	try {
		const content = new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(body, { stream: truncated });
		return { content, binary: false, encoding };
	} catch {
		return { content: "", binary: false, encodingUnsupported: true };
	}
}
