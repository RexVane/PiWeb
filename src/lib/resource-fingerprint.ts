import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ignore from "ignore";
import { readJsonObjectSync } from "./agent-config";
import type { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

type ResourceKind = "skills" | "agents-skills" | "prompts" | "extensions";
const CONTEXT_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const IGNORE_NAMES = [".gitignore", ".ignore", ".piignore"];
const key = (value: string) => process.platform === "win32" ? value.toLowerCase() : value;

/** Only resource discovery trees are walked; real paths prevent symlink cycles. */
export function resourceFingerprint({ cwd, agentDir, trusted, loader, packageRoots = [] }: {
	cwd: string;
	agentDir: string;
	trusted: boolean;
	loader?: DefaultResourceLoader;
	packageRoots?: string[];
}): string {
	const records = new Map<string, string>();
	const scans = new Set<string>();
	const homeDir = process.env.HOME || os.homedir();
	const stamp = (file: string) => {
		try {
			const link = fs.lstatSync(file);
			const stat = link.isSymbolicLink() ? fs.statSync(file) : link;
			records.set(file, `${link.mtimeMs}:${link.ctimeMs}:${link.size}:${link.ino}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`);
			return stat;
		} catch {
			records.set(file, "missing");
			return undefined;
		}
	};
	const resolveInput = (value: string, base: string) => path.resolve(base, value.trim().replace(/^~(?=$|[/\\])/, homeDir));
	const readObject = (file: string): Record<string, unknown> => {
		stamp(file);
		if (path.basename(file).toLowerCase() === "settings.json") return readJsonObjectSync(file);
		try {
			const value = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
			return value && typeof value === "object" && !Array.isArray(value) ? value : {};
		} catch { return {}; }
	};
	const entries = (dir: string) => {
		try { return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); }
		catch { return []; }
	};
	const rulesFor = (dir: string, root: string, inherited: ignore.Ignore) => {
		const rules = ignore().add(inherited);
		const relative = path.relative(root, dir).split(path.sep).join("/");
		for (const name of IGNORE_NAMES) {
			const file = path.join(dir, name);
			stamp(file);
			try {
				for (let line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
					if (!line.trim() || (line.trim().startsWith("#") && !line.trim().startsWith("\\#"))) continue;
					const negated = line.startsWith("!");
					if (negated || line.startsWith("\\!")) line = line.slice(1);
					line = line.replace(/^\//, "");
					rules.add(`${negated ? "!" : ""}${relative ? `${relative}/` : ""}${line}`);
				}
			} catch { /* missing or unreadable ignore file */ }
		}
		return rules;
	};
	const scan = (input: string, kind: ResourceKind, recursivePrompts = false, root = input, inherited = ignore(), ancestors = new Set<string>()) => {
		const stat = stamp(input);
		if (!stat?.isDirectory()) return;
		let real: string;
		try { real = fs.realpathSync(input); } catch { return; }
		const realKey = key(real);
		if (ancestors.has(realKey)) return;
		const nextAncestors = new Set(ancestors).add(realKey);
		const scanKey = `${kind}:${recursivePrompts}:${key(path.resolve(root))}:${key(real)}`;
		if (scans.has(scanKey)) return;
		scans.add(scanKey);
		const rules = rulesFor(input, root, inherited);
		if (kind === "extensions" && !recursivePrompts) {
			const manifest = readObject(path.join(input, "package.json")).pi as Record<string, unknown> | undefined;
			const configured = Array.isArray(manifest?.extensions) ? manifest.extensions.filter((value): value is string => typeof value === "string") : [];
			const extensionEntries = configured.map((value) => resolveInput(value, input)).filter((file) => stamp(file));
			if (extensionEntries.length) { for (const file of extensionEntries) scan(file, "extensions", false, file, ignore(), nextAncestors); return; }
			for (const name of ["index.ts", "index.js"]) if (stamp(path.join(input, name))) return;
		}
		if (kind === "skills" || kind === "agents-skills") {
			const file = path.join(input, "SKILL.md");
			const relative = path.relative(root, file).split(path.sep).join("/");
			if (stamp(file)?.isFile() && !rules.ignores(relative)) return;
		}
		for (const entry of entries(input)) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const file = path.join(input, entry.name);
			let stat: fs.Stats;
			try { stat = fs.statSync(file); } catch { stamp(file); continue; }
			const relative = path.relative(root, file).split(path.sep).join("/");
			if (rules.ignores(`${relative}${stat.isDirectory() ? "/" : ""}`)) continue;
			if (stat.isDirectory()) {
				if (kind === "prompts" && !recursivePrompts) continue;
				// Autoload extensions only inspect direct child entry points.
				if (kind === "extensions" && !recursivePrompts && input !== root) continue;
				scan(file, kind, recursivePrompts, root, rules, nextAncestors);
			} else if (stat.isFile() && (kind === "extensions" ? /\.(ts|js)$/.test(entry.name) : entry.name.endsWith(".md"))) {
				if (kind === "skills" && input !== root) continue;
				if (kind === "agents-skills" && input === root) continue;
				stamp(file);
			}
		}
	};

	const project = path.join(path.resolve(cwd), ".pi");
	const globalSettings = readObject(path.join(agentDir, "settings.json"));
	const projectSettings = readObject(path.join(project, "settings.json"));
	for (const base of [agentDir, ...(trusted ? [project] : [])]) {
		for (const name of ["SYSTEM.md", "APPEND_SYSTEM.md"]) stamp(path.join(base, name));
		for (const kind of ["skills", "prompts", "extensions"] as const) {
			const root = path.join(base, kind);
			scan(root, kind);
			if (kind === "extensions") scan(root, kind, true);
		}
	}
	for (const name of CONTEXT_NAMES) stamp(path.join(agentDir, name));
	let current = path.resolve(cwd);
	let skillsAncestors = trusted;
	for (;;) {
		for (const name of CONTEXT_NAMES) stamp(path.join(current, name));
		if (skillsAncestors) scan(path.join(current, ".agents", "skills"), "agents-skills");
		if (fs.existsSync(path.join(current, ".git"))) skillsAncestors = false;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	scan(path.join(homeDir, ".agents", "skills"), "agents-skills");
	for (const [settings, base] of [[globalSettings, agentDir], ...(trusted ? [[projectSettings, project] as const] : [])] as const) {
		for (const kind of ["skills", "prompts", "extensions"] as const) {
			const values = settings[kind];
			if (!Array.isArray(values)) continue;
			for (const value of values) {
				if (typeof value !== "string" || /^[!+-]|[*?]/.test(value) || value.startsWith("builtin:")) continue;
				const root = resolveInput(value, base);
				// A broad explicit directory still does not authorize crawling ordinary
				// workspace/home files. Watch its resource convention subdirectories.
				if ([cwd, homeDir, agentDir, project].some((dir) => key(path.resolve(dir)) === key(root))) {
					scan(path.join(root, kind), kind, kind === "prompts");
					continue;
				}
				scan(root, kind, kind === "prompts");
				if (kind === "extensions" && stamp(root)?.isDirectory()) scan(root, kind, true);
			}
		}
	}
	for (const packageRoot of packageRoots) {
		const manifest = readObject(path.join(packageRoot, "package.json")).pi as Record<string, unknown> | undefined;
		const explicit = manifest && ["skills", "prompts", "extensions", "themes"].some((kind) => Array.isArray(manifest[kind]));
		for (const kind of ["skills", "prompts", "extensions"] as const) {
			if (!explicit) { scan(path.join(packageRoot, kind), kind, kind === "prompts"); continue; }
			for (const value of Array.isArray(manifest[kind]) ? manifest[kind] : []) {
				if (typeof value !== "string" || /^[!+-]/.test(value)) continue;
				if (!/[*?]/.test(value)) { scan(resolveInput(value, packageRoot), kind, kind === "prompts"); continue; }
				// A glob is confined to its literal directory prefix, not the whole user's tree.
				const prefix = value.slice(0, value.search(/[*?]/));
				const base = resolveInput(prefix.slice(0, Math.max(prefix.lastIndexOf("/"), prefix.lastIndexOf("\\")) + 1), packageRoot);
				if (![cwd, homeDir].some((root) => key(path.resolve(root)) === key(base))) scan(base, kind, true);
			}
		}
	}
	if (loader) {
		for (const file of loader.getAgentsFiles().agentsFiles) stamp(file.path);
		const system = loader.getSystemPromptSource();
		if (system) stamp(system.path);
		for (const source of loader.getAppendSystemPromptSources()) stamp(source.path);
		for (const [sources, kind] of [[loader.getSkills().skills, "skills"], [loader.getPrompts().prompts, "prompts"]] as const) {
			for (const source of sources) {
				stamp(source.filePath);
				const base = source.sourceInfo?.baseDir;
				// Extension-provided resource roots are not necessarily in settings.json.
				if (base && ![cwd, homeDir, agentDir, project].some((root) => key(path.resolve(root)) === key(path.resolve(base)))) scan(base, kind, kind === "prompts");
			}
		}
		for (const extension of loader.getExtensions().extensions) {
			if (extension.path.startsWith("builtin:") || extension.path.startsWith("<")) continue;
			stamp(extension.resolvedPath);
			const base = extension.sourceInfo.baseDir;
			if (base && ![cwd, homeDir, agentDir, project].some((root) => key(path.resolve(root)) === key(path.resolve(base)))) scan(base, "extensions", true);
		}
		for (const diagnostics of [loader.getSkills().diagnostics, loader.getPrompts().diagnostics, loader.getExtensions().errors]) {
			for (const diagnostic of diagnostics) if (diagnostic.path) stamp(diagnostic.path);
		}
	}
	return `${trusted}\n${[...records].sort(([a], [b]) => a.localeCompare(b)).map(([file, revision]) => `${file}:${revision}`).join("\n")}`;
}
