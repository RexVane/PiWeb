/** Bounded browser requests; caller cancellation and timeout both cancel the underlying fetch. */
export async function clientFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
	const controller = new AbortController();
	const caller = init.signal ?? (input instanceof Request ? input.signal : undefined);
	const cancel = () => controller.abort(caller?.reason);
	if (caller?.aborted) cancel();
	else caller?.addEventListener("abort", cancel, { once: true });
	const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	const timeoutMs = /\/api\/(plugins|sessions\/import|update|files\/upload)(?:[/?]|$)/.test(url) && init.method && init.method !== "GET" ? 120_000 : 30_000;
	const timer = setTimeout(() => controller.abort(new Error("请求超时，请检查连接后重试。")), timeoutMs);
	const finish = () => { clearTimeout(timer); caller?.removeEventListener("abort", cancel); };
	try {
		const response = await globalThis.fetch(input, { ...init, signal: controller.signal });
		for (const name of ["json", "text", "blob", "arrayBuffer", "formData"] as const) {
			if (typeof response[name] !== "function") continue;
			const consume = response[name].bind(response);
			Object.defineProperty(response, name, { configurable: true, value: async () => { try { return await consume(); } finally { finish(); } } });
		}
		// NDJSON/import progress consumes a reader instead of response.json().
		if (response.body) {
			const body = response.body;
			const acquire = body.getReader.bind(body);
			Object.defineProperty(body, "getReader", { configurable: true, value: (...args: unknown[]) => {
				const reader = (acquire as (...options: unknown[]) => ReadableStreamDefaultReader<Uint8Array>)(...args);
				const read = reader.read.bind(reader);
				const cancelReader = reader.cancel.bind(reader);
				Object.defineProperty(reader, "read", { configurable: true, value: async (...options: unknown[]) => {
					try { const result = await (read as (...args: unknown[]) => Promise<ReadableStreamReadResult<Uint8Array>>)(...options); if (result.done) finish(); return result; }
					catch (error) { finish(); throw error; }
				} });
				Object.defineProperty(reader, "cancel", { configurable: true, value: async (reason?: unknown) => { try { return await cancelReader(reason); } finally { finish(); } } });
				return reader;
			} });
			const cancelBody = body.cancel.bind(body);
			Object.defineProperty(body, "cancel", { configurable: true, value: async (reason?: unknown) => { try { return await cancelBody(reason); } finally { finish(); } } });
		}
		if (response.status === 204 || response.status === 304) finish();
		return response;
	} catch (error) { finish(); throw error; }
}
