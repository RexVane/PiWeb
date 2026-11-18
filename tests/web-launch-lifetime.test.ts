import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { launchIpcProof, validLaunchIpcProof } from "../scripts/web-auth-protocol.mjs";
import { recycleFixture } from "./fixtures/recycle";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeLaunchToken, currentLaunchToken, invalidateLaunchTokens, LAUNCH_TOKEN_TTL_MS, launchTokenFile, launchTokenSocketPath, publishLaunchToken, resetLaunchTokenState } from "@/lib/web-launch-token";
let root = "";
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "piweb-token-life-")); vi.stubEnv("PI_CODING_AGENT_DIR", root); vi.stubEnv("PIWEB_PORT", "30188"); resetLaunchTokenState(); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); resetLaunchTokenState(); await recycleFixture(root); });
function refresh(token: string): Promise<{ token?: string; error?: string }> {
	return new Promise((resolve, reject) => {
		const socket = net.connect(launchTokenSocketPath(30188));
		let reply = "";
		const clientNonce = randomBytes(32).toString("base64url");
		let serverNonce: string | undefined;
		socket.setTimeout(2_000, () => { socket.destroy(); reject(new Error("IPC timed out")); });
		socket.once("connect", () => socket.write(`${JSON.stringify({ clientNonce })}\n`));
		socket.on("data", (data) => {
			reply += data.toString();
			if (!reply.includes("\n")) return;
			const value = JSON.parse(reply); reply = "";
			if (!serverNonce) {
				serverNonce = value.serverNonce;
				if (!serverNonce || !validLaunchIpcProof(value.proof, token, "server", clientNonce, serverNonce)) { socket.destroy(); resolve({ error: "invalid_token" }); return; }
				socket.write(`${JSON.stringify({ proof: launchIpcProof(token, "client", clientNonce, serverNonce) })}\n`);
			} else if (value.error) resolve(value);
			else if (validLaunchIpcProof(value.proof, token, "ready", clientNonce, serverNonce)) {
				expect(value).not.toHaveProperty("token");
				void fs.readFile(launchTokenFile(30188), "utf8").then((raw) => resolve({ token: raw.trim() }), reject);
			} else reject(new Error("Unauthenticated IPC reply"));
		});
		socket.once("error", reject);
	});
}
describe("launch token lifetime", () => {
	it("does not let an exiting publisher remove a replacement process's private credential", async () => {
		const before = new Set(process.listeners("exit"));
		publishLaunchToken({ PI_WEB_LAUNCH_TOKEN: "initial", PIWEB_PORT: "30188" });
		const file = launchTokenFile(30188);
		await fs.writeFile(file, "replacement-process-token\n");
		const callbacks = process.listeners("exit").filter((listener) => !before.has(listener));
		for (const callback of callbacks) callback(0);
		expect((await fs.readFile(file, "utf8")).trim()).toBe("replacement-process-token");
		expect(callbacks).toHaveLength(0);
	});
	it("consumes an exchange once, writes a fresh local login link, and rejects the copied old token", async () => {
		publishLaunchToken({ PI_WEB_LAUNCH_TOKEN: "initial", PIWEB_PORT: "30188" });
		expect(consumeLaunchToken("initial", "initial")).toBe(true);
		expect(consumeLaunchToken("initial", "initial")).toBe(false);
		const fresh = (await fs.readFile(launchTokenFile(30188), "utf8")).trim();
		expect(fresh).not.toBe("initial"); expect(consumeLaunchToken(fresh, "initial")).toBe(true);
	});
	it("expires old links and all-device logout invalidates the current unconsumed link", () => {
		publishLaunchToken({ PI_WEB_LAUNCH_TOKEN: "initial", PIWEB_PORT: "30188" });
		expect(consumeLaunchToken("initial", "initial", Date.now() + LAUNCH_TOKEN_TTL_MS + 1)).toBe(false);
		const before = currentLaunchToken(); invalidateLaunchTokens(Date.now() + 1);
		expect(currentLaunchToken()).not.toBe(before); expect(consumeLaunchToken(before!, "initial")).toBe(false);
	});
	it("refreshes an expired local-file token immediately over private IPC", async () => {
		publishLaunchToken({ PI_WEB_LAUNCH_TOKEN: "initial", PIWEB_PORT: "30188" });
		await vi.waitFor(async () => expect(await refresh("initial")).toEqual({ token: "initial" }));
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + LAUNCH_TOKEN_TTL_MS + 1);
		const reply = await refresh("initial");
		expect(reply.token).toBeTruthy(); expect(reply.token).not.toBe("initial");
		expect((await fs.readFile(launchTokenFile(30188), "utf8")).trim()).toBe(reply.token);
		expect(consumeLaunchToken(reply.token!, "initial")).toBe(true);
	});
	it("requires the token file credential to use the local refresh channel", async () => {
		publishLaunchToken({ PI_WEB_LAUNCH_TOKEN: "initial", PIWEB_PORT: "30188" });
		await vi.waitFor(async () => expect(await refresh("wrong")).toEqual({ error: "invalid_token" }));
		expect(currentLaunchToken()).toBe("initial");
	});
});
