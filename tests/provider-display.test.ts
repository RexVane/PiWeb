import { access } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	CUSTOM_PROVIDER_ID_PATTERN,
	PROVIDER_ICON_SLUGS,
	customApiOptions,
	providerIconSlug,
	providerInitials,
} from "../src/lib/provider-display";

describe("provider display metadata", () => {
	it("maps Pi provider variants to their shared brand icon", () => {
		expect(providerIconSlug("openai-codex")).toBe("openai");
		expect(providerIconSlug("google-vertex-ai")).toBe("googlecloud-color");
		expect(providerIconSlug("google-vertex")).toBe("googlecloud-color");
		expect(providerIconSlug("moonshotai-cn")).toBe("moonshot");
		expect(providerIconSlug("opencode")).toBe("opencode");
		expect(providerIconSlug("xiaomi")).toBe("xiaomimimo");
		expect(providerIconSlug("zai")).toBe("zai");
		expect(providerIconSlug("qwen-token-plan-cn")).toBe("qwen-color");
		expect(providerIconSlug("unknown-future-provider")).toBeNull();
	});

	it("provides a deterministic fallback for future providers", () => {
		expect(providerInitials("Future Provider", "future-provider")).toBe("FP");
		expect(providerInitials("Radius", "radius")).toBe("RA");
	});

	it("validates custom provider ids and merges newly discovered API protocols", () => {
		expect(CUSTOM_PROVIDER_ID_PATTERN.test("acme-gateway")).toBe(true);
		expect(CUSTOM_PROVIDER_ID_PATTERN.test("Acme Gateway")).toBe(false);
		expect(customApiOptions(["bedrock-converse-stream", "openai-responses"])).toContain("bedrock-converse-stream");
		expect(customApiOptions(["bedrock-converse-stream"]).slice(0, 3)).toEqual([
			"openai-completions",
			"openai-responses",
			"anthropic-messages",
		]);
	});

	it("ships every mapped icon as a local static asset", async () => {
		await Promise.all(PROVIDER_ICON_SLUGS.map((slug) => access(path.join(process.cwd(), "public", "provider-icons", `${slug}.svg`))));
	});
});
