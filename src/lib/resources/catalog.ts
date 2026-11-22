import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest, type RequestOptions } from "node:https";
import bundledCatalog from "../../../resources/catalog/index.json";
import { validatePackageSource } from "../package-manager-safe";
import { getResourcePreferences, publicCatalogUrl } from "./preferences";
import type { ResourceCatalog, ResourceCatalogItem } from "./protocol";
import { parseResourceSelection } from "./selection";

const MAX_CATALOG_BYTES = 512 * 1024;
const MAX_ITEMS = 500;
const CACHE_MS = 5 * 60_000;
const catalogs = new Map<string, { at: number; catalog: ResourceCatalog; pending?: Promise<ResourceCatalog> }>();
const str = (value: unknown, max: number) => typeof value === "string" ? value.slice(0, max) : "";

function publicRepository(value: unknown): string | undefined {
	if (typeof value !== "string" || !value) return undefined;
	return publicCatalogUrl(value);
}

export function parseResourceCatalog(raw: unknown): ResourceCatalog {
	if (!raw || typeof raw !== "object" || Array.isArray(raw) || (raw as { version?: unknown }).version !== 1 || !Array.isArray((raw as { items?: unknown }).items)) throw new Error("Unsupported resource catalog format");
	const items: ResourceCatalogItem[] = [];
	const seen = new Set<string>();
	for (const rawItem of (raw as { items: unknown[] }).items.slice(0, MAX_ITEMS)) {
		if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) continue;
		const item = rawItem as Record<string, unknown>;
		const id = str(item.id, 160);
		const name = str(item.name, 160);
		if (!/^[\w@][\w@./-]*$/.test(id) || id.includes("..") || !name || seen.has(id)) continue;
		const types = Array.isArray(item.types) ? [...new Set(item.types.filter((type): type is ResourceCatalogItem["types"][number] => type === "extensions" || type === "skills" || type === "prompts"))] : [];
		if (!types.length) continue;
		const source = typeof item.source === "string" && item.source ? item.source : undefined;
		try {
			if (source) {
				validatePackageSource(source);
				// A remotely fetched catalog cannot point the installer at arbitrary host files.
				if (!/^(?:npm:|git:|https:\/\/)/.test(source)) continue;
				if (source.startsWith("https:")) publicCatalogUrl(source);
				if (source.startsWith("git:") && !/^git:(?:https:\/\/)?(?:github\.com|gitlab\.com)\/[\w.-]+\/[\w.-]+(?:@[\w./-]+)?$/.test(source)) continue;
			}
			const repository = publicRepository(item.repository);
			const selection = item.selection === undefined ? undefined : parseResourceSelection(item.selection);
			const compatibility = item.compatibility === "web" || item.compatibility === "adapt" ? item.compatibility : "unknown";
			const apiVersion = Number.isSafeInteger(item.apiVersion) && Number(item.apiVersion) > 0 ? Number(item.apiVersion) : undefined;
			items.push({ id, name, description: str(item.description, 4000), author: str(item.author, 160), version: str(item.version, 80), types, compatibility,
				...(source ? { source } : {}), ...(selection ? { selection } : {}), ...(repository ? { repository } : {}), ...(apiVersion ? { apiVersion } : {}) });
			seen.add(id);
		} catch { /* A malformed item is not a reason to execute or expose its contents. */ }
	}
	return { version: 1, items };
}

export function readBundledResourceCatalog(): ResourceCatalog {
	return parseResourceCatalog(bundledCatalog);
}

function privateAddress(address: string): boolean {
	if (isIP(address) === 4) {
		const [a, b] = address.split(".").map(Number);
		return a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127;
	}
	if (isIP(address) !== 6) return true;
	const normalized = address.toLowerCase();
	return !/^[23]/.test(normalized);
}

async function fetchCatalog(url: string): Promise<ResourceCatalog> {
	const parsed = new URL(publicCatalogUrl(url));
	let dnsTimer: ReturnType<typeof setTimeout> | undefined;
	const addresses = await Promise.race([
		lookup(parsed.hostname, { all: true }),
		new Promise<never>((_resolve, reject) => { dnsTimer = setTimeout(() => reject(new Error("Catalog DNS timed out")), 8_000); }),
	]).finally(() => { if (dnsTimer) clearTimeout(dnsTimer); });
	if (!addresses.length || addresses.some((entry) => privateAddress(entry.address))) throw new Error("Resource catalog must resolve to a public address");
	// Pin the validated addresses to this connection; a second DNS lookup would permit rebinding into a private service.
	const pinnedLookup = ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
		if (options?.all) callback(null, addresses); else callback(null, addresses[0].address, addresses[0].family);
	}) as RequestOptions["lookup"];
	const data = await new Promise<Buffer>((resolve, reject) => {
		const request = httpsRequest(parsed, { lookup: pinnedLookup, headers: { Accept: "application/json" } });
		const timer = setTimeout(() => request.destroy(new Error("Resource catalog timed out")), 8_000);
		request.once("error", reject);
		request.once("close", () => clearTimeout(timer));
		request.once("response", (response) => {
			void (async () => {
				if (response.statusCode !== 200 || Number(response.headers["content-length"]) > MAX_CATALOG_BYTES) throw new Error("Resource catalog unavailable or too large");
				const chunks: Buffer[] = []; let bytes = 0;
				for await (const chunk of response) {
					const buffer = Buffer.from(chunk); bytes += buffer.length;
					if (bytes > MAX_CATALOG_BYTES) throw new Error("Resource catalog is too large");
					chunks.push(buffer);
				}
				resolve(Buffer.concat(chunks));
			})().catch((error) => { response.destroy(); reject(error); });
		});
		request.end();
	});
	return parseResourceCatalog(JSON.parse(data.toString("utf8")));
}

export async function readResourceMarket(options: { fresh?: boolean } = {}): Promise<{ items: ResourceCatalogItem[]; warnings: string[] }> {
	const { catalogUrls } = await getResourcePreferences();
	const warnings: string[] = [];
	const result = await Promise.all(catalogUrls.map(async (url) => {
		let cached = catalogs.get(url);
		if (!options.fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.catalog;
		try {
			if (!cached) { cached = { at: 0, catalog: { version: 1, items: [] } }; catalogs.set(url, cached); }
			if (!cached.pending) cached.pending = fetchCatalog(url).then((catalog) => { cached!.catalog = catalog; cached!.at = Date.now(); return catalog; }).finally(() => { cached!.pending = undefined; });
			return await cached.pending;
		} catch {
			warnings.push(`Catalog unavailable: ${new URL(url).hostname}`);
			return cached?.catalog ?? { version: 1 as const, items: [] };
		}
	}));
	for (const key of catalogs.keys()) if (!catalogUrls.includes(key)) catalogs.delete(key);
	const items = new Map<string, ResourceCatalogItem>();
	for (const catalog of result) for (const item of catalog.items) if (!items.has(item.id)) items.set(item.id, item);
	return { items: [...items.values()], warnings };
}
