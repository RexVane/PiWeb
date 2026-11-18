import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveUpload, saveUploadStream, sweepUploads } from "../src/lib/files-service";
import { GET, POST } from "../src/app/api/files/route";
import { recycleFixture } from "./fixtures/recycle";

/** 拖拽上传的限额与安全（dsh 语义：原样字节保存 + 路径引用） */
describe("files-service saveUpload", () => {
	let tempDir = "";
	let previousAgentDir: string | undefined;

	beforeEach(async () => {
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-uploads-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;
		vi.spyOn(os, "homedir").mockReturnValue(tempDir);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await recycleFixture(tempDir);
	});

	const b64 = (bytes: number) => Buffer.alloc(bytes, 7).toString("base64");
	it.each([null, [], true, 4, "text"].map((body) => ({ body })))("rejects a non-object file action body $body without opening anything", async ({ body }) => {
		const open = vi.spyOn(fs, "open");
		const response = await POST(new Request("http://localhost/api/files", { method: "POST", body: JSON.stringify(body) }));
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ success: false, error: "expected an object body", errorCode: "VALIDATION_ERROR" });
		expect(open).not.toHaveBeenCalled();
	});

	it("sweeps only old uploads that no session mentions any more", async () => {
		const uploads = path.join(tempDir, "web-uploads");
		await fs.mkdir(uploads, { recursive: true });
		const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
		for (const name of ["kept-by-session.zip", "orphan.zip", "fresh-orphan.zip"]) await fs.writeFile(path.join(uploads, name), "x");
		await fs.utimes(path.join(uploads, "kept-by-session.zip"), old, old);
		await fs.utimes(path.join(uploads, "orphan.zip"), old, old);
		// 会话里引用的是 JSON 转义过的 Windows 绝对路径
		const sessions = path.join(tempDir, "sessions", "--D--Proj--");
		await fs.mkdir(sessions, { recursive: true });
		await fs.writeFile(path.join(sessions, "a.jsonl"), `${JSON.stringify({ type: "message", message: { role: "user", content: `附件 ${path.join(uploads, "kept-by-session.zip")}` } })}\n`);

		expect(await sweepUploads()).toEqual(["orphan.zip"]);
		expect((await fs.readdir(uploads)).sort()).toEqual(["fresh-orphan.zip", "kept-by-session.zip"]);
		const index = await fs.readFile(path.join(tempDir, ".agents", "backups", "INDEX.md"), "utf8");
		const backup = index.split("\n").find((line) => line.includes("orphan.zip"))!.split(" | ")[2];
		expect(await fs.readFile(backup, "utf8")).toBe("x");
	});

	it("keeps attachments whose UTF-8 filename reference spans scan chunks and preserves all files on budget exhaustion", async () => {
		const uploads = path.join(tempDir, "web-uploads");
		const sessions = path.join(tempDir, "sessions", "workspace");
		await fs.mkdir(uploads, { recursive: true });
		await fs.mkdir(sessions, { recursive: true });
		const name = "跨界附件.zip";
		const target = path.join(uploads, name);
		await fs.writeFile(target, "original");
		const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
		await fs.utimes(target, old, old);
		const record = path.join(sessions, "reference.jsonl");
		await fs.writeFile(record, Buffer.concat([Buffer.alloc(65535, 32), Buffer.from(name)]));
		expect(await sweepUploads()).toEqual([]);
		expect(await fs.readFile(target, "utf8")).toBe("original");
		await fs.writeFile(record, "x".repeat(2048));
		expect(await sweepUploads(Date.now(), 30, { scanByteLimit: 1024 })).toEqual([]);
		expect(await fs.readFile(target, "utf8")).toBe("original");
	});

	it("keeps every upload when a session file cannot be read", async () => {
		const uploads = path.join(tempDir, "web-uploads");
		await fs.mkdir(uploads, { recursive: true });
		const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
		await fs.writeFile(path.join(uploads, "orphan.zip"), "x");
		await fs.utimes(path.join(uploads, "orphan.zip"), old, old);
		// 一个叫 .jsonl 的目录：readFile 必然失败
		await fs.mkdir(path.join(tempDir, "sessions", "broken.jsonl"), { recursive: true });
		expect(await sweepUploads()).toEqual([]);
		expect(await fs.readdir(uploads)).toEqual(["orphan.zip"]);
	});

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

/** 输入框附件卡的页内预览：只读 web-uploads，工作区外的路径一律拒绝 */
describe("files-service readUploadFile", () => {
	let tempDir = "";
	let previousAgentDir: string | undefined;

	beforeEach(async () => {
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-upload-read-"));
		process.env.PI_CODING_AGENT_DIR = tempDir;
	});

	afterEach(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await recycleFixture(tempDir);
	});

	it("returns a text preview for a saved upload", async () => {
		const uploads = path.join(tempDir, "web-uploads");
		await fs.mkdir(uploads, { recursive: true });
		const file = path.join(uploads, "notes.md");
		await fs.writeFile(file, "# 笔记\n");
		const response = await GET(new Request(`http://localhost/api/files?upload=1&path=${encodeURIComponent(file)}`));
		expect(response.status).toBe(200);
		const payload = await response.json();
		expect(payload.data).toMatchObject({ path: file, content: "# 笔记\n", binary: false, truncated: false });
	});

	it("refuses paths outside web-uploads", async () => {
		const uploads = path.join(tempDir, "web-uploads");
		await fs.mkdir(uploads, { recursive: true });
		const outside = path.join(tempDir, "secret.txt");
		await fs.writeFile(outside, "secret");
		const response = await GET(new Request(`http://localhost/api/files?upload=1&path=${encodeURIComponent(outside)}`));
		expect(response.status).toBe(400);
		expect(await response.json()).toMatchObject({ success: false });
	});
});
