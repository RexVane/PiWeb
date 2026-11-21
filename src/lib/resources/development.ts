import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { APP_ROOT } from "../app-root";
import { getAgentDir } from "../pi";
import { resolveWorkspacePath, isPathInside } from "../path-security";
import { securePackageManager, validatePackageSource } from "../package-manager-safe";
import { getResourcePreferences, saveResourcePreferences, defaultResourceDevelopmentRoot } from "./preferences";
import { parseResourceManifest, readPackageManifest, staticResourceCompatibility } from "./manifest";
import type { ResourceCompatibility, ResourceType } from "./protocol";
import { addWorkspace } from "../workspace-store";
import { readFileBounded } from "../read-file-bounded";

export interface PreparedResource {
	cwd: string;
	source?: string;
	name: string;
	version?: string;
	types: ResourceType[];
	compatibility: ResourceCompatibility;
}
const EXCLUDED = new Set(["node_modules", ".git", ".pi", ".agents", ".next", "backups", ".cache", "coverage"]);
const MAX_COPY_FILES = 4000;
const MAX_COPY_BYTES = 64 * 1024 * 1024;

const AUTO_LOADED_DIRS = ["extensions", "skills", "prompts", "themes"];

/** 校验资源源码根目录：必须位于 PiWeb 安装目录和 Pi 自动扫描目录之外。 */
export async function validateResourceDevelopmentRoot(chosen: string, { createMissing = false } = {}): Promise<string> {
	if (createMissing) await fs.mkdir(chosen, { recursive: true, mode: 0o700 }).catch(() => undefined);
	const root = await resolveWorkspacePath(chosen);
	const app = await fs.realpath(APP_ROOT).catch(() => APP_ROOT);
	if (isPathInside(app, root)) throw new Error("Resource sources must be outside the PiWeb installation");
	const agentDir = getAgentDir();
	for (const name of AUTO_LOADED_DIRS) {
		const candidate = path.join(agentDir, name);
		const resolved = await fs.realpath(candidate).catch(() => path.resolve(candidate));
		if (isPathInside(resolved, root)) throw new Error("Resource sources must be outside Pi auto-loaded resource directories");
	}
	const segments = path.resolve(root).split(path.sep);
	for (let i = 0; i < segments.length - 1; i += 1) {
		if (segments[i].toLowerCase() === ".pi" && AUTO_LOADED_DIRS.includes(segments[i + 1].toLowerCase())) {
			throw new Error("Resource sources must be outside Pi auto-loaded resource directories");
		}
	}
	return root;
}

async function developmentRoot(value?: string): Promise<string> {
	const saved = (await getResourcePreferences()).developmentRoot;
	const fallback = defaultResourceDevelopmentRoot();
	const chosen = value || saved || fallback;
	// 默认的全局源码根不存在时自动建出来；用户自选目录仍要求先存在。
	const root = await validateResourceDevelopmentRoot(chosen, { createMissing: path.resolve(chosen) === path.resolve(fallback) });
	if (value) await saveResourcePreferences({ developmentRoot: root });
	return root;
}

async function copySource(source: string, destination: string): Promise<void> {
	let files = 0;
	let bytes = 0;
	const visit = async (directory: string, target: string) => {
		for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
			if (EXCLUDED.has(entry.name) || /^\.env(?:\.|$)/.test(entry.name) && entry.name !== ".env.example" || /\.(?:pem|key|p12|pfx)$/.test(entry.name)) continue;
			if (entry.isSymbolicLink()) throw new Error("Source contains symlinks; review and copy it manually before adapting");
			const from = path.join(directory, entry.name);
			const to = path.join(target, entry.name);
			if (entry.isDirectory()) { await fs.mkdir(to); await visit(from, to); }
			else if (entry.isFile()) {
				files += 1;
				if (files > MAX_COPY_FILES) throw new Error("Source contains too many files; prepared workspace was retained");
				const data = await readFileBounded(from, MAX_COPY_BYTES - bytes);
				bytes += data.length;
				if (bytes > MAX_COPY_BYTES) throw new Error("Source is too large; prepared workspace was retained");
				await fs.writeFile(to, data, { flag: "wx", mode: 0o600 });
			}
		}
	};
	await visit(source, destination);
}

async function workspace(root: string, prefix: string): Promise<string> {
	const directory = path.join(root, `${prefix}-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`);
	await fs.mkdir(directory, { mode: 0o700 });
	await addWorkspace(directory);
	return directory;
}

async function copyAuthoringGuide(directory: string): Promise<void> {
	await fs.copyFile(path.join(APP_ROOT, "public", "resources", "authoring.md"), path.join(directory, "PIWEB-API.md"), fs.constants.COPYFILE_EXCL).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
}

/** Explicit preparation fetches package files with npm scripts disabled, never loads extension code or changes real Pi settings. */
export async function prepareExistingResource(source: string, rootValue?: string): Promise<PreparedResource> {
	validatePackageSource(source);
	const root = await developmentRoot(rootValue);
	const directory = await workspace(root, "adapt");
	let sourceRoot: string;
	if (!/^(?:npm:|git:|https?:)/.test(source)) sourceRoot = await resolveWorkspacePath(source);
	else {
		// Keep this acquired source for repeatable review. It is not an installation cache used by running sessions.
		const acquisition = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-resource-source-"));
		const agentDir = path.join(acquisition, "agent");
		await fs.mkdir(agentDir);
		const settingsManager = SettingsManager.inMemory();
		settingsManager.setProjectTrusted(true);
		const manager = securePackageManager(new DefaultPackageManager({ cwd: acquisition, agentDir, settingsManager }));
		try {
			await manager.install(source);
			const installed = manager.getInstalledPath(source, "user");
			if (!installed) throw new Error("Package files could not be acquired");
			sourceRoot = installed;
			await copySource(sourceRoot, directory);
		} catch (error) { throw new Error(`Source preparation failed; workspace retained at ${directory}. ${error instanceof Error ? error.message : ""}`); }
		finally {
			// Acquired dependencies can contain user code. Retain the staging location for inspection, never auto-delete it.
			await fs.writeFile(path.join(directory, "piweb-acquisition.json"), `${JSON.stringify({ source, acquisition }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		}
		sourceRoot = directory;
	}
	if (sourceRoot !== directory) await copySource(sourceRoot, directory);
	await copyAuthoringGuide(directory);
	const raw = await readPackageManifest(directory);
	const name = typeof raw?.name === "string" ? raw.name : path.basename(directory);
	const version = typeof raw?.version === "string" ? raw.version : undefined;
	let manifest;
	try { manifest = parseResourceManifest(raw?.piweb, name); } catch { /* Static review reports uncertain/incompatible capabilities. */ }
	const texts: string[] = [];
	const gather = async (dir: string) => {
		for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
			if (texts.length >= 80) return;
			if (entry.isDirectory() && !EXCLUDED.has(entry.name)) await gather(path.join(dir, entry.name));
			else if (entry.isFile() && /\.(?:ts|js|mjs)$/.test(entry.name)) texts.push((await readFileBounded(path.join(dir, entry.name), 512 * 1024)).toString("utf8"));
		}
	};
	await gather(directory);
	const pi = raw?.pi as Record<string, unknown> | undefined;
	const types: ResourceType[] = [];
	for (const type of ["extensions", "skills", "prompts"] as const) {
		if (Array.isArray(pi?.[type]) && pi[type].length || await fs.stat(path.join(directory, type)).then((stat) => stat.isDirectory()).catch(() => false)) types.push(type);
	}
	if (!types.length) types.push("extensions");
	await fs.writeFile(path.join(directory, "piweb-upstream.json"), `${JSON.stringify({ source, name, version, preparedAt: new Date().toISOString(), status: "review" }, null, 2)}\n`, { flag: "wx", mode: 0o600 });
	return { cwd: directory, source, name, version, types, compatibility: staticResourceCompatibility(manifest, texts) };
}

export async function prepareNewResource(rootValue?: string): Promise<PreparedResource> {
	const root = await developmentRoot(rootValue);
	const directory = await workspace(root, "resource");
	const name = `my-resource-${randomUUID().slice(0, 8)}`;
	await fs.mkdir(path.join(directory, "src"));
	await fs.mkdir(path.join(directory, "web"));
	await fs.writeFile(path.join(directory, "package.json"), `${JSON.stringify({ name, version: "0.1.0", type: "module", private: true,
		pi: { extensions: ["src/index.ts"] }, piweb: { apiVersion: 1, id: name, views: [{ id: "main", title: name, entry: "web/index.html", placement: "panel", methods: [] }] },
		peerDependencies: { "@earendil-works/pi-coding-agent": "*", typebox: "*" },
	}, null, 2)}\n`, { flag: "wx" });
	await fs.writeFile(path.join(directory, "src", "index.ts"), `import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";\n\n// Design this extension through Pi's public API; do not import PiWeb internals.\nexport default function resource(pi: ExtensionAPI) {\n  // Register tools, commands and events after the requirements are clear.\n}\n`, { flag: "wx" });
	await fs.copyFile(path.join(APP_ROOT, "public", "resources", "client.js"), path.join(directory, "web", "client.js"));
	await fs.writeFile(path.join(directory, "web", "index.html"), `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Resource preview</title><style>body{font:14px system-ui;color:var(--dsw-label-primary);background:transparent;margin:16px}button{padding:8px 14px}</style></head><body><p id="message">Design your resource interface here.</p><script src="client.js"></script><script>piwebResource.onContext(context=>{document.getElementById('message').textContent=context.data?.message||'Design your resource interface here.';});</script></body></html>\n`, { flag: "wx" });
	await fs.writeFile(path.join(directory, ".gitignore"), "node_modules/\nbackups/\n.env*\n!.env.example\n*.log\n", { flag: "wx" });
	await copyAuthoringGuide(directory);
	return { cwd: directory, name, compatibility: "unknown", types: ["extensions"] };
}

export function resourceDesignPrompt(prepared: PreparedResource, adapting: boolean): string {
	return [adapting ? "Help me adapt this independent Pi resource to PiWeb's web UI while preserving its terminal behavior." : "Help me design my own independent Pi/PiWeb resource. Start by asking what function and visual style I want.",
		`Work only in this resource workspace: ${prepared.cwd}. Read PIWEB-API.md first.`,
		prepared.source ? `Upstream source: ${prepared.source}. Preserve the provenance in piweb-upstream.json and do not edit the original installed package.` : "Use Pi's official extension/skill/prompt mechanism; use the public PiWeb bridge only for browser and host capabilities.",
		"Do not modify or rebuild the PiWeb package, auto-install unfinished code, or change unrelated user settings. Test passive UI and real actions separately. Handle cancellation and never infer permission approval from a missing answer.",
		"After implementation, explain the tests and offer installation of this local directory for me to confirm.",
	].join("\n\n");
}
