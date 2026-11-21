/* Public browser client v1. Copy/bundle into the resource's own web directory. No PiWeb source dependency. */
(() => {
  const channel = "piweb-resource/v1";
  let token, context;
  let language = "en", sequence = 0, lastHeight = 0;
  let sizeElement, sizeObserver, sizeMutation, sizeEpoch = 0;
  const listeners = new Set(), pending = new Map(), themeNames = new Set();
  const send = (message) => { if (token) parent.postMessage({ channel, token, ...message }, "*"); };
  const call = (type, name, args) => {
    if (!token) return Promise.reject(new Error("PiWeb resource host is not connected"));
    if (context?.preview) return Promise.reject(new Error("Passive preview cannot execute host actions"));
    if (type === "host" && !context?.capabilities?.includes(name)) return Promise.reject(new Error("Resource capability is unavailable or not declared"));
    try { if (JSON.stringify(args).length > 120 * 1024) throw new Error("Resource arguments are too large"); }
    catch (error) { return Promise.reject(error); }
    const id = `r${++sequence}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("Resource action timed out")); }, type === "host" && name === "views.open" ? 30 * 60_000 : 30000);
      pending.set(id, { resolve, reject, timer }); send({ type, id, name, args });
    });
  };
  const resize = (height) => {
    const rounded = Math.ceil(Number(height));
    if (!token || !Number.isFinite(rounded) || rounded <= 0 || rounded === lastHeight) return;
    lastHeight = rounded; send({ type: "resize", height: rounded });
  };
  // Measure a content element, never the document viewport, so shorter content can shrink the frame.
  const syncHeight = () => {
    if (!sizeElement?.isConnected) return;
    const bounds = sizeElement.getBoundingClientRect();
    const style = getComputedStyle(sizeElement);
    const margins = (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
    resize(Math.max(bounds.height, sizeElement.offsetHeight || 0) + margins);
  };
  const observeSize = (element) => {
    if (!element || element.ownerDocument !== document || typeof element.getBoundingClientRect !== "function") return () => {};
    sizeObserver?.disconnect(); sizeMutation?.disconnect();
    sizeElement = element;
    const epoch = ++sizeEpoch;
    sizeObserver = typeof ResizeObserver === "function" ? new ResizeObserver(syncHeight) : undefined;
    sizeObserver?.observe(element);
    sizeMutation = !sizeObserver && typeof MutationObserver === "function" ? new MutationObserver(syncHeight) : undefined;
    sizeMutation?.observe(element, { childList: true, subtree: true, characterData: true, attributes: true });
    syncHeight();
    return () => {
      if (epoch !== sizeEpoch) return;
      sizeObserver?.disconnect(); sizeMutation?.disconnect(); sizeElement = undefined;
    };
  };
  const requestFocus = () => {
    if (!token || context?.focusRequestSupported !== true) return Promise.resolve(false);
    const id = `f${++sequence}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve(false); }, 1500);
      pending.set(id, { resolve, reject: () => resolve(false), timer });
      send({ type: "focus", id });
    }).then((value) => value === true);
  };
  const client = {
    apiVersion: 1,
    get context() { return context; },
    get language() { return language; },
    get capabilities() { return context?.capabilities ?? []; },
    get focusRequestSupported() { return context?.focusRequestSupported === true; },
    onContext(listener) { listeners.add(listener); if (context) listener(context); return () => listeners.delete(listener); },
    answer(value) { if (!context?.preview) send({ type: "answer", value }); },
    cancel() { send({ type: "cancel" }); },
    busy(value) { send({ type: "busy", value: value === true }); },
    resize,
    observeSize,
    requestFocus,
    invoke(name, args = null) { return call("invoke", name, args); },
    host(name, args = null) { return call("host", name, args); },
  };
  const ready = () => parent.postMessage({ channel, type: "ready" }, "*");
  const handshake = setInterval(() => { if (!token) ready(); }, 250);
  const receive = (event) => {
    const message = event.data;
    if (event.source !== parent || !message || message.channel !== channel) return;
    if (message.type === "context" && typeof message.token === "string") {
      if (token && token !== message.token) return;
      token = message.token; clearInterval(handshake);
      context = message.context; language = message.language || language; document.documentElement.lang = language;
      const theme = message.theme && typeof message.theme === "object" ? message.theme : {};
      for (const name of themeNames) if (!(name in theme)) { document.documentElement.style.removeProperty(name); themeNames.delete(name); }
      for (const [name, value] of Object.entries(theme)) if (/^--(?:dsw|dsh|pw|isx|ds|font)-[a-z0-9-]+$/i.test(name) && typeof value === "string") {
        document.documentElement.style.setProperty(name, value); themeNames.add(name);
      }
      for (const listener of listeners) listener(context);
      syncHeight();
    } else if (message.type === "result" && message.token === token) {
      const request = pending.get(message.id); if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) request.reject(new Error(message.error)); else request.resolve(message.value);
    }
  };
  window.addEventListener("message", receive);
  if (document.body) observeSize(document.body);
  else document.addEventListener("DOMContentLoaded", () => { if (!sizeElement && document.body) observeSize(document.body); }, { once: true });
  window.addEventListener("resize", syncHeight);
  const escape = (event) => { if (event.key === "Escape" && !event.isComposing && event.keyCode !== 229 && !event.defaultPrevented) client.cancel(); };
  window.addEventListener("keydown", escape);
  window.addEventListener("pagehide", () => {
    clearInterval(handshake); sizeObserver?.disconnect(); sizeMutation?.disconnect(); window.removeEventListener("resize", syncHeight); window.removeEventListener("message", receive); window.removeEventListener("keydown", escape);
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error("Resource frame closed")); }
    pending.clear(); listeners.clear();
  }, { once: true });
  window.piwebResource = client; ready();
})();
