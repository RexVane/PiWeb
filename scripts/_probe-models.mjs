import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const T = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-probe-"));
const modelsPath = path.join(T, "models.json");
const authPath = path.join(T, "auth.json");

await fs.writeFile(
	modelsPath,
	JSON.stringify(
		{
			providers: {
				"acme-gateway": {
					name: "Acme Gateway",
					baseUrl: "https://api.example.com/v1",
					api: "openai-completions",
					apiKey: "sk-acme-test",
					models: [
						{ id: "acme-1", name: "Acme 1" },
						{ id: "acme-2" },
					],
				},
				deepseek: { baseUrl: "https://api.example.com/override" },
			},
		},
		null,
		2,
	),
);

const rt = await ModelRuntime.create({ modelsPath, authPath, refreshOnCreate: false });

const providers = rt.getProviders();
console.log("PROVIDERS:", JSON.stringify(providers.map((p) => ({ id: p.id, name: p.name, hasApiKey: Boolean(p.auth?.apiKey), apiKeyName: p.auth?.apiKey?.name, baseUrl: p.baseUrl })), null, 2));

for (const p of providers) {
	const list = rt.getModels(p.id);
	const status = rt.getProviderAuthStatus(p.id);
	const configured = rt.hasConfiguredAuth(p.id);
	console.log(
		`MODELS[${p.id}]:`,
		list.length,
		"->",
		list.map((m) => m.id).join(","),
		"| authStatus:",
		JSON.stringify(status),
		"| hasConfiguredAuth:",
		configured,
	);
}

// also: modelsPath: null —— builtin 探测姿势
const rtNull = await ModelRuntime.create({ modelsPath: null, authPath, refreshOnCreate: false });
console.log("NULL-MODELSPATH PROVIDER COUNT:", rtNull.getProviders().length, "ids:", rtNull.getProviders().map((p) => p.id).join(","));

await fs.rm(T, { recursive: true, force: true });