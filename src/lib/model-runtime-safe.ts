import { AsyncLocalStorage } from "node:async_hooks";
import { ModelRuntime, type CreateModelRuntimeOptions } from "@earendil-works/pi-coding-agent";
import type { AuthOperationOptions, Credential } from "@earendil-works/pi-ai";

/** The SDK template grammar, without its command execution branch. */
function resolveCatalogKey(value: string, env?: Record<string, string>): string | undefined {
	if (value.startsWith("!")) return value;
	let missing = false;
	// Match braced tokens even when invalid, so `${invalid $ENV}` remains literal
	// just as in the SDK instead of interpolating its inner dollar expression.
	const resolved = value.replace(/\$(\$|!|\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)/g, (match: string, token: string) => {
		if (token === "$" || token === "!") return token;
		const name = token.startsWith("{") ? token.slice(1, -1) : token;
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return match;
		const found = env?.[name] || process.env[name];
		if (found === undefined || found === "") missing = true;
		return found ?? "";
	});
	return missing ? undefined : resolved;
}

/**
 * CredentialStore.read is a status operation, but SDK 1.5.2's default store also
 * executes !commands there. Keep its locking/writes and request-time behavior,
 * while making initialization, availability checks and background refresh inert.
 * These two storage members are a deliberately checked SDK compatibility seam;
 * an SDK shape change must fail closed instead of silently restoring execution.
 */
export async function createPiWebModelRuntime(options: Omit<CreateModelRuntimeOptions, "credentials"> = {}): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({ ...options, refreshOnCreate: false });
	const store = (runtime as unknown as { credentials?: { store?: {
		read?: (providerId: string, options?: AuthOperationOptions) => Promise<Credential | undefined>;
		readLatestData?: (options?: AuthOperationOptions) => Promise<Record<string, Credential>>;
	} } }).credentials?.store;
	if (typeof store?.read !== "function" || typeof store.readLatestData !== "function") {
		throw new Error("This pi SDK credential store is unsupported; PiWeb cannot safely open the model catalog.");
	}
	const requests = new AsyncLocalStorage<boolean>();
	const read = store.read.bind(store);
	const readLatestData = store.readLatestData.bind(store);
	store.read = async (providerId, operation) => {
		if (requests.getStore() === true) return read(providerId, operation);
		const credential = (await readLatestData(operation))[providerId];
		operation?.signal?.throwIfAborted();
		if (credential?.type !== "api_key" || credential.key === undefined) return credential;
		return { ...credential, key: resolveCatalogKey(credential.key, credential.env) };
	};
	const getAuth = runtime.getAuth.bind(runtime);
	runtime.getAuth = ((...args: Parameters<ModelRuntime["getAuth"]>) => requests.run(true, () => getAuth(...args))) as ModelRuntime["getAuth"];
	if (options.refreshOnCreate !== false) {
		await runtime.refresh({ allowNetwork: options.allowModelNetwork === true, signal: options.signal });
	}
	return runtime;
}
