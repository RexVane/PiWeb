import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { saveUpload, saveUploadStream } from "../src/lib/files-service";
import { POST } from "../src/app/api/files/route";

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

	it("streams an upload without base64 and removes an empty partial file", async () => {
		const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
		const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } });
		const saved = await saveUploadStream("stream.zip", stream);
		expect(saved.size).toBe(bytes.length);
		expect([...await fs.readFile(saved.path)]).toEqual([...bytes]);
		const empty = new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } });
		await expect(saveUploadStream("empty-stream.zip", empty)).rejects.toThrow("empty upload");
		expect((await fs.readdir(path.join(tempDir, "web-uploads"))).some((name) => name.endsWith("empty-stream.zip"))).toBe(false);
	});

	it("rejects truncated or surplus streams and removes their partial files", async () => {
		const stream = () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1, 2, 3, 4])); controller.close(); } });
		await expect(saveUploadStream("short.bin", stream(), 5)).rejects.toThrow("incomplete upload");
		await expect(saveUploadStream("long.bin", stream(), 3)).rejects.toThrow("declared length");
		expect(await fs.readdir(path.join(tempDir, "web-uploads"))).toEqual([]);
	});

	it("validates upload size headers before accepting a request", async () => {
		for (const headers of [{}, { "x-upload-size": "-1" }, { "x-upload-size": "NaN" }, { "x-upload-size": String(101 * 1024 * 1024) }, { "x-upload-size": "4", "content-length": "5" }] satisfies Record<string, string>[]) {
			const response = await POST(new Request("http://localhost/api/files?action=upload&name=invalid.bin", { method: "POST", headers: headers as Record<string, string>, body: "test" }));
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ success: false });
		}
		expect(await fs.readdir(tempDir)).toEqual([]);
	});

	it("accepts either an explicit file size or Content-Length and rejects truncated requests", async () => {
		const variants: Record<string, string>[] = [{ "x-upload-size": "4" }, { "content-length": "4" }];
		for (const headers of variants) {
			const response = await POST(new Request("http://localhost/api/files?action=upload&name=complete.bin", { method: "POST", headers: headers as Record<string, string>, body: "test" }));
			expect(response.status).toBe(200);
			const result = await response.json();
			expect(result).toMatchObject({ success: true, data: { size: 4 } });
			expect(await fs.readFile(result.data.path, "utf8")).toBe("test");
		}
		const response = await POST(new Request("http://localhost/api/files?action=upload&name=truncated.bin", { method: "POST", headers: { "x-upload-size": "5" }, body: "test" }));
		expect(response.status).toBe(400);
		expect((await fs.readdir(path.join(tempDir, "web-uploads"))).some((name) => name.endsWith("truncated.bin"))).toBe(false);
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
