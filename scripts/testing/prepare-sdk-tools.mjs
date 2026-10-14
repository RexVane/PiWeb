/** Prepare Pi's real search binaries before the CI suite switches to offline mode. */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createFindTool, createGrepTool } from "@earendil-works/pi-coding-agent";

if (process.env.PI_OFFLINE === "1" || /^(true|yes)$/i.test(process.env.PI_OFFLINE ?? "")) {
	throw new Error("Prepare SDK binaries with PI_OFFLINE unset, then run the tests offline.");
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const probes = [
	{ name: "fd", tool: createFindTool(root), input: { pattern: "package.json", path: root, limit: 1 } },
	{ name: "rg", tool: createGrepTool(root), input: { pattern: '"name"', path: path.join(root, "package.json"), limit: 1 } },
];
for (const { name, tool, input } of probes) {
	const result = await tool.execute(`ci-prepare-${name}`, input, AbortSignal.timeout(120_000));
	if (result.isError) throw new Error(name + ": " + JSON.stringify(result.content));
	if (!result.content.some((part) => part.type === "text" && part.text.trim())) throw new Error(name + " produced no probe output");
	console.log(`[ci] ${name} is ready for offline SDK tests`);
}
