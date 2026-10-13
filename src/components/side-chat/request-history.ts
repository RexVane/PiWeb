import { SIDE_CHAT_BODY_LIMIT, SIDE_CHAT_HISTORY_LIMIT, SIDE_CHAT_TEXT_LIMIT, type SideChatHistoryMessage } from "@/lib/side-chat/types";

/** Bound only the transmitted context; the browser retains the original transcript. */
export function requestHistory(messages: SideChatHistoryMessage[]): { history: SideChatHistoryMessage[]; truncated: boolean } {
 const encoder = new TextEncoder();
 const history: SideChatHistoryMessage[] = [];
 // Reserve the other half for the question (including JSON escapes), model and envelope.
 let remaining = Math.floor(SIDE_CHAT_BODY_LIMIT / 2) - 2;
 let truncated = false;
 for (let i = messages.length - 1; i >= 0; i--) {
  if (history.length === SIDE_CHAT_HISTORY_LIMIT) { truncated = true; break; }
  const message = messages[i];
  let text = message.text;
  if (text.length > SIDE_CHAT_TEXT_LIMIT) {
   text = text.slice(-SIDE_CHAT_TEXT_LIMIT);
   if (/^[\uDC00-\uDFFF]/.test(text)) text = text.slice(1);
   truncated = true;
  }
  const entry = { role: message.role, text };
  const size = encoder.encode(JSON.stringify(entry)).byteLength + 1;
  if (size > remaining) { truncated = true; break; }
  remaining -= size;
  history.push(entry);
 }
 history.reverse();
 // A retained transcript must begin with a question, not an orphaned answer.
 while (history[0]?.role === "assistant") { history.shift(); truncated = true; }
 return { history, truncated };
}
