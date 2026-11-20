import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readFileBounded } from "../read-file-bounded";
import { isPathInside } from "../path-boundary";
import { resolveResourceFile } from "./manifest";
import type { ResourcePackage } from "./protocol";

/** Native ESM is cached by URL. A verified content-addressed copy gives an updated host and its local helpers new URLs. */
export async function resourceHostCode(resource: ResourcePackage, agentDir: string): Promise<{ file: string; revision: string }> {
	if (!resource.manifest?.host) throw new Error("No host entry");
	const original = await resolveResourceFile(resource.root, resource.manifest.host);
	const directory = path.dirname(original);
	const packageRoot = await fs.realpath(resource.root);
	if (directory === packageRoot) throw new Error("Host entries need a dedicated code directory");
	const files = new Map<string, Buffer>();
	let bytes = 0;
	const scan = async (root: string) => {
		for (const entry of (await fs.readdir(root, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
			if (entry.name === "node_modules" || entry.name === ".git" || entry.name === "backups") continue;
			const source = path.join(root, entry.name);
			if (entry.isSymbolicLink()) throw new Error("Host code cannot contain symlinks; bundle its local code into the declared directory");
			if (entry.isDirectory()) await scan(source);
			else if (entry.isFile()) {
				if (files.size >= 1000) throw new Error("Host code contains too many files");
				const data = await readFileBounded(source, 16 * 1024 * 1024 - bytes); bytes += data.length;
				files.set(path.relative(directory, source), data);
			}
		}
	};
	await scan(directory);
	const hash = createHash("sha256").update(`${resource.version}:${JSON.stringify(resource.manifest)}`);
	for (const [name, content] of files) hash.update(name).update("\0").update(content);
	const revision = hash.digest("hex");
	const namespace = createHash("sha256").update(`${resource.scope}:${resource.source}`).digest("hex");
	const parent = path.join(agentDir, "web-resource-runtime", namespace);
	let snapshot = path.join(parent, revision);
	await fs.mkdir(parent, { recursive: true, mode: 0o700 });
	const realParent = await fs.realpath(parent);
	if (!isPathInside(await fs.realpath(agentDir), realParent)) throw new Error("Resource runtime cache escapes the agent directory");
	try { await fs.mkdir(snapshot, { mode: 0o700 }); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if (!(await fs.stat(path.join(snapshot, ".ready")).catch(() => null))?.isFile()) {
			// Retain an interrupted copy; a retry builds a new one instead of deleting or overwriting it.
			snapshot = path.join(parent, `${revision}-${randomUUID()}`); await fs.mkdir(snapshot, { mode: 0o700 });
		} else return { file: await resolveResourceFile(snapshot, path.basename(original)), revision };
	}
	for (const [name, data] of files) {
		const destination = path.join(snapshot, name);
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await fs.writeFile(destination, data, { flag: "wx", mode: 0o600 });
		// A concurrent writer must not turn the revision into a snapshot of mixed generations.
		if (!data.equals(await readFileBounded(path.join(directory, name), 16 * 1024 * 1024))) throw new Error("Resource code changed while being loaded; retained snapshot was not activated");
	}
	if (!files.has("package.json")) await fs.writeFile(path.join(snapshot, "package.json"), '{"type":"module"}\n', { flag: "wx" });
	// Dependencies retain normal Node resolution. Resource-owned dependencies must be declared in dependencies.
	let ancestor = resource.root;
	for (;;) {
		const dependencies = path.join(ancestor, "node_modules");
		if ((await fs.stat(dependencies).catch(() => null))?.isDirectory()) {
			await fs.symlink(dependencies, path.join(snapshot, "node_modules"), process.platform === "win32" ? "junction" : "dir"); break;
		}
		const next = path.dirname(ancestor); if (next === ancestor) break; ancestor = next;
	}
	await fs.writeFile(path.join(snapshot, ".ready"), revision, { flag: "wx", mode: 0o600 });
	return { file: await resolveResourceFile(snapshot, path.basename(original)), revision };
}
