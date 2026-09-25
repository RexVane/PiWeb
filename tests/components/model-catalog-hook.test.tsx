// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { usePiWeb } from "@/hooks/usePiWeb";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it("reports a failed model catalog request and clears it after retry", async () => {
	let modelRequests = 0;
	const response = (data: unknown) => ({
		ok: true,
		status: 200,
		headers: { get: () => null },
		json: async () => ({ success: true, data }),
	});
	vi.stubGlobal("fetch", vi.fn(async (url: string) => {
		if (url === "/api/models") {
			modelRequests += 1;
			if (modelRequests === 1) throw new Error("model service unavailable");
			return response({ providers: [], models: [] });
		}
		if (url === "/api/workspaces") return response({ workspaces: [], removedWorkspaces: [], aliases: {}, archivedSessions: [] });
		if (url === "/api/sessions") return response({ sessions: [], running: {} });
		throw new Error(`unexpected URL ${url}`);
	}));
	const { result } = renderHook(() => usePiWeb());
	await waitFor(() => expect(result.current.modelLoadError).toBe("model service unavailable"));
	expect(result.current.modelLoading).toBe(false);
	await act(async () => { await result.current.refreshModels(); });
	expect(result.current.modelLoadError).toBeNull();
	expect(result.current.modelLoading).toBe(false);
	expect(result.current.models).toEqual({ providers: [], models: [] });
});
