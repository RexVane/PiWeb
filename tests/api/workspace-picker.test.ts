import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/workspaces/route";
import { getWorkspaceRegistry } from "@/lib/workspace-store";

const pickerAppRoot = vi.hoisted(() => ({ value: process.cwd() }));
vi.mock("@/lib/app-root", () => ({ get APP_ROOT() { return pickerAppRoot.value; } }));

// 真正启动本机选择器子进程、校验路径并写入临时注册表；只替换外部对话框程序。
describe("workspace picker API and native process", () => {
	let root: string;
	let project: string;
	let fixture: string;
	let called: string;

	beforeEach(async () => {
		root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "piweb-picker-")));
		project = path.join(root, "中文 project");
		fixture = path.join(root, "dialog.json");
		called = path.join(root, "called");
		const bin = path.join(root, "bin");
		await fs.mkdir(project);
		await fs.mkdir(bin);
		pickerAppRoot.value = root;
		if (process.platform === "win32") {
			await fs.mkdir(path.join(root, "scripts"));
			// Invoke real PowerShell with the production flags and script location,
			// replacing only the interactive dialog with deterministic output.
			await fs.writeFile(path.join(root, "scripts", "pick-folder.ps1"), [
				"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
				"$data = Get-Content -LiteralPath $env:PIWEB_PICKER_FIXTURE_FILE -Raw -Encoding UTF8 | ConvertFrom-Json",
				"[System.IO.File]::WriteAllText([string]$data.called, 'yes')",
				"[Console]::Out.Write([string]$data.stdout)",
				"[Console]::Error.Write([string]$data.stderr)",
				"exit ([int]$data.code)",
			].join("\n"));
		} else {
			const executable = path.join(bin, process.platform === "darwin" ? "osascript" : "zenity");
			await fs.writeFile(executable, `#!${process.execPath}\nconst fs = require("node:fs");\nconst data = JSON.parse(fs.readFileSync(process.env.PIWEB_PICKER_FIXTURE_FILE, "utf8"));\nfs.writeFileSync(data.called, "yes");\nprocess.stdout.write(data.stdout || "");\nprocess.stderr.write(data.stderr || "");\nprocess.exitCode = data.code;\n`, { mode: 0o755 });
		}
		vi.stubEnv("PI_CODING_AGENT_DIR", path.join(root, "agent"));
		vi.stubEnv("PIWEB_PICKER_FIXTURE_FILE", fixture);
		vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH ?? ""}`);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		pickerAppRoot.value = process.cwd();
		await fs.rm(root, { recursive: true, force: true });
	});

	async function pick(data: { stdout?: string; stderr?: string; code: number }, host = "localhost", action = "pick") {
		await fs.writeFile(fixture, JSON.stringify({ ...data, called }));
		return POST(new Request(`http://${host}/api/workspaces`, {
			method: "POST", body: JSON.stringify({ action }),
		}));
	}

	it("falls back to page browsing when the native process fails", async () => {
		const response = await pick({ stderr: "native picker unavailable", code: 2 });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true, data: { path: null, canceled: false, browse: true } });
		expect(await fs.readFile(called, "utf8")).toBe("yes");
		expect((await getWorkspaceRegistry()).workspaces).toEqual([]);
	});

	it("treats native cancellation as cancellation without opening another picker", async () => {
		const response = await pick({ code: process.platform === "win32" ? 0 : 1, stderr: process.platform === "darwin" ? "0:17: execution error: 用户已取消。 (-128)\n" : "" });
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true, data: { path: null, canceled: true } });
		expect((await getWorkspaceRegistry()).workspaces).toEqual([]);
	});

	it("registers a directory returned by the native process", async () => {
		const response = await pick({ stdout: `${project}\n`, code: 0 });
		expect(response.status).toBe(200);
		expect((await response.json()).data).toMatchObject({ path: project, canceled: false, workspaces: [project] });
		expect((await getWorkspaceRegistry()).workspaces).toEqual([project]);
	});
	it("returns a native directory for an install source without registering a workspace", async () => {
		const response = await pick({ stdout: `${project}\n`, code: 0 }, "localhost", "pickDirectory");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ success: true, data: { path: project, canceled: false } });
		expect(await fs.readFile(called, "utf8")).toBe("yes");
		expect((await getWorkspaceRegistry()).workspaces).toEqual([]);
	});

	it("keeps invalid chosen paths as validation errors", async () => {
		const response = await pick({ stdout: path.join(root, "missing"), code: 0 });
		expect(response.status).toBe(400);
		expect((await response.json()).success).toBe(false);
		expect((await getWorkspaceRegistry()).workspaces).toEqual([]);
	});

	it.each(["pick", "pickDirectory"])("browses on remote clients without starting the native program for %s", async (action) => {
		const response = await pick({ code: 2 }, "piweb.example", action);
		expect(await response.json()).toEqual({ success: true, data: { path: null, canceled: false, remote: true } });
		await expect(fs.stat(called)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
