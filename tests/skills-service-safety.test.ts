import { beforeEach, describe, expect, it, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { parse } from "yaml";

const fixture = vi.hoisted(() => ({
	agentDir: "", cwd: "", content: "",
	aliases: new Map<string, string>(),
	skills: [] as Array<{ name: string; filePath: string; baseDir: string; description: string; disableModelInvocation: boolean; sourceInfo?: { path: string; source: string; origin: "package" | "top-level"; scope: "user" | "project" } }>,
	write: vi.fn(), remove: vi.fn(), reload: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({ default: {
	realpath: vi.fn(async (target: string) => {
		const resolved = path.resolve(target);
		const alias = process.platform === "win32"
			? [...fixture.aliases].find(([declared]) => path.resolve(declared).toLowerCase() === resolved.toLowerCase())?.[1]
			: fixture.aliases.get(resolved);
		return alias ?? resolved;
	}),
	readFile: vi.fn(async () => fixture.content),
	open: vi.fn(async () => ({
		stat: async () => ({ isFile: () => true, size: Buffer.byteLength(fixture.content) }),
		read: async (buffer: Buffer, offset: number, length: number, position: number) => {
			const bytes = Buffer.from(fixture.content).subarray(position, position + length);
			bytes.copy(buffer, offset); return { bytesRead: bytes.length };
		}, close: async () => undefined,
	})),
	lstat: vi.fn(async () => ({ isSymbolicLink: () => false })),
	stat: vi.fn(async () => ({ mode: 0o644 })),
	unlink: vi.fn(async () => undefined),
	writeFile: fixture.write,
	rm: fixture.remove,
} }));
vi.mock("@/lib/pi", () => ({
	getAgentDir: () => fixture.agentDir,
	getResourceLoader: () => ({ getSkills: () => ({ skills: fixture.skills }) }),
	resourceLoaderReady: vi.fn(async () => undefined),
	reloadAllLoaders: vi.fn(async () => []),
}));
vi.mock("@/lib/agent-manager", () => ({ reloadSessionsForCwd: fixture.reload }));
vi.mock("@/lib/settings-write-lock", () => ({
	withSettingsWriteLock: (_file: string, operation: () => Promise<unknown>) => operation(),
	withExternalSettingsLock: (_file: string, operation: () => Promise<unknown>) => operation(),
}));
vi.mock("@/lib/atomic-file", () => ({ replaceFileAtomically: vi.fn(async () => undefined) }));
// 删除走系统回收站（recycle-bin）；测试只关心交给回收站的路径，跳过真实 pin 与回收站实现。
vi.mock("@/lib/recycle-bin", () => ({ moveToTrash: async (removed: string) => {
	fixture.remove(removed); return { removed };
} }));

import { deleteSkill, listSkills, setSkillDisabled } from "@/lib/skills-service";

function addSkill(filePath: string, origin?: "package" | "top-level", scope: "user" | "project" = "user") {
	const skill = {
		name: "fixture", filePath, baseDir: path.dirname(filePath), description: "fixture", disableModelInvocation: false,
		...(origin ? { sourceInfo: { path: filePath, source: origin === "package" ? "npm:fixture" : "auto", origin, scope } } : {}),
	};
	fixture.skills.push(skill);
	return skill;
}

beforeEach(() => {
	vi.clearAllMocks();
	fixture.aliases.clear();
	fixture.skills = [];
	fixture.agentDir = path.resolve(os.tmpdir(), "piweb-safety-agent");
	fixture.cwd = path.resolve(os.tmpdir(), "piweb-safety-workspace");
	fixture.content = "---\nname: fixture\ndescription: fixture\n---\nbody\n";
	fixture.write.mockResolvedValue(undefined);
	fixture.remove.mockResolvedValue(undefined);
	fixture.reload.mockResolvedValue(0);
});

describe("package skill deletion boundary", () => {
	it.each(["global-npm", "project-npm", "global-git", "project-git", "local-package"])("protects %s including package-root SKILL.md", async (kind) => {
		const root = kind === "global-npm" ? path.join(fixture.agentDir, "npm", "node_modules", "fixture")
			: kind === "project-npm" ? path.join(fixture.cwd, ".pi", "npm", "node_modules", "fixture")
				: kind === "global-git" ? path.join(fixture.agentDir, "git", "github.com", "owner", "fixture")
					: kind === "project-git" ? path.join(fixture.cwd, ".pi", "git", "github.com", "owner", "fixture")
						: path.join(fixture.cwd, "local-plugin");
		const file = path.join(root, "SKILL.md");
		addSkill(file, "package", kind.startsWith("global") ? "user" : "project");
		expect((await listSkills(fixture.cwd))[0].origin).toBe("package");
		await expect(deleteSkill(file, fixture.cwd)).rejects.toThrow(/package-managed skill/);
		expect(fixture.remove).not.toHaveBeenCalled();
	});

	it("retains package origin when a parent link points outside the managed directory", async () => {
		const discovered = path.join(fixture.agentDir, "git", "github.com", "owner", "fixture", "SKILL.md");
		const canonical = path.join(fixture.cwd, "linked-checkout", "SKILL.md");
		fixture.aliases.set(discovered, canonical);
		addSkill(discovered, "package");
		expect((await listSkills(fixture.cwd))[0].origin).toBe("package");
		await expect(deleteSkill(canonical, fixture.cwd)).rejects.toThrow(/package-managed skill/);
		expect(fixture.remove).not.toHaveBeenCalled();
	});

	it("rejects a skills-directory alias into node_modules even without source metadata", async () => {
		const discovered = path.join(fixture.agentDir, "skills", "alias", "SKILL.md");
		const canonical = path.join(fixture.agentDir, "npm", "node_modules", "fixture", "SKILL.md");
		fixture.aliases.set(discovered, canonical);
		addSkill(discovered);
		await expect(deleteSkill(discovered, fixture.cwd)).rejects.toThrow(/package-managed skill/);
		expect(fixture.remove).not.toHaveBeenCalled();
	});

	it("keeps ordinary user skills removable", async () => {
		const file = path.join(fixture.agentDir, "skills", "fixture", "SKILL.md");
		addSkill(file, "top-level");
		const userSkill = (await listSkills(fixture.cwd))[0];
		expect(userSkill.scope).toBe("user");
		expect(userSkill.origin).toBe("top-level");
		await expect(deleteSkill(file, fixture.cwd)).resolves.toEqual({ removed: path.dirname(file) });
		expect(fixture.remove).toHaveBeenCalledWith(path.dirname(file));
	});

	it.each(["user", "project"] as const)("blocks a canonical package target even when SDK marks its reference top-level in %s scope", async (scope) => {
		const root = scope === "user" ? fixture.agentDir : fixture.cwd;
		const discovered = path.join(root, "skills", "alias", "SKILL.md");
		const canonical = scope === "user"
			? path.join(fixture.agentDir, "npm", "node_modules", "fixture", "SKILL.md")
			: path.join(fixture.cwd, ".pi", "git", "host", "fixture", "SKILL.md");
		fixture.aliases.set(discovered, canonical);
		addSkill(discovered, "top-level", scope);
		await expect(deleteSkill(discovered, fixture.cwd)).rejects.toThrow(/package-managed skill/);
		expect(fixture.remove).not.toHaveBeenCalled();
	});

	it.each(["user", "project"] as const)("protects a junction package root from a top-level skill alias in %s scope", async (scope) => {
		const managedRoot = scope === "user" ? path.join(fixture.agentDir, "git") : path.join(fixture.cwd, ".pi", "git");
		const canonicalRoot = path.resolve(os.tmpdir(), "piweb-safety-package-cache");
		const discovered = path.join(scope === "user" ? fixture.agentDir : fixture.cwd, "skills", "alias", "SKILL.md");
		fixture.aliases.set(managedRoot, canonicalRoot);
		fixture.aliases.set(discovered, path.join(canonicalRoot, "host", "fixture", "SKILL.md"));
		addSkill(discovered, "top-level", scope);
		await expect(deleteSkill(discovered, fixture.cwd)).rejects.toThrow(/package-managed skill/);
		expect(fixture.remove).not.toHaveBeenCalled();
	});
});

describe("shared skill root deletion boundary", () => {
	it.each(["user", "project"] as const)("protects a junction skill root while removing only its SKILL.md in %s scope", async (scope) => {
		const root = scope === "user" ? path.join(fixture.agentDir, "skills") : path.join(fixture.cwd, ".pi", "skills");
		const canonicalRoot = path.resolve(os.tmpdir(), "piweb-safety-shared-skills");
		const discovered = path.join(root, "SKILL.md");
		const canonical = path.join(canonicalRoot, "SKILL.md");
		fixture.aliases.set(root, canonicalRoot);
		fixture.aliases.set(discovered, canonical);
		addSkill(discovered, "top-level", scope);
		await expect(deleteSkill(discovered, fixture.cwd)).resolves.toEqual({ removed: canonical });
		expect(fixture.remove).toHaveBeenCalledWith(canonical);
	});
});

describe("scope and origin without SDK metadata", () => {
	it("treats a workspace skill as project-level and a managed package skill as packaged", async () => {
		const local = path.join(fixture.cwd, ".pi", "skills", "local", "SKILL.md");
		addSkill(local);
		expect(await listSkills(fixture.cwd)).toMatchObject([
			{ scope: "project", origin: "top-level" },
		]);
	});

	it("keeps a workspace node_modules skill project-level but packaged", async () => {
		const packaged = path.join(fixture.cwd, "node_modules", "pkg", "skills", "x", "SKILL.md");
		addSkill(packaged);
		expect(await listSkills(fixture.cwd)).toMatchObject([
			{ scope: "project", origin: "package" },
		]);
	});
});

describe("skill invocation frontmatter edits", () => {
	it("adds only the root flag while leaving a nested flag and its following field intact", async () => {
		const file = path.join(fixture.agentDir, "skills", "fixture", "SKILL.md");
		addSkill(file);
		fixture.content = "---\nname: fixture\ndescription: fixture\nmetadata:\n  disable-model-invocation: false\n  category: sample\n---\nbody\n";
		await expect(setSkillDisabled(file, true, fixture.cwd)).resolves.toEqual({ changed: true });
		const written = fixture.write.mock.calls[0][1] as string;
		const yaml = written.slice(4, written.indexOf("\n---", 4));
		expect(parse(yaml)).toMatchObject({ "disable-model-invocation": true, metadata: { "disable-model-invocation": false, category: "sample" } });
		expect(written).toContain("metadata:\n  disable-model-invocation: false\n  category: sample");
		expect(written.endsWith("\n---\nbody\n")).toBe(true);
	});

	it.each([true, false])("updates BOM/CRLF frontmatter to %s without changing its encoding marker or body", async (disabled) => {
		const file = path.join(fixture.agentDir, "skills", "fixture", "SKILL.md");
		addSkill(file);
		fixture.content = `\uFEFF---\r\nname: fixture\r\ndescription: fixture\r\ndisable-model-invocation: ${!disabled} # keep\r\n---\r\nbody\r\n`;
		await expect(setSkillDisabled(file, disabled, fixture.cwd)).resolves.toEqual({ changed: true });
		expect(fixture.write.mock.calls[0][0]).toMatch(/\.tmp$/);
		expect(fixture.write.mock.calls[0][1]).toBe(fixture.content.replace(`${!disabled} # keep`, `${disabled} # keep`));
	});
});
