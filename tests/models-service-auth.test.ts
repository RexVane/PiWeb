import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	InMemoryCredentialStore, InMemoryModelsStore,
	type ApiKeyCredential, type OAuthCredential, type ProviderAuthInteraction,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getModelRuntime: vi.fn() }));
vi.mock("../src/lib/pi", () => ({
	getModelRuntime: mocks.getModelRuntime,
	getAgentDir: () => { throw new Error("auth tests must not access user files"); },
	resetModelRuntime: vi.fn(),
}));

import { answerLogin, cancelLogin, loginState, removeApiKey, setApiKey, startLogin } from "../src/lib/models-service";

const providerId = "piweb-offline-auth-test";
let runtime: ModelRuntime;
let credentials: InMemoryCredentialStore;
const oauth = vi.fn<(interaction: ProviderAuthInteraction) => Promise<OAuthCredential>>();
const apiKeyLogin = vi.fn<(interaction: ProviderAuthInteraction) => Promise<ApiKeyCredential>>();

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function token(access: string): OAuthCredential {
	return { type: "oauth", access, refresh: "test-refresh", expires: Date.now() + 3_600_000 };
}

async function microtasks() {
	for (let i = 0; i < 40; i++) await Promise.resolve();
}

beforeEach(async () => {
	vi.stubGlobal("fetch", vi.fn(() => { throw new Error("network is forbidden"); }));
	credentials = new InMemoryCredentialStore();
	runtime = await ModelRuntime.create({
		modelsPath: null, credentials, modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false, refreshOnCreate: false,
	});
	// registerNativeProvider normally refreshes every built-in provider. Only our fake
	// provider participates here; login still exercises the SDK's actual credential queue.
	vi.spyOn(runtime, "refresh").mockResolvedValue({ aborted: false, errors: new Map() });
	oauth.mockReset();
	apiKeyLogin.mockReset().mockImplementation(async (interaction) => ({
		type: "api_key", key: await interaction.prompt({ type: "secret", message: "Key" }),
	}));
	runtime.registerNativeProvider({
		id: providerId, name: "Offline test", getModels: () => [],
		auth: {
			oauth: {
				name: "Offline OAuth", login: oauth,
				refresh: async () => { throw new Error("OAuth refresh is forbidden"); },
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
			apiKey: {
				name: "Offline API key", login: apiKeyLogin,
				check: async ({ credential }) => credential ? { type: "api_key" } : undefined,
				resolve: async ({ credential }) => credential ? { auth: { apiKey: credential.key } } : undefined,
			},
		},
		stream: () => { throw new Error("model calls are forbidden"); },
		streamSimple: () => { throw new Error("model calls are forbidden"); },
	});
	mocks.getModelRuntime.mockReset().mockResolvedValue(runtime);
});

afterEach(async () => {
	cancelLogin(providerId);
	await microtasks();
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe("cancelable SDK authentication", () => {
	it("aborts a device flow and prevents a late credential or callback from reviving it", async () => {
		const completion = deferred<OAuthCredential>();
		oauth.mockImplementation(() => completion.promise); // deliberately ignores abort
		await startLogin(providerId);
		await vi.waitFor(() => expect(oauth).toHaveBeenCalledOnce());
		const interaction = oauth.mock.calls[0][0];
		expect(interaction.signal.aborted).toBe(false);
		expect(cancelLogin(providerId)).toBe(true);
		expect(interaction.signal.aborted).toBe(true);
		expect(loginState(providerId)).toMatchObject({ done: true, error: "canceled", prompt: null });
		interaction.notify({ type: "progress", message: "too late" });
		await expect(interaction.prompt({ type: "text", message: "too late" })).rejects.toThrow("canceled");
		completion.resolve(token("late-token"));
		await microtasks();
		expect(await credentials.read(providerId)).toBeUndefined();
		expect(loginState(providerId)).toMatchObject({ done: true, error: "canceled", prompt: null, notifyLog: [] });
		expect(answerLogin(providerId, "late answer")).toBe(false);
	});

	it("replacing a job releases the provider queue before the previous device flow finishes", async () => {
		const old = deferred<OAuthCredential>();
		const current = deferred<OAuthCredential>();
		oauth.mockImplementationOnce(() => old.promise).mockImplementationOnce(() => current.promise);
		await startLogin(providerId);
		await vi.waitFor(() => expect(oauth).toHaveBeenCalledTimes(1));
		await startLogin(providerId);
		await vi.waitFor(() => expect(oauth).toHaveBeenCalledTimes(2));
		expect(oauth.mock.calls[0][0].signal.aborted).toBe(true);
		expect(oauth.mock.calls[1][0].signal.aborted).toBe(false);
		old.resolve(token("old-token"));
		oauth.mock.calls[0][0].notify({ type: "progress", message: "stale" });
		await microtasks();
		expect(loginState(providerId)).toMatchObject({ done: false, error: undefined, notifyLog: [] });
		current.resolve(token("new-token"));
		await vi.waitFor(() => expect(loginState(providerId).done).toBe(true));
		expect(await credentials.read(providerId)).toMatchObject({ access: "new-token" });
		expect(loginState(providerId).error).toBeUndefined();
	});

	it("API-key login replaces a pending OAuth job without later being overwritten", async () => {
		const old = deferred<OAuthCredential>();
		oauth.mockImplementation(() => old.promise);
		await startLogin(providerId);
		await vi.waitFor(() => expect(oauth).toHaveBeenCalledOnce());
		await setApiKey(providerId, "new-key");
		expect(oauth.mock.calls[0][0].signal.aborted).toBe(true);
		old.resolve(token("old-token"));
		await microtasks();
		expect(await credentials.read(providerId)).toEqual({ type: "api_key", key: "new-key" });
		expect(loginState(providerId)).toMatchObject({ done: true, error: undefined, prompt: null });
	});

	it("answers each prompt once and preserves SDK selection ids during API-key setup", async () => {
		apiKeyLogin.mockImplementation(async (interaction) => {
			const method = await interaction.prompt({ type: "select", message: "Method", options: [{ id: "key", label: "API key" }] });
			const key = await interaction.prompt({ type: "secret", message: "Key" });
			const account = await interaction.prompt({ type: "text", message: "Account" });
			return { type: "api_key", key, env: { METHOD: method, ACCOUNT: account } };
		});
		const result = setApiKey(providerId, "provided-key");
		await vi.waitFor(() => expect(loginState(providerId).prompt?.type).toBe("select"));
		expect(loginState(providerId).prompt?.options).toEqual([{ value: "key", label: "API key" }]);
		expect(answerLogin(providerId, "key")).toBe(true);
		expect(answerLogin(providerId, "duplicate")).toBe(false);
		await vi.waitFor(() => expect(loginState(providerId).prompt?.message).toBe("Account"));
		expect(answerLogin(providerId, "account-id")).toBe(true);
		expect(answerLogin(providerId, "duplicate")).toBe(false);
		await result;
		expect(await credentials.read(providerId)).toEqual({ type: "api_key", key: "provided-key", env: { METHOD: "key", ACCOUNT: "account-id" } });
		expect(answerLogin(providerId, "after completion")).toBe(false);
	});

	it("clears a per-prompt abort without canceling the whole OAuth flow", async () => {
		const completion = deferred<OAuthCredential>();
		oauth.mockImplementation(() => completion.promise);
		await startLogin(providerId);
		await vi.waitFor(() => expect(oauth).toHaveBeenCalledOnce());
		const interaction = oauth.mock.calls[0][0];
		const promptController = new AbortController();
		const prompt = interaction.prompt({ type: "manual_code", message: "Code", signal: promptController.signal });
		const rejected = expect(prompt).rejects.toThrow("callback won");
		promptController.abort(new Error("callback won"));
		await rejected;
		expect(loginState(providerId)).toMatchObject({ done: false, prompt: null });
		expect(answerLogin(providerId, "unused")).toBe(false);
		expect(interaction.signal.aborted).toBe(false);
		completion.resolve(token("callback-token"));
		await vi.waitFor(() => expect(loginState(providerId).done).toBe(true));
		expect(await credentials.read(providerId)).toMatchObject({ access: "callback-token" });
	});

	it("rejects pending prompt resolvers immediately on cancel", async () => {
		oauth.mockImplementation(async (interaction) => token(await interaction.prompt({ type: "manual_code", message: "Code" })));
		await startLogin(providerId);
		await vi.waitFor(() => expect(loginState(providerId).prompt?.type).toBe("manual_code"));
		cancelLogin(providerId);
		expect(loginState(providerId)).toMatchObject({ done: true, error: "canceled", prompt: null });
		expect(answerLogin(providerId, "ignored")).toBe(false);
		await microtasks();
		expect(await credentials.read(providerId)).toBeUndefined();
	});

	it("times out an abandoned login and removes timers and prompt resolvers", async () => {
		vi.useFakeTimers();
		oauth.mockImplementation(async (interaction) => token(await interaction.prompt({ type: "manual_code", message: "Code" })));
		await startLogin(providerId);
		await microtasks();
		expect(loginState(providerId).prompt?.type).toBe("manual_code");
		await vi.advanceTimersByTimeAsync(10 * 60_000);
		expect(oauth.mock.calls[0][0].signal.aborted).toBe(true);
		expect(loginState(providerId)).toMatchObject({ done: true, error: "login timed out", prompt: null });
		expect(answerLogin(providerId, "too late")).toBe(false);
		expect(vi.getTimerCount()).toBe(0);
		expect(await credentials.read(providerId)).toBeUndefined();
	});

	it("cannot start a stale login after runtime initialization finishes late", async () => {
		const initialization = deferred<ModelRuntime>();
		const completion = deferred<OAuthCredential>();
		mocks.getModelRuntime.mockImplementationOnce(() => initialization.promise);
		oauth.mockImplementation(() => completion.promise);
		const first = startLogin(providerId);
		const rejected = expect(first).rejects.toThrow("canceled");
		await startLogin(providerId);
		await vi.waitFor(() => expect(oauth).toHaveBeenCalledOnce());
		initialization.resolve(runtime);
		await rejected;
		expect(oauth).toHaveBeenCalledOnce();
		expect(loginState(providerId)).toMatchObject({ done: false, error: undefined });
		completion.resolve(token("current"));
		await vi.waitFor(() => expect(loginState(providerId).done).toBe(true));
	});

	it("reports runtime initialization failures as terminal states", async () => {
		mocks.getModelRuntime.mockRejectedValueOnce(new Error("runtime unavailable"));
		await expect(startLogin(providerId)).rejects.toThrow("runtime unavailable");
		expect(loginState(providerId)).toMatchObject({ done: true, error: "runtime unavailable", prompt: null });
		expect(oauth).not.toHaveBeenCalled();
	});

	it("logout cancels a pending login instead of waiting for its device code", async () => {
		const completion = deferred<OAuthCredential>();
		oauth.mockImplementation(() => completion.promise);
		await credentials.modify(providerId, async () => token("old"));
		await startLogin(providerId);
		await vi.waitFor(() => expect(oauth).toHaveBeenCalledOnce());
		await removeApiKey(providerId);
		completion.resolve(token("late"));
		await microtasks();
		expect(await credentials.read(providerId)).toBeUndefined();
		expect(loginState(providerId).error).toBe("canceled");
	});
});
