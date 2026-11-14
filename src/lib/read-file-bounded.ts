import fs from "node:fs/promises";

export class FileSizeLimitError extends Error {}

/** Check the open file and every read; a file growing after stat cannot evade the cap. */
export async function readFileBounded(file: string, maximumBytes: number): Promise<Buffer> {
	const handle = await fs.open(file, "r");
	try {
		const stat = await handle.stat();
		if (!stat.isFile()) throw new Error("Source is not a regular file");
		if (stat.size > maximumBytes) throw new FileSizeLimitError("Source exceeds the size limit");
		const parts: Buffer[] = [];
		let total = 0;
		for (;;) {
			const buffer = Buffer.alloc(Math.min(64 * 1024, maximumBytes + 1 - total));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, total);
			if (!bytesRead) break;
			total += bytesRead;
			if (total > maximumBytes) throw new FileSizeLimitError("Source grew beyond the size limit");
			parts.push(buffer.subarray(0, bytesRead));
		}
		return Buffer.concat(parts, total);
	} finally { await handle.close(); }
}
