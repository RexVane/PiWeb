type ActivityKind = "session" | "swarm" | "tests";
interface Registry { active: Map<symbol, ActivityKind>; maintenance: boolean }

// Route bundles must share a process-wide gate, not separate module-local registries.
const globals = globalThis as typeof globalThis & { __piwebRuntimeActivity?: Registry };
const registry = globals.__piwebRuntimeActivity ??= { active: new Map(), maintenance: false };

export class RuntimeBusyError extends Error {}

export function beginActivity(kind: ActivityKind): () => void {
  if (registry.maintenance) throw new RuntimeBusyError("update maintenance is active; wait for the release to finish");
  const token = Symbol(kind);
  registry.active.set(token, kind);
  return () => { registry.active.delete(token); };
}

export function beginMaintenance(): () => void {
  if (registry.maintenance || registry.active.size) {
    throw new RuntimeBusyError("work is active; wait for sessions, swarms and tests to finish before entering the maintenance window");
  }
  registry.maintenance = true;
  let released = false;
  return () => {
    if (!released) registry.maintenance = false;
    released = true;
  };
}
