/** 文件类来源的公共读取：扫描时只读文件头（避免为了列表把几百 MB 全读进来），导入时才整读 */
import fs from "node:fs/promises";

/** 读文件开头若干字节（不切 UTF-8 字符：按行切分后只取完整行） */
export async function readHead(file: string, bytes = 64 * 1024): Promise<string> {
	const handle = await fs.open(file, "r");
	try {
		const buffer = Buffer.alloc(bytes);
		const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
		return buffer.subarray(0, bytesRead).toString("utf8");
	} finally {
		await handle.close();
	}
}

/** 逐行解析 JSONL；单行坏掉只跳过该行，不放弃整个文件 */
export function* eachJsonLine(text: string): Generator<Record<string, unknown>> {
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object") yield parsed as Record<string, unknown>;
		} catch {
			// 单行损坏（写入中断等）：跳过
		}
	}
}

/** 从文件头里取第一批记录（扫描用） */
export function headRecords(text: string, limit = 400): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [];
	for (const record of eachJsonLine(text)) {
		out.push(record);
		if (out.length >= limit) break;
	}
	return out;
}

/** 递归列文件，带深度上限与名字过滤 */
export async function listFiles(root: string, options: { match: (name: string) => boolean; maxDepth?: number }): Promise<string[]> {
	const out: string[] = [];
	const maxDepth = options.maxDepth ?? 4;
	async function walk(dir: string, depth: number) {
		let entries;
		try {
			entries = await fs.readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = `${dir}${dir.endsWith("/") || dir.endsWith("\\") ? "" : "/"}${entry.name}`;
			if (entry.isDirectory()) {
				if (depth < maxDepth) await walk(full, depth + 1);
			} else if (entry.isFile() && options.match(entry.name)) {
				out.push(full);
			}
		}
	}
	await walk(root, 1);
	return out;
}

export async function statMtime(file: string): Promise<number | undefined> {
	try {
		return (await fs.stat(file)).mtimeMs;
	} catch {
		return undefined;
	}
}

/**
 * 按最近活动倒序：扫描只列最近若干条，所以先按 mtime 排序（只 stat、不读内容），
 * 再从头读——读到够了就停，剩下的文件根本不打开。
 */
export async function sortByRecency(files: string[]): Promise<Array<{ file: string; mtime?: number }>> {
	const rows = await Promise.all(files.map(async (file) => ({ file, mtime: await statMtime(file) })));
	return rows.sort((left, right) => (right.mtime ?? 0) - (left.mtime ?? 0));
}

/** 到达上限就别再往下读了（limit <= 0 表示不限） */
export function reachedLimit(count: number, limit: number): boolean {
	return limit > 0 && count >= limit;
}
