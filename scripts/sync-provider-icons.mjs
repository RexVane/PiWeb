import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "node_modules", "@lobehub", "icons-static-svg", "icons");
const target = path.join(root, "public", "provider-icons");
const slugs = [
	"antgroup-color",
	"anthropic",
	"azure-color",
	"baseten",
	"bedrock-color",
	"cerebras-color",
	"cloudflare-color",
	"deepseek-color",
	"fireworks-color",
	"githubcopilot",
	"google-color",
	"googlecloud-color",
	"groq",
	"huggingface-color",
	"kimi-color",
	"minimax-color",
	"mistral-color",
	"moonshot",
	"nvidia-color",
	"openai",
	"opencode",
	"openrouter-color",
	"qwen-color",
	"together-color",
	"vercel",
	"xai",
	"xiaomimimo",
	"zai",
];

await mkdir(target, { recursive: true });
await Promise.all(slugs.map((slug) => copyFile(path.join(source, `${slug}.svg`), path.join(target, `${slug}.svg`))));
console.log(`Synced ${slugs.length} provider icons.`);
