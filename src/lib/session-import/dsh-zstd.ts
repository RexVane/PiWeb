/**
 * dsh 的会话是 **多帧拼接的 zstd**（`session.jsonl.zstd`）：部分运行环境的原生解压只处理第一帧，
 * 按完整帧结构和解压器消耗字节逐帧解压再拼起来，保留全部记录并拒绝截断尾帧。
 */
import fs from "node:fs/promises";
import { zstdDecompressSync } from "node:zlib";
import { readFileBounded } from "./files";
import { MAX_DECOMPRESSED_BYTES } from "./limits";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Node decodes one frame; bytesWritten is the authoritative boundary, including
 * magic bytes occurring inside compressed content. Never hide an incomplete tail. */
export function decodeZstdFrames(raw: Buffer, limit = MAX_DECOMPRESSED_BYTES): Buffer {
	if (raw.length > limit) throw new Error("压缩会话超过大小上限");
	if (raw.length < MAGIC.length || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
		// 不是多帧流（可能单帧或未压缩）：交给单帧解压，失败则原样当作文本
		try {
			return zstdDecompressSync(raw, { maxOutputLength: limit });
		} catch {
			return raw;
		}
	}
	const parts: Buffer[] = [];
	let total = 0;
	let offset = 0;
	while (offset < raw.length) {
		try {
			const { decoded, consumed } = decodeFrame(raw.subarray(offset), Math.max(1, limit - total));
			total += decoded.length;
			if (total > limit) throw new Error("解压会话超过大小上限");
			parts.push(decoded);
			offset += consumed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE" || total > limit) throw new Error("解压会话超过大小上限");
			throw new Error("压缩会话包含无法解压的数据", { cause: error });
		}
	}
	return Buffer.concat(parts, total);
}

function decodeFrame(raw: Buffer, maxOutputLength: number): { decoded: Buffer; consumed: number } {
	// Some Node versions also accept a truncated final block at flush. Validate the
	// complete frame structure before asking the decoder to produce any output.
	const frameBytes = zstdFrameBytes(raw);
	// @types/node does not yet model the documented info:true return object for zstd.
	const result = zstdDecompressSync(raw.subarray(0, frameBytes), { maxOutputLength, info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
	const consumed = result.engine.bytesWritten;
	if (consumed !== frameBytes) throw new Error("Invalid zstd input consumption");
	return { decoded: result.buffer, consumed };
}

/** Standard Zstd frame header followed by three-byte block headers and optional checksum. */
function zstdFrameBytes(raw: Buffer): number {
	if (raw.length < 5 || !raw.subarray(0, 4).equals(MAGIC)) throw new Error("Incomplete zstd frame header");
	const descriptor = raw[4];
	if (descriptor & 0x08) throw new Error("Reserved zstd frame flag");
	const singleSegment = Boolean(descriptor & 0x20);
	const contentSizeFlag = descriptor >> 6;
	const dictionaryBytes = [0, 1, 2, 4][descriptor & 3];
	const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : [0, 2, 4, 8][contentSizeFlag];
	let offset = 5 + (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
	for (;;) {
		if (offset + 3 > raw.length) throw new Error("Incomplete zstd block header");
		const block = raw.readUIntLE(offset, 3); offset += 3;
		const blockType = (block >> 1) & 3;
		if (blockType === 3) throw new Error("Reserved zstd block type");
		offset += blockType === 1 ? 1 : block >> 3;
		if (offset > raw.length) throw new Error("Incomplete zstd block payload");
		if (!(block & 1)) continue;
		if (descriptor & 0x04) offset += 4;
		if (offset > raw.length) throw new Error("Incomplete zstd frame checksum");
		return offset;
	}
}

export async function readZstdJsonl(file: string): Promise<string> {
	return decodeZstdFrames(await readFileBounded(file)).toString("utf8");
}

/**
 * 只解出前面的行即可判断会话是否值得导入（扫描用）：逐帧解压，凑够若干帧就停，
 * 避免为了列个表把 39MB 全解出来。
 *
 * `complete` 表示"解出来的就是全部内容"——真实文件能到 7559 帧，前 40 帧只覆盖开头一小段，
 * 所以只有 complete 为真时才能断言"这个会话里面没有消息"。
 */
export async function readZstdHead(file: string, maxFrames = 40): Promise<{ text: string; complete: boolean }> {
	const handle = await fs.open(file, "r");
	let raw: Buffer;
	let completeInput: boolean;
	try {
		const cap = 4 * 1024 * 1024;
		const buffer = Buffer.alloc(cap);
		const { bytesRead } = await handle.read(buffer, 0, cap, 0);
		raw = buffer.subarray(0, bytesRead);
		completeInput = (await handle.stat()).size <= bytesRead;
	} finally { await handle.close(); }
	if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) {
		try {
			const decoded = zstdDecompressSync(raw, { maxOutputLength: 1024 * 1024 });
			return { text: decoded.toString("utf8").slice(0, 64 * 1024), complete: completeInput && decoded.length <= 64 * 1024 };
		} catch {
			return { text: "", complete: false };
		}
	}
	const out: string[] = [];
	let decodedBytes = 0;
	let decodedFrames = 0;
	let offset = 0;
	while (offset < raw.length && decodedFrames < maxFrames) {
		try {
			const { decoded, consumed } = decodeFrame(raw.subarray(offset), 1024 * 1024);
			decodedBytes += decoded.length;
			if (decodedBytes > 4 * 1024 * 1024) break;
			out.push(decoded.toString("utf8"));
			decodedFrames += 1;
			offset += consumed;
		} catch {
			break; // Retain useful leading records, but never certify a broken tail complete.
		}
	}
	return { text: out.join(""), complete: completeInput && offset === raw.length };
}
