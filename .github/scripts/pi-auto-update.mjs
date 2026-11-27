#!/usr/bin/env node
/**
 * Pi SDK 自动更新：供 .github/workflows/pi-auto-update.yml 调用。
 *
 *   node .github/scripts/pi-auto-update.mjs check            判断是否需要更新（写 GITHUB_OUTPUT）
 *   node .github/scripts/pi-auto-update.mjs apply <version>  把全部 Pi 运行时包锁到 <version>，并升 PiWeb 补丁版本
 *
 * 更新规则（只看 npm 上 latest 标签的正式版，忽略预发布）：
 *   - 主版本号或次版本号不同（如 1.5.x → 1.6.x）：更新；
 *   - 同一次版本内，修订号落后 ≥ 2（如 1.6.0 → 1.6.2）：更新；
 *   - 其余情况不更新。
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PI_PACKAGE, piRuntimeSpecs, verifyPiRuntimePins } from "../../scripts/runtime/pi-packages.mjs";
import { exactRegistryVersion, OFFICIAL_REGISTRY_ARGS } from "../../scripts/update-environment.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const PATCH_THRESHOLD = 2;

/** @param {string} version */
function parse(version) {
	const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
	if (!match) throw new Error(`not a stable x.y.z version: ${version}`);
	return match.slice(1, 4).map(Number);
}

/**
 * @param {string} current
 * @param {string} latest
 * @returns {{ update: boolean, reason: string }}
 */
export function decide(current, latest) {
	const [cMajor, cMinor, cPatch] = parse(current);
	const [lMajor, lMinor, lPatch] = parse(latest);
	const newer = lMajor !== cMajor ? lMajor > cMajor : lMinor !== cMinor ? lMinor > cMinor : lPatch > cPatch;
	if (!newer) return { update: false, reason: `Pi ${current} is up to date (latest ${latest})` };
	if (lMajor !== cMajor || lMinor !== cMinor) {
		return { update: true, reason: `minor/major release changed: ${cMajor}.${cMinor}.x -> ${lMajor}.${lMinor}.x` };
	}
	const behind = lPatch - cPatch;
	if (behind >= PATCH_THRESHOLD) return { update: true, reason: `patch behind by ${behind} (>= ${PATCH_THRESHOLD})` };
	return { update: false, reason: `patch behind by ${behind} (< ${PATCH_THRESHOLD}); waiting` };
}

/** @param {string} cmd @param {string[]} args @param {{ capture?: boolean }} [options] */
function run(cmd, args, { capture = false } = {}) {
	const result = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
	if (result.error) throw result.error;
	if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited with ${result.status}`);
	return capture ? result.stdout : "";
}

/** @param {Record<string, string>} values */
function output(values) {
	for (const [key, value] of Object.entries(values)) console.log(`${key}=${value}`);
	if (process.env.GITHUB_OUTPUT) {
		appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([k, v]) => `${k}=${v}\n`).join(""));
	}
}

function readManifest() {
	return JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
}

function check() {
	const current = verifyPiRuntimePins(readManifest());
	const latest = exactRegistryVersion(run("npm", ["view", `${PI_PACKAGE}@latest`, "version", ...OFFICIAL_REGISTRY_ARGS], { capture: true }));
	const { update, reason } = decide(current, latest);
	output({ current, latest, update: String(update), reason });
}

/**
 * Sync DEFAULT_MODEL_PER_PROVIDER in src/lib/model-defaults.ts with the installed
 * Pi SDK's defaultModelPerProvider table so tests/model-defaults.test.ts stays green.
 * @returns {boolean}
 */
function syncModelDefaults() {
	const resolverPath = path.join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/core/model-resolver.js");
	const resolverSource = readFileSync(resolverPath, "utf8").replace(/\r\n/g, "\n");
	const body = /export const defaultModelPerProvider = \{([\s\S]*?)\n\};/.exec(resolverSource)?.[1] ?? "";
	const pairs = [...body.matchAll(/^\s*"?([^":\s]+)"?:\s*"([^"]+)",?$/gm)].map((m) => [m[1], m[2]]);
	if (pairs.length <= 40) {
		throw new Error(`unexpectedly few defaultModelPerProvider entries (${pairs.length}) in ${resolverPath}`);
	}

	const modelDefaultsPath = path.join(ROOT, "src/lib/model-defaults.ts");
	const currentSource = readFileSync(modelDefaultsPath, "utf8");
	const pattern = /^(export const DEFAULT_MODEL_PER_PROVIDER: Readonly<Record<string, string>> = \{(\r?\n))[\s\S]*?(\r?\n\};)/m;
	if (!pattern.test(currentSource)) {
		throw new Error(`cannot find DEFAULT_MODEL_PER_PROVIDER in ${modelDefaultsPath}`);
	}

	const updatedSource = currentSource.replace(
		pattern,
		(_match, prefix, eol, suffix) => {
			const lines = pairs.map(([provider, modelId]) => {
				const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(provider) ? provider : JSON.stringify(provider);
				return `\t${key}: ${JSON.stringify(modelId)},`;
			});
			return `${prefix}${lines.join(eol)}${suffix}`;
		},
	);
	if (updatedSource === currentSource) return false;
	writeFileSync(modelDefaultsPath, updatedSource);
	return true;
}

/** @param {string} target */
function apply(target) {
	const version = exactRegistryVersion(target ?? "");
	parse(version);
	const before = verifyPiRuntimePins(readManifest());
	if (before === version) throw new Error(`Pi is already pinned to ${version}`);

	run("npm", ["install", "--save-exact", ...piRuntimeSpecs(version), "--no-audit", "--no-fund", "--ignore-scripts", ...OFFICIAL_REGISTRY_ARGS]);
	run("npm", ["run", "sync:provider-icons"]);
	if (verifyPiRuntimePins(readManifest()) !== version) throw new Error("Pi runtime pins did not move to " + version);
	syncModelDefaults();

	run("npm", ["version", "patch", "--no-git-tag-version"]);
	const piweb = readManifest().version;

	const acknowledgements = path.join(ROOT, "ACKNOWLEDGEMENTS.md");
	if (existsSync(acknowledgements)) {
		const text = readFileSync(acknowledgements, "utf8");
		writeFileSync(acknowledgements, text.replace(`version ${before})`, `version ${version})`));
	}

	const notes = path.join(ROOT, "docs", "releases", `${piweb}.md`);
	if (!existsSync(notes)) {
		writeFileSync(notes, [
			`# PiWeb ${piweb}`,
			"",
			"## 中文",
			"",
			`- 内置 Pi 运行时包（\`@earendil-works/pi-*\` 与 Chord）从 **${before}** 统一更新到 **${version}**。`,
			"- 本版由自动化流程生成：依赖更新后已通过完整的类型检查、测试、构建与安装包校验。",
			"",
			`升级前先停止运行中的实例并备份 agent 目录，然后执行 \`npm install -g @rexvane/piweb@${piweb}\`。`,
			"",
			"## English",
			"",
			`- Update the bundled Pi runtime packages (\`@earendil-works/pi-*\` and Chord) from **${before}** to **${version}**.`,
			"- Generated by the automated update workflow after the full typecheck, test, build and package verification passed.",
			"",
			`Stop the running instance and back up the agent directory before upgrading with \`npm install -g @rexvane/piweb@${piweb}\`.`,
			"",
		].join("\n"));
	}
	output({ previous: before, pi: version, piweb });
}

const [command, arg] = process.argv.slice(2);
if (command === "check") check();
else if (command === "apply") apply(arg);
else if (command === "decide") output(Object.fromEntries(Object.entries(decide(process.argv[3], process.argv[4])).map(([k, v]) => [k, String(v)])));
else {
	console.error("Usage: pi-auto-update.mjs check | apply <version> | decide <current> <latest>");
	process.exit(2);
}
