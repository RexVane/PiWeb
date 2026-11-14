export const OFFICIAL_REGISTRY: string;
export function readHttpProxySetting(env?: Record<string, string | undefined>): string | null;
export const OFFICIAL_REGISTRY_ARGS: readonly string[];
export function isolatedCommandEnv(env?: Record<string, string | undefined>): Record<string, string>;
export function exactRegistryVersion(raw: string): string;
