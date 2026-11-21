import fs from "node:fs/promises";
import path from "node:path";

export const verificationProvider = "piweb-verification";
export const verificationModel = "fixture";

/** Call only for a new, generated fixture directory. No account configuration is read. */
export async function createVerificationProviderFixture(root: string, hostSourceRoot: string) {
	const agentDir = path.join(root, "agent");
	const extensionPath = path.join(root, "verification-provider.mjs");
	const workspaces = [path.join(root, "workspace-a"), path.join(root, "workspace-b")];
	await fs.mkdir(agentDir, { recursive: true });
	for (const workspace of workspaces) await fs.mkdir(workspace);
	await fs.writeFile(extensionPath, await fs.readFile(new URL("./verification-provider.mjs", import.meta.url)), { flag: "wx" });
	const settings = {
		defaultProjectTrust: "always", defaultProvider: verificationProvider, defaultModel: verificationModel,
		compaction: { enabled: false }, extensions: [extensionPath],
	};
	const providers = {
		[verificationProvider]: {
			api: verificationProvider, baseUrl: "https://piweb-verification.invalid", apiKey: "piweb-verification-dummy-key",
			models: [{ id: verificationModel, name: "PiWeb verification fixture", reasoning: false, input: ["text"], contextWindow: 65_536, maxTokens: 4_096,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		},
	};
	await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify(settings, null, 2), { flag: "wx" });
	await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers }, null, 2), { flag: "wx" });
	return { root, agentDir, extensionPath, workspaces, settings, env: { PI_CODING_AGENT_DIR: agentDir, PIWEB_TEST_HOST_ROOT: path.resolve(hostSourceRoot), PI_OFFLINE: "1" } };
}
