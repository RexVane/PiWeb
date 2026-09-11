import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveUpload } from "../src/lib/files-service";

/** 拖拽上传的限额与安全（dsh 语义：原样字节保存 + 路径引用） */
describe("files-service saveUpload", () => {
	let tempDir = "";
	let previousAgentDir: string | undefined;

	beforeEach(async () => {
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-uploads-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;
	});

	afterEach(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await fs.rm(tempDir, { recursive: true, force: true });
	});

	const b64 = (bytes: number) => Buffer.alloc(bytes, 7).toString("base64");

	it("saves the payload byte-for-byte into web-uploads and reports path/size", async () => {
		const data = Buffer.from([0x50, 0x4b, 0x03, 0x04]).toString("base64");
		const r = await saveUpload("archive.zip", data);
		expect(r.name).toBe("archive.zip");
		expect(r.size).toBe(4);
		// 落在 agent 目录的 web-uploads 下，内容逐字节一致
		expect(path.dirname(r.path)).toBe(path.join(tempDir, "web-uploads"));
		const stored = await fs.readFile(r.path);
		expect([...stored]).toEqual([0x50, 0x4b, 0x03, 0x04]);
	});

	it("sanitizes names: strips path components and control characters", async () => {
		const r = await saveUpload("..\\..\\evil/名称\x00带控制.zip", b64(4));
		expect(r.name).not.toContain("/");
		expect(r.name).not.toContain("\\");
		expect(r.name).not.toContain("\x00");
		// 仍在 web-uploads 内（防路径穿越）
		expect(path.dirname(r.path)).toBe(path.join(tempDir, "web-uploads"));
	});

	it("rejects empty and oversized payloads (100MB defense cap)", async () => {
		await expect(saveUpload("empty.zip", "")).rejects.toThrow();
		// 100MB + 1 字节越界（100MB 恰好可过：> 才拒绝，此处只验证拒绝侧）
		await expect(saveUpload("big.zip", b64(100 * 1024 * 1024 + 1))).rejects.toThrow("too large");
	});

	it("never overwrites: same-name saves produce distinct paths", async () => {
		const a = await saveUpload("dup.zip", b64(4));
		const b = await saveUpload("dup.zip", b64(4));
		expect(a.path).not.toBe(b.path);
		// 两个文件都真实存在且内容完好
		expect((await fs.stat(a.path)).size).toBe(4);
		expect((await fs.stat(b.path)).size).toBe(4);
	});

	it("accepts a 100MB file at the exact cap", async () => {
		const r = await saveUpload("cap.bin", b64(100 * 1024 * 1024));
		expect(r.size).toBe(100 * 1024 * 1024);
	}, 30_000);
});
