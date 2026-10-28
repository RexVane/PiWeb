import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GET } from "../../src/app/api/files/route";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8QkAAAAASUVORK5CYII=", "base64");
let temporary: string;
let cwd: string;
beforeEach(async () => {
	temporary = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-image-api-"));
	cwd = path.join(temporary, "workspace");
	await fs.mkdir(path.join(cwd, "assets"), { recursive: true });
	await fs.writeFile(path.join(cwd, "assets", "中文 image.png"), PNG);
});
afterEach(async () => { await fs.rm(temporary, { recursive: true, force: true }); });

const imageRequest = (file: string) => GET(new Request(`http://localhost/api/files?${new URLSearchParams({ image: "1", cwd, path: file })}`));

describe("protected workspace image endpoint", () => {
	it("returns exact image bytes with MIME, nosniff and a sandbox for direct navigation", async () => {
		const response = await imageRequest("assets/中文 image.png");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/png");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("content-security-policy")).toContain("sandbox");
		expect(response.headers.get("content-security-policy")).not.toContain("allow-scripts");
		expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
	});

	it("checks both path traversal and directory symlinks against the real workspace", async () => {
		await fs.mkdir(path.join(temporary, "outside"));
		await fs.writeFile(path.join(temporary, "outside", "pic.png"), PNG);
		await fs.symlink(path.join(temporary, "outside"), path.join(cwd, "linked"), process.platform === "win32" ? "junction" : "dir");
		for (const target of ["../outside/pic.png", "linked/pic.png", "https://outside.test/pic.png", "//outside.test/pic.png"]) {
			expect((await imageRequest(target)).status, target).toBe(400);
		}
	});

	it("accepts an absolute document image when the workspace was opened through a directory alias", async () => {
		execFileSync("git", ["init", "-q", cwd]);
		const alias = path.join(temporary, "workspace-alias");
		await fs.symlink(cwd, alias, process.platform === "win32" ? "junction" : "dir");
		cwd = alias;
		const response = await imageRequest(path.join(alias, "assets", "中文 image.png"));
		expect(response.status).toBe(200);
		expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
	});

	it("rejects ignored images and hidden Git internals", async () => {
		execFileSync("git", ["init", "-q", cwd]);
		await fs.writeFile(path.join(cwd, ".gitignore"), "assets/\n");
		await fs.writeFile(path.join(cwd, ".git", "pic.png"), PNG);
		expect((await imageRequest("assets/中文 image.png")).status).toBe(400);
		expect((await imageRequest(".git/pic.png")).status).toBe(400);
	});

	it("does not serve HTML or SVG disguised by a raster extension", async () => {
		for (const [name, content] of [["fake.png", "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>"], ["fake.jpg", "<html>not an image</html>"], ["page.html", "<html>page</html>"], ["entity.svg", "<!DOCTYPE svg [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><svg>&x;</svg>"]]) {
			await fs.writeFile(path.join(cwd, name), content);
			expect((await imageRequest(name)).status, name).toBe(400);
		}
	});

	it("serves real SVG with scripts and external requests disabled even when navigated directly", async () => {
		await fs.writeFile(path.join(cwd, "diagram.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="blue"/></svg>');
		const response = await imageRequest("diagram.svg");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("image/svg+xml");
		expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'; sandbox");
	});

	it("rejects oversized files before loading their image data", async () => {
		const handle = await fs.open(path.join(cwd, "large.png"), "w");
		await handle.truncate(20 * 1024 * 1024 + 1);
		await handle.close();
		const response = await imageRequest("large.png");
		expect(response.status).toBe(400);
		expect((await response.json()).error).toContain("20 MB");
	});
});
