/**
 * Pi package marketplace discovery against the npm registry (`keywords:pi-package`).
 * Only real metadata returned by npm is surfaced — nothing is fabricated locally.
 */
import fs from "node:fs";
import path from "node:path";
import { APP_ROOT } from "./app-root";

export type MarketplaceCategory = "all" | "tools" | "mcp" | "theme" | "context";

export interface PiRuntimeInfo {
	piCodingAgent: string;
	piAi: string;
	piAgentCore: string;
	node: string;
}

export type CompatibilityStatus = "compatible" | "partial" | "incompatible" | "unknown";

export type CompatibilityBlocker =
	| { kind: "dsh_only" }
	| { kind: "node_version"; required: string; current: string }
	| { kind: "pi_peer"; pkg: string; required: string; current: string };

export type CompatibilityCaveat =
	| { kind: "tui_peer" }
	| { kind: "themes_ignored" }
	| { kind: "dsh_dual" }
	| { kind: "no_pi_manifest" };

export interface PackageCompatibility {
	status: CompatibilityStatus;
	resources: {
		extensions: boolean;
		skills: boolean;
		prompts: boolean;
		themes: boolean;
	};
	hasPiManifest: boolean;
	hasDshConfig: boolean;
	hasTuiPeer: boolean;
	requiredNode?: string;
	requiredPi?: string;
	blockers: CompatibilityBlocker[];
	caveats: CompatibilityCaveat[];
}

export interface MarketplacePlugin {
	name: string;
	/** Install spec passed directly to `/api/plugins` install (e.g. `npm:pi-mcp-adapter`). */
	source: string;
	version: string;
	description: string;
	author: string;
	keywords: string[];
	updatedAt: string;
	monthlyDownloads: number | null;
	npmUrl?: string;
	repoUrl?: string;
	homepageUrl?: string;
}

export interface MarketplaceSearchResult {
	items: MarketplacePlugin[];
	fetchedAt: number;
	runtime: PiRuntimeInfo;
}

const CACHE_TTL_MS = 60_000;
const MANIFEST_CACHE_TTL_MS = 10 * 60_000;
const MAX_CACHE_ENTRIES = 40;
const MAX_MANIFEST_CACHE_ENTRIES = 160;
const REQUEST_TIMEOUT_MS = 8_000;
const MANIFEST_TIMEOUT_MS = 5_000;
const INSPECT_CONCURRENCY = 6;

const CATEGORY_TERMS: Record<MarketplaceCategory, string> = {
	all: "",
	tools: "tools extension",
	mcp: "mcp",
	theme: "theme ui",
	context: "context memory",
};

interface CacheEntry {
	expiresAt: number;
	value: MarketplaceSearchResult;
}

interface ManifestCacheEntry {
	expiresAt: number;
	value: PackageCompatibility;
}

const searchCache = new Map<string, CacheEntry>();
const manifestCache = new Map<string, ManifestCacheEntry>();
let cachedRuntimeInfo: PiRuntimeInfo | null = null;

function readInstalledPackageVersion(pkgName: string): string {
	try {
		const pkgPath = path.join(APP_ROOT, "node_modules", ...pkgName.split("/"), "package.json");
		const parsed = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version?: unknown };
		if (typeof parsed.version === "string" && parsed.version.trim()) {
			return parsed.version.trim();
		}
	} catch {
		// Fall through to unknown if package.json cannot be read directly.
	}
	return "0.0.0";
}

export function getLocalPiRuntimeInfo(): PiRuntimeInfo {
	if (cachedRuntimeInfo) return cachedRuntimeInfo;
	cachedRuntimeInfo = {
		piCodingAgent: readInstalledPackageVersion("@earendil-works/pi-coding-agent"),
		piAi: readInstalledPackageVersion("@earendil-works/pi-ai"),
		piAgentCore: readInstalledPackageVersion("@earendil-works/pi-agent-core"),
		node: process.versions.node || "0.0.0",
	};
	return cachedRuntimeInfo;
}

interface SemverParts {
	major: number;
	minor: number;
	patch: number;
	prerelease: string;
}

function parseSemver(raw: string): SemverParts | null {
	const cleaned = raw.trim().replace(/^v/i, "");
	const m = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(cleaned);
	if (!m) return null;
	return {
		major: Number(m[1]),
		minor: m[2] !== undefined ? Number(m[2]) : 0,
		patch: m[3] !== undefined ? Number(m[3]) : 0,
		prerelease: m[4] ?? "",
	};
}

function compareSemver(a: SemverParts, b: SemverParts): number {
	if (a.major !== b.major) return a.major - b.major;
	if (a.minor !== b.minor) return a.minor - b.minor;
	if (a.patch !== b.patch) return a.patch - b.patch;
	if (!a.prerelease && !b.prerelease) return 0;
	if (!a.prerelease) return 1;
	if (!b.prerelease) return -1;
	const aParts = a.prerelease.split(".");
	const bParts = b.prerelease.split(".");
	const len = Math.max(aParts.length, bParts.length);
	for (let i = 0; i < len; i += 1) {
		if (i >= aParts.length) return -1;
		if (i >= bParts.length) return 1;
		const ap = aParts[i];
		const bp = bParts[i];
		const aNum = /^\d+$/.test(ap) ? Number(ap) : null;
		const bNum = /^\d+$/.test(bp) ? Number(bp) : null;
		if (aNum !== null && bNum !== null) {
			if (aNum !== bNum) return aNum - bNum;
		} else if (aNum !== null) {
			return -1;
		} else if (bNum !== null) {
			return 1;
		} else if (ap !== bp) {
			return ap < bp ? -1 : 1;
		}
	}
	return 0;
}

function parseWildcardVersion(token: string): { major: number | null; minor: number | null; patch: number | null; prerelease: string } | null {
	const cleaned = token.trim().replace(/^v/i, "").split("+")[0];
	const [core, ...pre] = cleaned.split("-");
	const parts = core.split(".");
	if (parts.length === 0 || parts.length > 3) return null;
	const nums: Array<number | null> = [];
	for (const p of parts) {
		if (p === "*" || p.toLowerCase() === "x") nums.push(null);
		else if (/^\d+$/.test(p)) nums.push(Number(p));
		else return null;
	}
	return {
		major: nums[0] ?? null,
		minor: nums.length > 1 ? nums[1] : null,
		patch: nums.length > 2 ? nums[2] : null,
		prerelease: pre.join("-"),
	};
}

function matchSingleComparator(actual: SemverParts, rawComp: string): boolean | null {
	const comp = rawComp.trim();
	if (!comp || comp === "*" || comp.toLowerCase() === "x" || comp === "latest") return true;

	const caretMatch = /^\^(.+)$/.exec(comp);
	if (caretMatch) {
		const w = parseWildcardVersion(caretMatch[1]);
		if (!w || w.major === null) return true;
		const lower: SemverParts = { major: w.major, minor: w.minor ?? 0, patch: w.patch ?? 0, prerelease: w.prerelease };
		let upper: SemverParts;
		if (w.major > 0) {
			upper = { major: w.major + 1, minor: 0, patch: 0, prerelease: "0" };
		} else if ((w.minor ?? 0) > 0) {
			upper = { major: 0, minor: (w.minor ?? 0) + 1, patch: 0, prerelease: "0" };
		} else if (w.minor === null) {
			upper = { major: 1, minor: 0, patch: 0, prerelease: "0" };
		} else if (w.patch !== null) {
			upper = { major: 0, minor: 0, patch: w.patch + 1, prerelease: "0" };
		} else {
			upper = { major: 0, minor: 1, patch: 0, prerelease: "0" };
		}
		return compareSemver(actual, lower) >= 0 && compareSemver(actual, upper) < 0;
	}

	const tildeMatch = /^~(.+)$/.exec(comp);
	if (tildeMatch) {
		const w = parseWildcardVersion(tildeMatch[1]);
		if (!w || w.major === null) return true;
		const lower: SemverParts = { major: w.major, minor: w.minor ?? 0, patch: w.patch ?? 0, prerelease: w.prerelease };
		const upper: SemverParts = w.minor === null
			? { major: w.major + 1, minor: 0, patch: 0, prerelease: "0" }
			: { major: w.major, minor: w.minor + 1, patch: 0, prerelease: "0" };
		return compareSemver(actual, lower) >= 0 && compareSemver(actual, upper) < 0;
	}

	const opMatch = /^(>=|<=|>|<|=)?(.+)$/.exec(comp);
	if (!opMatch) return null;
	const op = opMatch[1] || "=";
	const targetToken = opMatch[2].trim();
	const w = parseWildcardVersion(targetToken);
	if (!w) return null;
	if (w.major === null) return true;

	const low: SemverParts = { major: w.major, minor: w.minor ?? 0, patch: w.patch ?? 0, prerelease: w.prerelease };
	const isWildcard = w.minor === null || w.patch === null;
	if (!isWildcard) {
		const cmp = compareSemver(actual, low);
		if (op === "=") return cmp === 0;
		if (op === ">=") return cmp >= 0;
		if (op === "<=") return cmp <= 0;
		if (op === ">") return cmp > 0;
		return cmp < 0;
	}

	const nextUpper: SemverParts = w.minor === null
		? { major: w.major + 1, minor: 0, patch: 0, prerelease: "0" }
		: { major: w.major, minor: w.minor + 1, patch: 0, prerelease: "0" };

	if (op === "=") return compareSemver(actual, low) >= 0 && compareSemver(actual, nextUpper) < 0;
	if (op === ">=") return compareSemver(actual, low) >= 0;
	if (op === "<") return compareSemver(actual, low) < 0;
	if (op === "<=") return compareSemver(actual, nextUpper) < 0;
	return compareSemver(actual, nextUpper) >= 0;
}

export function satisfiesSemverRange(version: string, range: string): boolean {
	const actual = parseSemver(version);
	if (!actual) return true;
	const cleanedRange = range.trim();
	if (!cleanedRange || cleanedRange === "*" || cleanedRange === "latest") return true;

	const clauses = cleanedRange.split("||");
	let parsedAnyClause = false;
	for (const rawClause of clauses) {
		const clause = rawClause.trim();
		if (!clause) {
			parsedAnyClause = true;
			return true;
		}
		const hyphen = /^([^\s]+)\s+-\s+([^\s]+)$/.exec(clause);
		if (hyphen) {
			const lowOk = matchSingleComparator(actual, `>=${hyphen[1]}`);
			const highOk = matchSingleComparator(actual, `<=${hyphen[2]}`);
			if (lowOk !== null && highOk !== null) {
				parsedAnyClause = true;
				if (lowOk && highOk) return true;
			}
			continue;
		}
		const normalized = clause.replace(/([<>]=?|=|\^|~)\s+/g, "$1");
		const tokens = normalized.split(/\s+/).filter(Boolean);
		if (tokens.length === 0) continue;
		let allMatch = true;
		let clauseValid = true;
		for (const token of tokens) {
			const matched = matchSingleComparator(actual, token);
			if (matched === null) {
				clauseValid = false;
				break;
			}
			if (!matched) {
				allMatch = false;
			}
		}
		if (clauseValid) {
			parsedAnyClause = true;
			if (allMatch) return true;
		}
	}
	return !parsedAnyClause;
}

export function evaluatePackageCompatibility(
	manifest: Record<string, unknown>,
	runtime: PiRuntimeInfo = getLocalPiRuntimeInfo(),
): PackageCompatibility {
	const piObj = manifest.pi && typeof manifest.pi === "object" && !Array.isArray(manifest.pi)
		? (manifest.pi as Record<string, unknown>)
		: null;
	const hasPiManifest = Boolean(piObj);
	const hasNonEmptyList = (val: unknown) => Array.isArray(val) && val.some((entry) => typeof entry === "string" && entry.trim().length > 0);
	const resources = {
		extensions: Boolean(piObj && hasNonEmptyList(piObj.extensions)),
		skills: Boolean(piObj && hasNonEmptyList(piObj.skills)),
		prompts: Boolean(piObj && hasNonEmptyList(piObj.prompts)),
		themes: Boolean(piObj && hasNonEmptyList(piObj.themes)),
	};

	const hasDshConfig = Boolean(manifest.dsh && typeof manifest.dsh === "object");
	const peers = manifest.peerDependencies && typeof manifest.peerDependencies === "object" && !Array.isArray(manifest.peerDependencies)
		? (manifest.peerDependencies as Record<string, unknown>)
		: {};
	const engines = manifest.engines && typeof manifest.engines === "object" && !Array.isArray(manifest.engines)
		? (manifest.engines as Record<string, unknown>)
		: {};

	const blockers: CompatibilityBlocker[] = [];
	const caveats: CompatibilityCaveat[] = [];

	const hasDshPeer = Object.keys(peers).some((k) => k === "@deepseek-ai/cordis" || k.startsWith("@deepseek-ai/dsh-"));
	if (!hasPiManifest && (hasDshConfig || hasDshPeer)) {
		blockers.push({ kind: "dsh_only" });
	}

	const requiredNode = typeof engines.node === "string" && engines.node.trim() ? engines.node.trim() : undefined;
	if (requiredNode && runtime.node !== "0.0.0" && !satisfiesSemverRange(runtime.node, requiredNode)) {
		blockers.push({ kind: "node_version", required: requiredNode, current: runtime.node });
	}

	const piPeerTargets: Array<{ key: string; current: string }> = [
		{ key: "@earendil-works/pi-coding-agent", current: runtime.piCodingAgent },
		{ key: "@mariozechner/pi-coding-agent", current: runtime.piCodingAgent },
		{ key: "@earendil-works/pi-ai", current: runtime.piAi },
		{ key: "@mariozechner/pi-ai", current: runtime.piAi },
		{ key: "@earendil-works/pi-agent-core", current: runtime.piAgentCore },
		{ key: "@mariozechner/pi-agent-core", current: runtime.piAgentCore },
	];

	let requiredPi: string | undefined;
	for (const { key, current } of piPeerTargets) {
		const rawRange = peers[key];
		if (typeof rawRange !== "string" || !rawRange.trim()) continue;
		const range = rawRange.trim();
		if (!requiredPi && key.includes("pi-coding-agent")) {
			requiredPi = range;
		}
		if (current !== "0.0.0" && !satisfiesSemverRange(current, range)) {
			blockers.push({ kind: "pi_peer", pkg: key, required: range, current });
		}
	}
	if (!requiredPi) {
		for (const { key } of piPeerTargets) {
			const rawRange = peers[key];
			if (typeof rawRange === "string" && rawRange.trim()) {
				requiredPi = rawRange.trim();
				break;
			}
		}
	}

	const hasTuiPeer =
		(typeof peers["@earendil-works/pi-tui"] === "string" && peers["@earendil-works/pi-tui"].trim().length > 0)
		|| (typeof peers["@mariozechner/pi-tui"] === "string" && peers["@mariozechner/pi-tui"].trim().length > 0);
	if (hasTuiPeer) {
		caveats.push({ kind: "tui_peer" });
	}
	if (resources.themes) {
		caveats.push({ kind: "themes_ignored" });
	}
	if (hasPiManifest && (hasDshConfig || hasDshPeer)) {
		caveats.push({ kind: "dsh_dual" });
	}
	if (!hasPiManifest && blockers.every((b) => b.kind !== "dsh_only")) {
		caveats.push({ kind: "no_pi_manifest" });
	}

	let status: CompatibilityStatus;
	if (blockers.length > 0) {
		status = "incompatible";
	} else if (resources.themes && !resources.extensions && !resources.skills && !resources.prompts) {
		status = "partial";
	} else if (hasPiManifest && (resources.extensions || resources.skills || resources.prompts)) {
		status = "compatible";
	} else {
		status = "unknown";
	}

	return {
		status,
		resources,
		hasPiManifest,
		hasDshConfig: hasDshConfig || hasDshPeer,
		hasTuiPeer,
		...(requiredNode ? { requiredNode } : {}),
		...(requiredPi ? { requiredPi } : {}),
		blockers,
		caveats,
	};
}

export function clearMarketplaceCache(): void {
	searchCache.clear();
	manifestCache.clear();
}

function cleanHttpUrl(raw: unknown): string | undefined {
	if (typeof raw !== "string") return undefined;
	const trimmed = raw.trim().replace(/^git\+/, "").replace(/\.git(#.*)?$/i, "");
	try {
		const url = new URL(trimmed);
		if (url.protocol === "https:" || url.protocol === "http:") {
			return url.toString();
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export function normalizeNpmSearchItem(raw: unknown): MarketplacePlugin | null {
	if (!raw || typeof raw !== "object") return null;
	const obj = raw as Record<string, unknown>;
	const pkg = (obj.package && typeof obj.package === "object" ? obj.package : null) as Record<string, unknown> | null;
	if (!pkg) return null;

	const name = typeof pkg.name === "string" ? pkg.name.trim() : "";
	if (!name) return null;
	if (!Array.isArray(pkg.keywords) || !pkg.keywords.some((keyword) => typeof keyword === "string" && keyword.trim().toLowerCase() === "pi-package")) return null;

	const version = typeof pkg.version === "string" ? pkg.version.trim() : "";
	const description = typeof pkg.description === "string" ? pkg.description.trim() : "";
	const publisher = (pkg.publisher && typeof pkg.publisher === "object" ? pkg.publisher : null) as Record<string, unknown> | null;
	const authorObj = (pkg.author && typeof pkg.author === "object" ? pkg.author : null) as Record<string, unknown> | null;
	const author = (typeof publisher?.username === "string" && publisher.username.trim())
		|| (typeof authorObj?.name === "string" && authorObj.name.trim())
		|| "";

	const keywords = Array.isArray(pkg.keywords)
		? pkg.keywords
			.filter((k): k is string => typeof k === "string")
			.map((k) => k.trim())
			.filter((k) => k.length > 0 && k.toLowerCase() !== "pi-package")
		: [];

	const downloads = (obj.downloads && typeof obj.downloads === "object" ? obj.downloads : null) as Record<string, unknown> | null;
	const monthly = typeof downloads?.monthly === "number" && Number.isFinite(downloads.monthly) && downloads.monthly >= 0
		? Math.round(downloads.monthly)
		: null;

	const updatedAt = (typeof pkg.date === "string" && pkg.date)
		|| (typeof obj.updated === "string" && obj.updated)
		|| "";

	const links = (pkg.links && typeof pkg.links === "object" ? pkg.links : null) as Record<string, unknown> | null;
	const npmUrl = cleanHttpUrl(links?.npm) ?? `https://www.npmjs.com/package/${encodeURIComponent(name)}`;
	const repoUrl = cleanHttpUrl(links?.repository);
	const homepageUrl = cleanHttpUrl(links?.homepage);

	return {
		name,
		source: `npm:${name}@${version}`,
		version,
		description,
		author,
		keywords,
		updatedAt,
		monthlyDownloads: monthly,
		...(npmUrl ? { npmUrl } : {}),
		...(repoUrl ? { repoUrl } : {}),
		...(homepageUrl ? { homepageUrl } : {}),
	};
}

export function buildMarketplaceSearchText(query: string, category: MarketplaceCategory): string {
	// User input is text: strip DSL operators, quotes and leading exclusions.
	// Keep package-name punctuation and Unicode search words.
	const cleanedQuery = query.trim().slice(0, 120).replace(/[^\p{L}\p{N}\p{M}@/._-]+/gu, " ").split(/\s+/).map((term) => term.replace(/^-+/, "")).filter(Boolean).join(" ");
	const catTerm = CATEGORY_TERMS[category] ?? "";
	return ["keywords:pi-package", catTerm, cleanedQuery].filter(Boolean).join(" ");
}

export async function searchMarketplacePlugins(options?: {
	query?: string;
	category?: MarketplaceCategory;
	size?: number;
	refresh?: boolean;
	fetcher?: typeof fetch;
}): Promise<MarketplaceSearchResult> {
	const query = options?.query?.trim() ?? "";
	const category: MarketplaceCategory = options?.category && Object.hasOwn(CATEGORY_TERMS, options.category)
		? options.category
		: "all";
	const size = Math.max(1, Math.min(50, Math.round(options?.size ?? 24)));
	const cacheKey = `${category}::${size}::${query.toLowerCase()}`;
	const now = Date.now();

	if (!options?.refresh) {
		const cached = searchCache.get(cacheKey);
		if (cached && cached.expiresAt > now) {
			return cached.value;
		}
	}

	const text = buildMarketplaceSearchText(query, category);
	const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=${size}`;
	const fetcher = options?.fetcher ?? fetch;
	const res = await fetcher(url, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
	});
	if (!res.ok) {
		throw new Error(`npm registry returned HTTP ${res.status}`);
	}
	const data = (await res.json()) as { objects?: unknown[] };
	const rawObjects = Array.isArray(data?.objects) ? data.objects : [];
	const items = rawObjects
		.map(normalizeNpmSearchItem)
		.filter((item): item is MarketplacePlugin => item !== null);
	const result: MarketplaceSearchResult = { items, fetchedAt: now, runtime: getLocalPiRuntimeInfo() };

	if (searchCache.size >= MAX_CACHE_ENTRIES) {
		const oldestKey = searchCache.keys().next().value;
		if (oldestKey !== undefined) searchCache.delete(oldestKey);
	}
	searchCache.set(cacheKey, { expiresAt: now + CACHE_TTL_MS, value: result });
	return result;
}

export async function inspectMarketplacePackages(
	specs: Array<{ name: string; version?: string }>,
	options?: { runtime?: PiRuntimeInfo; fetcher?: typeof fetch },
): Promise<Record<string, PackageCompatibility | { error: true }>> {
	const runtime = options?.runtime ?? getLocalPiRuntimeInfo();
	const fetcher = options?.fetcher ?? fetch;
	const now = Date.now();
	const out: Record<string, PackageCompatibility | { error: true }> = {};
	const pending: Array<{ name: string; version: string; cacheKey: string }> = [];
	const seen = new Set<string>();

	for (const spec of specs.slice(0, 36)) {
		const name = typeof spec?.name === "string" ? spec.name.trim() : "";
		if (!name || seen.has(name)) continue;
		seen.add(name);
		const version = typeof spec.version === "string" && spec.version.trim() ? spec.version.trim() : "latest";
		const cacheKey = `${name}@${version}::${runtime.piCodingAgent}::${runtime.node}`;
		const cached = manifestCache.get(cacheKey);
		if (cached && cached.expiresAt > now) {
			out[name] = cached.value;
		} else {
			pending.push({ name, version, cacheKey });
		}
	}

	let cursor = 0;
	const workerCount = Math.min(INSPECT_CONCURRENCY, pending.length);
	await Promise.all(
		Array.from({ length: workerCount }, async () => {
			while (cursor < pending.length) {
				const idx = cursor;
				cursor += 1;
				const target = pending[idx];
				try {
					const url = `https://registry.npmjs.org/${encodeURIComponent(target.name)}/${encodeURIComponent(target.version)}`;
					const res = await fetcher(url, {
						headers: { Accept: "application/json" },
						signal: AbortSignal.timeout(MANIFEST_TIMEOUT_MS),
					});
					if (!res.ok) {
						out[target.name] = { error: true };
						continue;
					}
					const manifest = (await res.json()) as Record<string, unknown>;
					const compat = evaluatePackageCompatibility(manifest, runtime);
					if (manifestCache.size >= MAX_MANIFEST_CACHE_ENTRIES) {
						const oldestKey = manifestCache.keys().next().value;
						if (oldestKey !== undefined) manifestCache.delete(oldestKey);
					}
					manifestCache.set(target.cacheKey, { expiresAt: Date.now() + MANIFEST_CACHE_TTL_MS, value: compat });
					out[target.name] = compat;
				} catch {
					out[target.name] = { error: true };
				}
			}
		}),
	);

	return out;
}
