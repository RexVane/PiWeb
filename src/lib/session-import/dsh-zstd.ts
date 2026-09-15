/**
 * dsh 的会话是 **多帧拼接的 zstd**（`session.jsonl.zstd`）：`zstdDecompressSync` 一次只解出第一帧，
 * 必须按 zstd magic（28 B5 2F FD）切帧后逐帧解压再拼起来，否则只能拿到第一行。
 */
import fs from "node:fs/promises";
import { zstdDecompressSync } from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 解压多帧 zstd；帧边界只是"看起来像 magic"的位置，解压失败就把这片并入下一帧 */
export function decodeZstdFrames(raw: Buffer): Buffer {
	if (raw.length < MAGIC.length || !raw.subarray(0, MAGIC.length).equals(MAGIC)) {
		// 不是多帧流（可能单帧或未压缩）：交给单帧解压，失败则原样当作文本
		try {
			return zstdDecompressSync(raw);
		} catch {
			return raw;
		}
	}
	const cuts: number[] = [];
	for (let i = 0; (i = raw.indexOf(MAGIC, i)) !== -1; i += MAGIC.length) cuts.push(i);
	cuts.push(raw.length);
	const parts: Buffer[] = [];
	let start = 0;
	for (let i = 1; i < cuts.length; i += 1) {
		try {
			parts.push(zstdDecompressSync(raw.subarray(cuts[start], cuts[i])));
			start = i;
		} catch {
			// 误判的帧边界：与下一帧合并后重试
		}
	}
	return Buffer.concat(parts);
}

export async function readZstdJsonl(file: string): Promise<string> {
	return decodeZstdFrames(await fs.readFile(file)).toString("utf8");
}

/**
 * 只解出前面的行即可判断会话是否值得导入（扫描用）：逐帧解压，凑够若干帧就停，
 * 避免为了列个表把 39MB 全解出来。
 *
 * `complete` 表示"解出来的就是全部内容"——真实文件能到 7559 帧，前 40 帧只覆盖开头一小段，
 * 所以只有 complete 为真时才能断言"这个会话里面没有消息"。
 */
export async function readZstdHead(file: string, maxFrames = 40): Promise<{ text: string; complete: boolean }> {
	const raw = await fs.readFile(file);
	const cuts: number[] = [];
	for (let i = 0; (i = raw.indexOf(MAGIC, i)) !== -1; i += MAGIC.length) cuts.push(i);
	if (!cuts.length) {
		try {
			return { text: zstdDecompressSync(raw).toString("utf8").slice(0, 64 * 1024), complete: true };
		} catch {
			return { text: "", complete: false };
		}
	}
	cuts.push(raw.length);
	const total = cuts.length - 1;
	const out: string[] = [];
	for (let i = 1; i < cuts.length && i <= maxFrames; i += 1) {
		try {
			out.push(zstdDecompressSync(raw.subarray(cuts[i - 1], cuts[i])).toString("utf8"));
		} catch {
			// 边界误判：跳过这片
		}
	}
	return { text: out.join(""), complete: total <= maxFrames };
}
