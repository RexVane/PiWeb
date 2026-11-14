import path from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { InMemoryModelsStore, type ModelsStoreEntry } from "@earendil-works/pi-ai";
import { readJsonObjectSafe } from "./agent-config";
import { reloadStoredCredentials } from "./model-files";
import { createPiWebModelRuntime } from "./model-runtime-safe";

// The persistent configuration/credentials are shared; extension registrations and
// remote catalog writes belong to the session that owns them.
const active = new Map<ModelRuntime, { store: InMemoryModelsStore; virtual: Map<string, { provider: string; id: string }> }>();

async function seedCatalog(store: InMemoryModelsStore, baseline: ModelRuntime, exclude: ReadonlySet<string> = new Set()): Promise<void> {
	// Copy the persisted overlay, including its freshness metadata. Copying the
	// composed catalog would retain removed models.json overrides, while dropping
	// lastModified makes the SDK discard remote models as older than its builtins.
	const saved = await readJsonObjectSafe(path.join(getAgentDir(), "models-store.json"));
	for (const provider of baseline.getProviders()) {
		if (exclude.has(provider.id)) continue;
		const entry = saved?.[provider.id];
		if (entry && typeof entry === "object" && "models" in entry && Array.isArray(entry.models)) {
			await store.write(provider.id, entry as unknown as ModelsStoreEntry);
		} else {
			await store.delete(provider.id);
		}
	}
}

export async function createSessionModelRuntime(baseline: ModelRuntime): Promise<ModelRuntime> {
	const store = new InMemoryModelsStore();
	await seedCatalog(store, baseline);
	const runtime = await createPiWebModelRuntime({ modelsStore: store, allowModelNetwork: false });
	const virtual = new Map<string, { provider: string; id: string }>();
	const registerVirtual = runtime.registerVirtualModel.bind(runtime);
	const unregisterVirtual = runtime.unregisterVirtualModel.bind(runtime);
	runtime.registerVirtualModel = (definition) => {
		registerVirtual(definition);
		virtual.set(JSON.stringify([definition.provider, definition.id]), { provider: definition.provider, id: definition.id });
	};
	runtime.unregisterVirtualModel = (provider, id) => {
		unregisterVirtual(provider, id);
		virtual.delete(JSON.stringify([provider, id]));
	};
	active.set(runtime, { store, virtual });
	return runtime;
}

/** Called after old extension shutdown and resource discovery, before new bindings. */
export async function clearSessionModelProviders(runtime: ModelRuntime): Promise<void> {
	const owned = active.get(runtime);
	for (const { provider, id } of owned?.virtual.values() ?? []) runtime.unregisterVirtualModel(provider, id);
	for (const provider of runtime.getRegisteredProviderIds()) {
		runtime.unregisterProvider(provider);
		await owned?.store.delete(provider);
	}
	if (owned) await seedCatalog(owned.store, runtime);
	await runtime.refresh({ allowNetwork: false });
}

/** Refresh configuration in place so active requests and extension providers retain their own runtime. */
export async function refreshSessionModelRuntimes(baseline: ModelRuntime): Promise<void> {
	await Promise.all([...active].map(async ([runtime, { store }]) => {
		await seedCatalog(store, baseline, new Set(runtime.getRegisteredProviderIds()));
		reloadStoredCredentials(runtime);
		await runtime.refresh({ allowNetwork: false });
	}));
}

export async function releaseSessionModelRuntime(runtime: ModelRuntime): Promise<void> {
	if (!active.delete(runtime)) return;
	await runtime.settleCredentialWrites();
}
