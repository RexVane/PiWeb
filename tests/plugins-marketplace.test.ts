import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildMarketplaceSearchText,
	clearMarketplaceCache,
	evaluatePackageCompatibility,
	inspectMarketplacePackages,
	normalizeNpmSearchItem,
	satisfiesSemverRange,
	searchMarketplacePlugins,
} from "@/lib/plugins-marketplace";

afterEach(() => {
	clearMarketplaceCache();
});

describe("plugins marketplace service", () => {
	it("builds search text scoped to pi-package keywords and category terms", () => {
		expect(buildMarketplaceSearchText("", "all")).toBe("keywords:pi-package");
		expect(buildMarketplaceSearchText("sqlite", "mcp")).toBe("keywords:pi-package mcp sqlite");
		expect(buildMarketplaceSearchText('author:alice -keywords:react "mcp" 中文', "all")).toBe("keywords:pi-package author alice keywords react mcp 中文");
	});

	it("normalizes real npm registry items without inventing missing fields", () => {
		const item = normalizeNpmSearchItem({
			downloads: { monthly: 12345 },
			updated: "2026-11-10T00:00:00Z",
			package: {
				name: "pi-mcp-adapter",
				version: "7.0.1",
				description: "MCP adapter for pi",
				keywords: ["pi-package", "mcp", "adapter"],
				publisher: { username: "nicopreme" },
				links: {
					repository: "git+https://github.com/nicobailon/pi-mcp-adapter.git",
					npm: "https://www.npmjs.com/package/pi-mcp-adapter",
				},
			},
		});
		expect(item).toEqual({
			name: "pi-mcp-adapter",
   source: "npm:pi-mcp-adapter@7.0.1",
			version: "7.0.1",
			description: "MCP adapter for pi",
			author: "nicopreme",
			keywords: ["mcp", "adapter"],
			updatedAt: "2026-11-10T00:00:00Z",
			monthlyDownloads: 12345,
			npmUrl: "https://www.npmjs.com/package/pi-mcp-adapter",
			repoUrl: "https://github.com/nicobailon/pi-mcp-adapter",
		});

		const bare = normalizeNpmSearchItem({ package: { name: "pi-minimal", keywords: ["pi-package"] } });
		expect(bare?.monthlyDownloads).toBeNull();
		expect(bare?.repoUrl).toBeUndefined();
		expect(normalizeNpmSearchItem({ package: { name: "ordinary-package", keywords: ["mcp"] } })).toBeNull();
	});

	it("caches marketplace search responses and supports forced refresh", async () => {
		const fetcher = vi.fn(async () =>
			new Response(
				JSON.stringify({
					total: 1,
					objects: [
						{
							package: {
								name: "pi-test-pkg",
								version: "1.0.0",
								description: "Test package",
								keywords: ["pi-package", "tools"],
							},
						},
					],
				}),
				{ status: 200 },
			),
		) as unknown as typeof fetch;

		const first = await searchMarketplacePlugins({ query: "test", category: "tools", fetcher });
		const second = await searchMarketplacePlugins({ query: "test", category: "tools", fetcher });
		expect(first.items).toHaveLength(1);
		expect(second.items[0].name).toBe("pi-test-pkg");
		expect(fetcher).toHaveBeenCalledTimes(1);

		await searchMarketplacePlugins({ query: "test", category: "tools", refresh: true, fetcher });
		expect(fetcher).toHaveBeenCalledTimes(2);
	});

	it("evaluates semver ranges and package compatibility against runtime", () => {
		const runtime = {
			piCodingAgent: "1.5.2",
			piAi: "1.5.2",
			piAgentCore: "1.5.2",
			node: "24.12.0",
		};

		expect(satisfiesSemverRange("1.5.2", "^0.84.1 || ^1.0.0")).toBe(true);
		expect(satisfiesSemverRange("1.5.2", "^0.45.0")).toBe(false);
		expect(satisfiesSemverRange("24.12.0", ">=24.15.0")).toBe(false);
		expect(satisfiesSemverRange("24.12.0", ">=22.19.0")).toBe(true);

		const compat = evaluatePackageCompatibility(
			{
				pi: { extensions: ["./dist/index.js"] },
				engines: { node: ">=22.19.0" },
				peerDependencies: {
					"@earendil-works/pi-ai": "^0.99.0 || ^1.0.0",
					"@earendil-works/pi-tui": "*",
				},
			},
			runtime,
		);
		expect(compat.status).toBe("compatible");
		expect(compat.blockers).toEqual([]);
		expect(compat.caveats).toEqual([{ kind: "tui_peer" }]);

		const nodeMismatch = evaluatePackageCompatibility(
			{ pi: { extensions: ["./index.js"] }, engines: { node: ">=24.15.0" } },
			runtime,
		);
		expect(nodeMismatch.status).toBe("incompatible");
		expect(nodeMismatch.blockers).toEqual([
			{ kind: "node_version", required: ">=24.15.0", current: "24.12.0" },
		]);

		const dshOnly = evaluatePackageCompatibility(
			{ dsh: { bundle: { patch: "./cordis.patch.yml" } }, peerDependencies: { "@deepseek-ai/cordis": "^4.0.4" } },
			runtime,
		);
		expect(dshOnly.status).toBe("incompatible");
		expect(dshOnly.blockers).toEqual([{ kind: "dsh_only" }]);

		const themeOnly = evaluatePackageCompatibility(
			{ pi: { themes: ["./theme.json"] } },
			runtime,
		);
		expect(themeOnly.status).toBe("partial");
		expect(themeOnly.caveats).toEqual([{ kind: "themes_ignored" }]);
	});

	it("inspects and caches package manifests safely", async () => {
		const runtime = { piCodingAgent: "1.5.2", piAi: "1.5.2", piAgentCore: "1.5.2", node: "24.12.0" };
		const fetcher = vi.fn(async () =>
			new Response(
				JSON.stringify({
					name: "pi-sample",
					pi: { extensions: ["./index.ts"], skills: ["./skills"] },
					engines: { node: ">=20" },
				}),
				{ status: 200 },
			),
		) as unknown as typeof fetch;

		const first = await inspectMarketplacePackages([{ name: "pi-sample", version: "1.0.0" }], { runtime, fetcher });
		const second = await inspectMarketplacePackages([{ name: "pi-sample", version: "1.0.0" }], { runtime, fetcher });
		expect(fetcher).toHaveBeenCalledTimes(1);
		expect(first["pi-sample"]).toMatchObject({ status: "compatible" });
		expect(second["pi-sample"]).toMatchObject({ status: "compatible" });
	});
});
