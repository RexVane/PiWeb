import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const T = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-keys-"));
const authPath = path.join(T, "auth.json");
const rt = await ModelRuntime.create({ modelsPath: null, authPath, refreshOnCreate: false });

const LEVEL_ORDER = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const seen = new Map(); // key -> [provider, model][]
const unmatched = new Map();

for (const p of rt.getProviders()) {
	for (const mm of rt.getModels(p.id)) {
		const map = mm.thinkingLevelMap ?? {};
		for (const k of Object.keys(map)) {
			(seen.get(k) ?? seen.set(k, []).get(k)).push(`${p.id}/${mm.id}`);
			if (!LEVEL_ORDER.has(k)) (unmatched.get(k) ?? unmatched.set(k, []).get(k)).push(`${p.id}/${mm.id}`);
		}
	}
}

console.log("全部目录出现过的档位键:", [...seen.keys()].join(", "));
console.log("\n不在 LEVEL_ORDER 白名单的键:", [...unmatched.keys()].join(", ") || "(无)");
for (const [k, list] of unmatched) console.log(`  [${k}] → ${list.slice(0, 6).join(", ")}${list.length > 6 ? ` …(+${list.length - 6})` : ""}`);

await fs.rm(T, { recursive: true, force: true });