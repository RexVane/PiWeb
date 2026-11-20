/* Public browser client v1. Copy/bundle into a resource's own web asset directory. No PiWeb source dependency. */
(() => {
  const channel = "piweb-resource/v1";
  let token;
  let context;
  let language = "en";
  let sequence = 0;
  const listeners = new Set();
  const pending = new Map();
  const send = (message) => { if (token) parent.postMessage({ channel, token, ...message }, "*"); };
  const client = {
    get context() { return context; },
    get language() { return language; },
    onContext(listener) { listeners.add(listener); if (context) listener(context); return () => listeners.delete(listener); },
    answer(value) { send({ type: "answer", value }); },
    cancel() { send({ type: "cancel" }); },
    resize(height) { send({ type: "resize", height }); },
    invoke(name, args = null) {
      if (!token) return Promise.reject(new Error("PiWeb resource host is not connected"));
      const id = `r${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error("Resource action timed out")); }, 30000);
        pending.set(id, { resolve, reject, timer });
        send({ type: "invoke", id, name, args });
      });
    },
  };
  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== parent || !message || message.channel !== channel) return;
    if (message.type === "context" && typeof message.token === "string") {
      if (token && token !== message.token) return;
      token = message.token;
      context = message.context;
      language = message.language || language;
      document.documentElement.lang = language;
      if (message.theme) for (const [name, value] of Object.entries(message.theme)) if (/^--dsw-[a-z-]+$/.test(name) && typeof value === "string") document.documentElement.style.setProperty(name, value);
      for (const listener of listeners) listener(context);
      client.resize(document.documentElement.scrollHeight);
    } else if (message.type === "result" && message.token === token) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error)); else request.resolve(message.value);
    }
  });
  window.addEventListener("keydown", (event) => { if (event.key === "Escape" && !event.isComposing) client.cancel(); });
  window.piwebResource = client;
  parent.postMessage({ channel, type: "ready" }, "*");
})();
