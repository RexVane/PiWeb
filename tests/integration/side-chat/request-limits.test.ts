import { describe, expect, it, vi } from "vitest";
import { SideChatStore, type SideChatMessage } from "@/components/side-chat/store";
import { parseSideChatRequest } from "@/lib/side-chat/context";
import { SIDE_CHAT_BODY_LIMIT } from "@/lib/side-chat/types";

function restore(messages: SideChatMessage[]) {
 const data = new Map<string, string>();
 data.set("piweb.sidechat.v1.session-test", JSON.stringify({ currentThreadId: "thread-test", threads: [{ id: "thread-test", title: "History", draft: "Continue", messages }] }));
 const storage: Storage = { get length() { return data.size; }, clear: () => data.clear(), key: (index) => [...data.keys()][index] ?? null, removeItem: (key) => { data.delete(key); }, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
 let sequence = 0;
 const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
  const body = JSON.parse(String(init?.body));
  return new Response(JSON.stringify({ success: true, data: { requestId: body.requestId, revision: 1, text: "Answer", done: true, aborted: false, contextTruncated: false } }));
 });
 const store = new SideChatStore({ storage: () => storage, fetch: fetcher, id: () => "request-" + ++sequence });
 return { store, fetcher, data };
}
function history(count: number, text = "Previous message"): SideChatMessage[] {
 return Array.from({ length: count }, (_, i) => ({ id: "message-" + i, role: i % 2 ? "assistant" : "user", text, status: "done" }));
}
describe("side-chat request limits", () => {
 it.each([
  ["more than 500 exchanges", history(1002)],
  ["UTF-8 request larger than 2 MiB", history(24, "汉".repeat(90000))],
  ["oversized model answer", [...history(2), { id: "message-extra", role: "assistant", text: "a".repeat(120000), status: "done" } as SideChatMessage]],
 ])("keeps complete browser history while sending valid recent context: %s", async (_name, messages) => {
  const { store, fetcher, data } = restore(messages as SideChatMessage[]);
  store.send("session-test");
  const body = String(fetcher.mock.calls[0][1]?.body);
  expect(Buffer.byteLength(body)).toBeLessThanOrEqual(SIDE_CHAT_BODY_LIMIT);
  expect(() => parseSideChatRequest(JSON.parse(body))).not.toThrow();
  const sent = JSON.parse(body);
  expect(sent.history[0]?.role ?? "user").toBe("user");
  await vi.waitFor(() => expect(store.get("session-test").threads[0].request).toBeUndefined());
  const thread = store.get("session-test").threads[0];
  expect(thread.messages.slice(0, messages.length)).toEqual(messages);
  expect(thread.messages.at(-1)?.contextTruncated).toBe(true);
  expect(JSON.parse(data.get("piweb.sidechat.v1.session-test")!).threads[0].messages).toHaveLength(messages.length + 2);
 });
});
