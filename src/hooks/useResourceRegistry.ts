"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { clientFetch } from "@/lib/client-fetch";
import type { ResourcePreferences, ResourceScope, WebResourceView } from "@/lib/resources/protocol";

export const RESOURCE_CHANGE_EVENT = "piweb:resources-changed";
export function notifyResourcesChanged(): void { window.dispatchEvent(new Event(RESOURCE_CHANGE_EVENT)); }
export interface ResourceRegistry {
	packages: Array<{ id: string; name: string; scope: ResourceScope; source: string; enabled: boolean; extensionPaths: string[] }>;
	views: WebResourceView[];
	preferences: ResourcePreferences;
	hosts: Array<{ id: string; scope: string; state: string; services: string[]; active: number }>;
}
const empty = (): ResourceRegistry => ({ packages: [], views: [], preferences: { catalogUrls: [], renderers: {} }, hosts: [] });

/** Catalog/view discovery only; polling must not import host entries or start a session. */
export function useResourceRegistry(cwd: string) {
	const [registry, setRegistry] = useState<ResourceRegistry>(empty);
	const [error, setError] = useState("");
	const sequence = useRef(0);
	const refresh = useCallback(async () => {
		const seq = ++sequence.current;
		if (!cwd) { setRegistry(empty()); return; }
		try {
			const response = await clientFetch(`/api/resources?cwd=${encodeURIComponent(cwd)}`);
			const result = await response.json();
			if (seq !== sequence.current) return;
			if (result.success) { setRegistry({ packages: result.data.packages ?? [], views: result.data.views ?? [], preferences: result.data.preferences ?? empty().preferences, hosts: result.data.hosts ?? [] }); setError(""); }
			else { setRegistry(empty()); setError(result.error || "Resource catalog unavailable"); }
		} catch { if (seq === sequence.current) { setRegistry(empty()); setError("Resource catalog unavailable"); } }
	}, [cwd]);
	useEffect(() => {
		setRegistry(empty()); setError("");
		void refresh();
		window.addEventListener(RESOURCE_CHANGE_EVENT, refresh);
		const timer = setInterval(refresh, 15_000);
		return () => { sequence.current += 1; clearInterval(timer); window.removeEventListener(RESOURCE_CHANGE_EVENT, refresh); };
	}, [refresh]);
	return { ...registry, error, refresh };
}
