import type { SystemProxy } from "./system-proxy.mjs";

export type ProxyEnvMap = Record<string, string | undefined>;
export type ProxySource = "env" | "settings" | "system" | "direct";

export interface ApplyProxyEnvOptions {
	proxySetting?: string | null;
	systemProxy?: SystemProxy | null;
	nodeVersion?: string;
}

export interface AppliedProxyEnv {
	proxy: string | null;
	source: ProxySource | null;
	supported: boolean;
}

export function readEnvValue(env: ProxyEnvMap, name: string): string;
export function setEnvValue(env: ProxyEnvMap, name: string, value: string): void;
export function deleteEnvValue(env: ProxyEnvMap, name: string): void;
export function nodeSupportsEnvProxy(version?: string): boolean;
export function applyProxyEnv(childEnv: ProxyEnvMap, options?: ApplyProxyEnvOptions): AppliedProxyEnv;
