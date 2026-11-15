import { describe, expect, it } from "vitest";
import {
	classifyWebTool,
	displayDomainOf,
	extractWebQuery,
	extractWebSources,
	isPublicFaviconHost,
	mergeWebSources,
	normalizeWebUrl,
	topWebDomains,
} from "../src/lib/web-search";

describe("classifyWebTool", () => {
	it("identifies web search tools across built-in, extension, and MCP names", () => {
		expect(classifyWebTool("web_search", { query: "piweb" })).toBe("search");
		expect(classifyWebTool("WebSearch", { query: "piweb" })).toBe("search");
		expect(classifyWebTool("mcp__tavily__tavily-search", { query: "piweb" })).toBe("search");
		expect(classifyWebTool("mcp__exa__web_search_exa", { query: "piweb" })).toBe("search");
		expect(classifyWebTool("brave_web_search", { query: "piweb" })).toBe("search");
		expect(classifyWebTool("perplexity_ask", { query: "piweb" })).toBe("search");
		expect(classifyWebTool("duckduckgo_search", { q: "piweb" })).toBe("search");
		expect(classifyWebTool("mcp__custom__search", { query: "piweb" })).toBe("search");
	});

	it("identifies web fetch and crawl tools separately from search", () => {
		expect(classifyWebTool("web_fetch", { url: "https://github.com/a/b" })).toBe("fetch");
		expect(classifyWebTool("fetch", { url: "https://github.com/a/b" })).toBe("fetch");
		expect(classifyWebTool("mcp__fetch__fetch", { url: "https://github.com/a/b" })).toBe("fetch");
		expect(classifyWebTool("mcp__tavily__tavily_extract", { urls: ["https://github.com/a/b"] })).toBe("fetch");
		expect(classifyWebTool("firecrawl_scrape", { url: "https://github.com/a/b" })).toBe("fetch");
		expect(classifyWebTool("crawling_exa", { url: "https://github.com/a/b" })).toBe("fetch");
		expect(classifyWebTool("read_url", { url: "https://github.com/a/b" })).toBe("fetch");
	});

	it("does not misclassify local file/code/tool searches or shell commands", () => {
		expect(classifyWebTool("grep", { pattern: "foo" })).toBeNull();
		expect(classifyWebTool("glob", { pattern: "*.ts" })).toBeNull();
		expect(classifyWebTool("find", { pattern: "ChatWindow" })).toBeNull();
		expect(classifyWebTool("ls", { path: "src" })).toBeNull();
		expect(classifyWebTool("read", { path: "README.md" })).toBeNull();
		expect(classifyWebTool("bash", { command: "curl https://example.com" })).toBeNull();
		expect(classifyWebTool("tool_search", { query: "tavily" })).toBeNull();
		expect(classifyWebTool("mcp__filesystem__search_files", { query: "*.tsx" })).toBeNull();
		expect(classifyWebTool("code_search", { query: "ChatWindow" })).toBeNull();
	});

	it("falls back by argument shape for unknown custom web tools", () => {
		expect(classifyWebTool("custom_reader", { url: "https://example.com/docs" })).toBe("fetch");
		expect(classifyWebTool("custom_lookup", { query: "piweb" }, "See https://github.com/a/piweb")).toBe("search");
		expect(classifyWebTool("custom_lookup", { query: "piweb" }, "local file match src/a.ts")).toBeNull();
	});
});

describe("URL safety and normalization", () => {
	it("rejects unsafe schemes, localhost, and schema URLs", () => {
		expect(normalizeWebUrl("javascript:alert(1)")).toBeNull();
		expect(normalizeWebUrl("data:text/html,<script>1</script>")).toBeNull();
		expect(normalizeWebUrl("file:///C:/Users/test.txt")).toBeNull();
		expect(normalizeWebUrl("http://localhost:3000/chat")).toBeNull();
		expect(normalizeWebUrl("http://127.0.0.1:8080/api")).toBeNull();
		expect(normalizeWebUrl("http://www.w3.org/2000/svg")).toBeNull();
	});

	it("preserves balanced parens and normalizes trailing root slashes", () => {
		expect(normalizeWebUrl("https://en.wikipedia.org/wiki/Foo_(bar)).")).toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
		expect(normalizeWebUrl("https://www.github.com/")).toBe("https://www.github.com");
		expect(displayDomainOf("https://www.GitHub.com/owner/repo")).toBe("github.com");
	});

	it("restricts favicon probing to public domain names", () => {
		expect(isPublicFaviconHost("github.com")).toBe(true);
		expect(isPublicFaviconHost("docs.rs")).toBe(true);
		expect(isPublicFaviconHost("192.168.1.10")).toBe(false);
		expect(isPublicFaviconHost("10.0.0.5")).toBe(false);
		expect(isPublicFaviconHost("172.20.0.1")).toBe(false);
		expect(isPublicFaviconHost("wiki.local")).toBe(false);
		expect(isPublicFaviconHost("intranet")).toBe(false);
	});
});

describe("extractWebQuery & extractWebSources", () => {
	it("extracts search queries and fetch targets cleanly", () => {
		expect(extractWebQuery("web_search", { query: "  piweb   GitHub  " }, "search")).toBe("piweb GitHub");
		expect(extractWebQuery("tavily_search", { queries: ["piweb", "ai portal"] }, "search")).toBe("piweb, ai portal");
		expect(extractWebQuery("web_fetch", { url: "https://github.com/owner/repo/" }, "fetch")).toBe("https://github.com/owner/repo/");
		expect(extractWebQuery("web_fetch", { url: "javascript:alert(1)" }, "fetch")).toBe("");
	});

	it("parses structured JSON results with titles and deduplicates root URLs", () => {
		const payload = JSON.stringify({
			results: [
				{ title: "PiWeb Repo", url: "https://github.com/owner/piweb" },
				{ title: "Duplicate Trailing Slash", url: "https://docs.example.com/" },
				{ title: "Homepage", url: "https://docs.example.com" },
			],
		});
		const sources = extractWebSources({}, payload, "search");
		expect(sources).toHaveLength(2);
		expect(sources[0]).toMatchObject({ url: "https://github.com/owner/piweb", domain: "github.com", title: "PiWeb Repo" });
		expect(sources[1]).toMatchObject({ url: "https://docs.example.com", domain: "docs.example.com", title: "Duplicate Trailing Slash" });
	});

	it("recovers titles and URLs from tail-truncated JSON output", () => {
		// 模拟服务端 coercePartial .slice(-4000) 截断开头 { 与 "results": [ 后的片段
		const truncatedTail = `...truncated snippet"}, {"title": "Exa Search Docs", "url": "https:\\/\\/docs.exa.ai\\/reference"}, {"url": "https://github.com/earendil-works/pi", "title": "Pi Agent"}]}`;
		const sources = extractWebSources({}, truncatedTail, "search");
		expect(sources).toEqual([
			expect.objectContaining({ url: "https://docs.exa.ai/reference", domain: "docs.exa.ai", title: "Exa Search Docs" }),
			expect.objectContaining({ url: "https://github.com/earendil-works/pi", domain: "github.com", title: "Pi Agent" }),
		]);
	});

	it("parses Markdown links and Title/URL blocks while ignoring markdown images", () => {
		const md = [
			"![logo](https://cdn.example.com/logo.png)",
			"- [PiWeb Overview](https://piweb.dev/docs)",
			"Title: Brave API",
			"URL: https://brave.com/search/api/",
		].join("\n");
		const sources = extractWebSources({}, md, "search");
		expect(sources.map((s) => ({ url: s.url, title: s.title }))).toEqual([
			{ url: "https://piweb.dev/docs", title: "PiWeb Overview" },
			{ url: "https://brave.com/search/api/", title: "Brave API" },
		]);
	});

	it("retains fetched target URL from args even when output contains plain text only", () => {
		const sources = extractWebSources({ url: "https://github.com/owner/piweb" }, "Plain text README without links", "fetch");
		expect(sources).toEqual([{ url: "https://github.com/owner/piweb", domain: "github.com", title: undefined, snippet: undefined }]);
	});

	it("merges multiple batches without double counting and ranks frequent domains first", () => {
		const b1 = extractWebSources({}, JSON.stringify([{ url: "https://github.com/a" }, { url: "https://exa.ai/1" }]), "search");
		const b2 = extractWebSources({}, JSON.stringify([{ url: "https://github.com/a" }, { url: "https://github.com/b" }, { url: "https://brave.com/search" }]), "search");
		const merged = mergeWebSources([b1, b2]);
		expect(merged).toHaveLength(4);
		expect(topWebDomains(merged, 3)).toEqual(["github.com", "exa.ai", "brave.com"]);
	});
});
