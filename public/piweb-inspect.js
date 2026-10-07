/*!
 * PiWeb 开发者模式接入脚本（dev-only）。
 * 用户项目页面通过 <script src="http://127.0.0.1:30141/piweb-inspect.js"></script> 引入。
 * 只在自己被 iframe 嵌入、且父页面是脚本来源的 PiWeb 实例时工作；
 * 收到 PiWeb 的 activate 后高亮悬停元素，点击把元素信息 postMessage 回 PiWeb。不读写任何 cookie/存储。
 */
(function () {
	"use strict";
	if (window.top === window) return; // 直接打开页面时保持惰性
	var scriptEl = document.currentScript;
	if (!scriptEl || !scriptEl.src) return;
	var piwebOrigin;
	try {
		piwebOrigin = new URL(scriptEl.src).origin;
	} catch (e) {
		return;
	}
	if (!piwebOrigin) return;

	var PROTOCOL = "piweb-inspect";
	var SOURCE_ATTR_KEYS = ["data-source", "data-insp-path", "data-source-loc", "data-source-location", "data-loc"];
	var active = false;
	var overlay = null;
	var current = null;

	function send(type, payload) {
		try {
			window.parent.postMessage(Object.assign({ source: PROTOCOL, type: type }, payload || {}), piwebOrigin);
		} catch (e) { /* parent unreachable */ }
	}

	function ensureOverlay() {
		if (overlay) return overlay;
		var el = document.createElement("div");
		el.setAttribute("data-piweb-overlay", "");
		el.style.cssText = "all:initial;position:fixed;pointer-events:none;z-index:2147483647;" +
			"outline:2px solid #3b82f6;background:rgba(59,130,246,.10);border-radius:2px;display:none;";
		document.documentElement.appendChild(el);
		overlay = el;
		return el;
	}

	function highlight(el) {
		if (!el || !el.getBoundingClientRect) return;
		var r = el.getBoundingClientRect();
		var o = ensureOverlay();
		o.style.display = "block";
		o.style.top = r.top + "px";
		o.style.left = r.left + "px";
		o.style.width = r.width + "px";
		o.style.height = r.height + "px";
	}

	function collectAttrs(el) {
		var found = {};
		var node = el;
		for (var depth = 0; node && node.nodeType === 1 && depth < 6; depth += 1) {
			for (var i = 0; i < SOURCE_ATTR_KEYS.length; i += 1) {
				var key = SOURCE_ATTR_KEYS[i];
				if (!found[key] && node.getAttribute) {
					var value = node.getAttribute(key);
					if (value) found[key] = value;
				}
			}
			node = node.parentElement;
		}
		return found;
	}

	function bestText(el) {
		if (!el) return "";
		var direct = [];
		for (var i = 0; i < el.childNodes.length; i += 1) {
			var n = el.childNodes[i];
			if (n.nodeType === 3 && n.nodeValue && n.nodeValue.trim()) direct.push(n.nodeValue.trim());
		}
		var text = direct.join(" ") || el.innerText || el.textContent || "";
		return text.replace(/\s+/g, " ").trim().slice(0, 200);
	}

	function domPath(el) {
		var parts = [];
		var node = el;
		for (var depth = 0; node && node.nodeType === 1 && depth < 6; depth += 1) {
			var seg = node.tagName.toLowerCase();
			if (node.id) { seg += "#" + node.id; parts.unshift(seg); break; }
			if (node.classList && node.classList.length) seg += "." + Array.prototype.slice.call(node.classList, 0, 3).join(".");
			parts.unshift(seg.slice(0, 80));
			node = node.parentElement;
		}
		return parts.join(" > ").slice(0, 300);
	}

	function onMouseOver(e) {
		if (!active) return;
		current = e.target;
		highlight(e.target);
	}

	function onClick(e) {
		if (!active || !e.target) return;
		e.preventDefault();
		e.stopPropagation();
		var el = e.target;
		send("element", {
			payload: {
				text: bestText(el),
				tag: el.tagName ? el.tagName.toLowerCase() : "",
				attrs: collectAttrs(el),
				domPath: domPath(el),
				pageUrl: location.href,
			},
		});
	}

	function onKeyDown(e) {
		if (e.key === "Escape" && active) deactivate(true);
	}

	function activate() {
		if (active) return;
		active = true;
		window.addEventListener("mouseover", onMouseOver, true);
		window.addEventListener("click", onClick, true);
		window.addEventListener("keydown", onKeyDown, true);
	}

	function deactivate(notify) {
		if (!active) return;
		active = false;
		window.removeEventListener("mouseover", onMouseOver, true);
		window.removeEventListener("click", onClick, true);
		window.removeEventListener("keydown", onKeyDown, true);
		if (overlay) overlay.style.display = "none";
		current = null;
		if (notify) send("inspect-deactivated");
	}

	window.addEventListener("message", function (event) {
		if (event.origin !== piwebOrigin) return;
		var data = event.data;
		if (!data || data.source !== "piweb") return;
		if (data.type === "inspect-activate") activate();
		else if (data.type === "inspect-deactivate") deactivate(false);
		else if (data.type === "inspect-ping") send("ready");
	});

	send("ready");
})();
