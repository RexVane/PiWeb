/**
 * 量出输入框（input / textarea）里光标的像素位置，相对输入框的 padding box 左上角，未扣滚动。
 *
 * 浏览器不提供这个坐标，这里用一个不可见的镜像 div 复刻输入框的排版：
 * 把光标前的文字放进镜像，再跟一个 span，span 的位置就是光标的位置。
 * 本文件不依赖 React 和其他模块，可以直接放进浏览器做排版一致性验证。
 */

/** 影响换行与字宽的样式；镜像必须逐项与输入框一致，否则换行点和字宽会错位。 */
const MIRRORED_PROPERTIES = [
	"direction",
	"fontFamily",
	"fontSize",
	"fontStyle",
	"fontVariant",
	"fontWeight",
	"fontStretch",
	"fontKerning",
	"fontFeatureSettings",
	"fontVariationSettings",
	"lineHeight",
	"letterSpacing",
	"wordSpacing",
	"textAlign",
	"textIndent",
	"textTransform",
	"tabSize",
	"paddingTop",
	"paddingRight",
	"paddingBottom",
	"paddingLeft",
] as const;

/** 光标后只需要带上一小段文字：它决定光标所在的词会不会整体换到下一行。 */
const TRAILING_CONTEXT = 256;
const LINE_FEED = String.fromCharCode(10);
const CARRIAGE_RETURN = String.fromCharCode(13);
const ZERO_WIDTH_SPACE = String.fromCharCode(0x200b);

export type CaretField = HTMLInputElement | HTMLTextAreaElement;

export type CaretBox = {
	/** 光标左缘，相对输入框的 padding box，未扣 scrollLeft */
	x: number;
	/** 光标所在行文字区的上缘，相对输入框的 padding box，未扣 scrollTop */
	y: number;
	/** 文字区高度：原生光标也画这么高，比行高矮一圈 */
	height: number;
};

export type CaretMirror = {
	measure: (field: CaretField, index: number) => CaretBox | null;
	destroy: () => void;
};

export function createCaretMirror(doc: Document = document): CaretMirror {
	const mirror = doc.createElement("div");
	mirror.setAttribute("aria-hidden", "true");
	const base = mirror.style;
	base.position = "absolute";
	base.top = "0";
	base.left = "-9999px";
	base.visibility = "hidden";
	base.pointerEvents = "none";
	base.overflow = "hidden";
	base.boxSizing = "border-box";
	base.border = "0";
	base.margin = "0";
	base.height = "auto";
	const before = doc.createTextNode("");
	const marker = doc.createElement("span");
	mirror.append(before, marker);
	const range = doc.createRange();
	let styleKey = "";

	return {
		measure(field, index) {
			const view = doc.defaultView;
			if (!view) return null;
			const singleLine = field.tagName === "INPUT";
			// 密码框显示的是圆点而不是真实字符，镜像量不准
			if (singleLine && (field as HTMLInputElement).type === "password") return null;
			if (!mirror.isConnected) doc.body.appendChild(mirror);
			const computed = view.getComputedStyle(field);
			// clientWidth 已扣掉滚动条；镜像没有边框，于是两边的内容区宽度一致
			const width = field.clientWidth;
			const key = `${singleLine}|${width}|${MIRRORED_PROPERTIES.map((property) => computed[property]).join("|")}`;
			if (key !== styleKey) {
				styleKey = key;
				for (const property of MIRRORED_PROPERTIES) base[property] = computed[property];
				base.width = `${width}px`;
				// 单行输入框不换行，文字超宽时横向滚动
				base.whiteSpace = singleLine ? "pre" : "pre-wrap";
				base.overflowWrap = singleLine ? "normal" : "break-word";
			}
			const value = field.value;
			const at = Math.max(0, Math.min(index, value.length));
			before.data = value.slice(0, at);
			const origin = mirror.getBoundingClientRect();
			const paddingTop = Number.parseFloat(computed.paddingTop) || 0;
			const paddingBottom = Number.parseFloat(computed.paddingBottom) || 0;
			// 单行输入框里文字在内容区垂直居中，和行高无关；多行则按镜像里的实际行位置
			const place = (left: number, top: number, height: number): CaretBox => ({
				x: left - origin.left,
				y: singleLine ? paddingTop + (field.clientHeight - paddingTop - paddingBottom - height) / 2 : top - origin.top,
				height,
			});
			const rest = value.slice(at, at + TRAILING_CONTEXT);
			const atLineEnd = !rest || rest[0] === LINE_FEED || rest[0] === CARRIAGE_RETURN;
			const previous = at > 0 ? value[at - 1] : LINE_FEED;
			if (atLineEnd && previous !== LINE_FEED && previous !== CARRIAGE_RETURN && typeof range.getClientRects === "function") {
				// 光标贴在本行最后一个字符后面：量那个字符的右缘。不能在后面放占位符——
				// 行尾空格会「悬挂」在排满的行末，占位符却会被挤到下一行。
				marker.textContent = "";
				range.setStart(before, at - 1);
				range.setEnd(before, at);
				const rects = range.getClientRects();
				const last = rects[rects.length - 1];
				if (last) {
					// 多行里悬挂的空格画在内容区之外，光标停在内容区右缘；单行会横向滚动，不用夹
					const contentRight = origin.left + width - (Number.parseFloat(computed.paddingRight) || 0);
					return place(singleLine ? last.right : Math.min(last.right, contentRight), last.top, last.height);
				}
			}
			// 空行或文首没有前一个字符可量，用零宽空格撑出一个不占宽度的行内框；
			// 其余情况放入后续文字，span 跨行时每行一个矩形，第一个就是光标所在的位置
			marker.textContent = atLineEnd ? ZERO_WIDTH_SPACE : rest;
			const first = marker.getClientRects()[0];
			if (!first) return null;
			return place(first.left, first.top, first.height);
		},
		destroy() {
			mirror.remove();
		},
	};
}
