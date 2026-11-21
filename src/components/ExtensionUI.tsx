"use client";

/**
 * 扩展界面桥的浏览器端：对话框（select / confirm / input）、通知条、页脚状态。
 * 对应 pi RPC 模式的 extension_ui_request；没有页面应答时服务端按超时/取消处理。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { IconShieldOutline16 } from "@/components/icons";
import { SelectOption } from "@/components/settings/SharedControls";
import { useI18n } from "@/i18n";
import { useDialog } from "@/hooks/useDialog";
import type { ExtensionDialog, PiWebNotice } from "@/hooks/usePiWeb";
import type { WebExtensionWidget, WebUiFormField, WebUiNode, WebUiResult } from "@/lib/types";
import type { JsonValue, WebResourceView } from "@/lib/resources/protocol";
import { ResourceFrame } from "./resources/ResourceFrame";
import { useResourceText } from "./resources/text";

const TONE_COLOR: Record<string, string> = {
	default: "var(--dsw-label-primary)",
	muted: "var(--dsw-label-caption)",
	accent: "var(--dsw-accent)",
	success: "var(--dsw-success)",
	warning: "var(--dsw-warn)",
	danger: "var(--dsw-danger)",
};

/**
 * 扩展送来的 JSON UI 树 → 网页组件。
 *
 * 扩展跑在服务端，只能给数据；这里负责把它画成和 PiWeb 一致的界面（不是贴一块终端）。
 * 树已经在服务端过了一遍白名单与长度限制，这里仍然只按类型渲染，不注入 HTML。
 */
function WebUiForm({ fields, submitLabel, onAction }: { fields: WebUiFormField[]; submitLabel?: string; onAction: (result: WebUiResult) => void }) {
	const { t } = useI18n();
	const [values, setValues] = useState<Record<string, string | boolean>>(() => {
		const initial: Record<string, string | boolean> = {};
		for (const field of fields) {
			initial[field.name] = field.kind === "confirm" ? false : field.value ?? (field.kind === "select" ? field.options?.[0] ?? "" : "");
		}
		return initial;
	});
	const inputStyle = {
		height: 32,
		padding: "0 10px",
		fontSize: 12.5,
		borderRadius: 8,
		background: "var(--dsw-hover)",
		border: "0.5px solid var(--dsw-border-l2)",
		color: "var(--dsw-label-primary)",
		outline: "none",
		width: "100%",
	} as const;
	return (
		<form
			className="flex flex-col gap-3"
			onSubmit={(event) => {
				event.preventDefault();
				onAction({ values });
			}}
		>
			{fields.map((field) => field.kind === "select" ? (
				<div key={field.name} className="flex flex-col gap-1.5">
					<span style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>{field.label}</span>
					<SelectOption variant="field" label={field.label} value={String(values[field.name] ?? "")}
						options={(field.options ?? []).map((option) => ({ value: option, label: option }))}
						onChange={(next) => setValues((prev) => ({ ...prev, [field.name]: next }))} />
				</div>
			) : (
				<label key={field.name} className="flex flex-col gap-1.5">
					<span style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>{field.label}</span>
					{field.kind === "confirm" ? (
						<span className="flex items-center gap-2" style={{ height: 24 }}>
							<input
								type="checkbox"
								checked={values[field.name] === true}
								onChange={(event) => setValues((prev) => ({ ...prev, [field.name]: event.target.checked }))}
								style={{ accentColor: "var(--dsw-accent)" }}
							/>
						</span>
					) : (
						<input
							value={String(values[field.name] ?? "")}
							placeholder={field.placeholder}
							onChange={(event) => setValues((prev) => ({ ...prev, [field.name]: event.target.value }))}
							style={inputStyle}
						/>
					)}
				</label>
			))}
			<div className="flex justify-end">
				<button type="submit" className="btn-primary-white" style={{ height: 30, padding: "0 14px", fontSize: 12.5 }}>
					{submitLabel || t.confirm}
				</button>
			</div>
		</form>
	);
}

/** 一个列表项：标签在左、说明在右，选中项左侧一条强调色 */
function WebUiRow({ item, selected, onAction }: {
	item: { label: string; description?: string; action?: string; disabled?: boolean };
	selected: boolean;
	onAction: (result: WebUiResult) => void;
}) {
	return (
		<button
			type="button"
			role="option"
			aria-selected={selected}
			aria-disabled={item.disabled === true}
			disabled={item.disabled === true}
			className="flex w-full items-center gap-3 text-left transition-colors hover:bg-[var(--dsw-hover)] disabled:cursor-default disabled:opacity-45"
			style={{
				padding: "8px 12px",
				background: selected ? "var(--dsw-active)" : "transparent",
				borderLeft: selected ? "2px solid var(--dsw-accent)" : "2px solid transparent",
			}}
			onClick={() => onAction(item.action ? { action: item.action } : { values: { selected: item.label } })}
		>
			<span className="min-w-0 flex-1 truncate" style={{ fontSize: 13, color: "var(--dsw-label-primary)" }}>
				{item.label}
			</span>
			{item.description && (
				<span className="flex-none" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>{item.description}</span>
			)}
		</button>
	);
}

function WebUiNodeView({ node, onAction }: { node: WebUiNode; onAction: (result: WebUiResult) => void }) {
	switch (node.type) {
		case "box": {
			const row = node.direction === "row";
			return (
				<div
					className="flex min-w-0"
					style={{ flexDirection: row ? "row" : "column", gap: node.gap ?? 10, flexWrap: row ? "wrap" : "nowrap", alignItems: row ? "center" : "stretch" }}
				>
					{node.children.map((child, index) => (
						<WebUiNodeView key={index} node={child} onAction={onAction} />
					))}
				</div>
			);
		}
		case "text":
			return (
				<div
					className="whitespace-pre-wrap break-words"
					style={{
						fontSize: node.mono ? 11.5 : 13,
						lineHeight: 1.6,
						fontFamily: node.mono ? "var(--font-mono)" : "inherit",
						color: TONE_COLOR[node.tone ?? "default"],
					}}
				>
					{node.text}
				</div>
			);
		case "list":
			return (
				<div
					className="flex flex-col overflow-hidden rounded-[10px]"
					style={{ border: "0.5px solid var(--dsw-border-l2)" }}
					role="listbox"
				>
					{node.items.map((item, index) => (
						<div key={`${index}-${item.label}`} style={index > 0 ? { borderTop: "0.5px solid var(--dsw-border-l1)" } : undefined}>
							<WebUiRow item={item} selected={node.selected === index} onAction={onAction} />
						</div>
					))}
				</div>
			);
		case "table":
			return (
				<div className="overflow-x-auto rounded-[10px]" style={{ border: "0.5px solid var(--dsw-border-l2)" }}>
					<table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12.5 }}>
						<thead>
							<tr style={{ background: "var(--dsw-hover)" }}>
								{node.columns.map((column) => (
									<th key={column} className="text-left" style={{ padding: "7px 12px", color: "var(--dsw-label-caption)", fontWeight: 500, fontSize: 11.5 }}>
										{column}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{node.rows.map((row, rowIndex) => (
								<tr key={rowIndex} style={{ borderTop: "0.5px solid var(--dsw-border-l1)" }}>
									{row.map((cell, cellIndex) => (
										<td key={cellIndex} style={{ padding: "7px 12px", color: "var(--dsw-label-secondary)" }}>{cell}</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			);
		case "progress": {
			const percent = Math.round(node.value * 100);
			return (
				<div className="flex flex-col gap-1.5">
					{node.label && (
						<div className="flex items-baseline justify-between" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>
							<span>{node.label}</span>
							<span className="tabular-nums">{percent}%</span>
						</div>
					)}
					<div className="overflow-hidden rounded-full" style={{ height: 5, background: "var(--dsw-hover)" }}>
						<div style={{ width: `${percent}%`, height: "100%", background: "var(--dsw-accent)", borderRadius: 99 }} />
					</div>
				</div>
			);
		}
		case "code":
			return (
				<pre
					className="overflow-auto rounded-[10px]"
					style={{
						fontSize: 11.5,
						lineHeight: 1.55,
						fontFamily: "var(--font-mono)",
						background: "var(--dsw-hover)",
						color: "var(--dsw-label-secondary)",
						margin: 0,
						padding: "10px 12px",
						whiteSpace: "pre-wrap",
						maxHeight: 260,
					}}
				>
					{node.text}
				</pre>
			);
		case "form":
			return <WebUiForm fields={node.fields} submitLabel={node.submitLabel} onAction={onAction} />;
		default:
			return null;
	}
}

/** message 若全是 "key : value" 行（权限对话框的常见形态），解析成键值表渲染 */
function parseKeyValueRows(message: string): { key: string; value: string }[] | null {
	const lines = message.split("\n").map((l) => l.trim()).filter(Boolean);
	if (!lines.length) return null;
	const rows: { key: string; value: string }[] = [];
	for (const line of lines) {
		const m = /^([^:\s]{1,20})\s*:\s(.+)$/.exec(line);
		if (!m) return null;
		rows.push({ key: m[1], value: m[2] });
	}
	return rows;
}

export function ExtensionDialogHost({
	dialog,
	onAnswer,
	renderer,
	cwd = "",
	sessionPath,
	embedded = false,
}: {
	dialog: ExtensionDialog | null;
	onAnswer: (id: string, response: { value?: string; confirmed?: boolean; cancelled?: boolean }) => void;
	renderer?: WebResourceView;
	cwd?: string;
	sessionPath?: string;
	embedded?: boolean;
}) {
	const { t } = useI18n();
	const resourceText = useResourceText();
	const [basic, setBasic] = useState(false);
	const [text, setText] = useState("");
	const [idx, setIdx] = useState(0);
	const dialogRef = useRef<HTMLDivElement>(null);
	useDialog({ open: !!dialog && !embedded, ref: dialogRef, onClose: () => { if (dialog) onAnswer(dialog.id, { cancelled: true }); } });
	const isPermission = /permission|approve|allow/i.test(dialog?.title ?? "");
	const kvRows = useMemo(() => (dialog?.message ? parseKeyValueRows(dialog.message) : null), [dialog?.message, dialog?.id]);
	const isEditor = dialog?.method === "editor";
	useEffect(() => {
		// editor 的初始内容由扩展给（prefill），其余对话框每次从空开始
		setText(dialog?.method === "editor" ? dialog.prefill ?? "" : "");
		setIdx(0);
		setBasic(false);
	}, [dialog?.id, dialog?.method, dialog?.prefill]);
	useEffect(() => {
		if (!dialog || embedded && !basic && (renderer || dialog.resourceView)) return;
		const previous = document.activeElement;
		if (dialog.method !== "input" && dialog.method !== "editor") dialogRef.current?.focus();
		return () => {
			const focused = document.activeElement;
			if ((!focused || focused === document.body || dialogRef.current?.contains(focused)) && previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
		};
	}, [dialog?.id, dialog?.method, embedded, basic, renderer]);
	if (!dialog) return null;
	const resourceView = basic ? undefined : renderer ?? dialog.resourceView;
	const resourceAnswer = (value: JsonValue) => {
		if (dialog.method === "confirm") onAnswer(dialog.id, { confirmed: value === true });
		else if (dialog.method === "select" || dialog.method === "input" || dialog.method === "editor") {
			if (typeof value === "string" && (dialog.method !== "select" || dialog.options?.includes(value))) onAnswer(dialog.id, { value });
		} else onAnswer(dialog.id, { value: JSON.stringify(value) });
	};
	// 有资源接管时整张卡由资源渲染：不再套 PiWeb 的标题、「扩展」标签与 popover 外框（旧版卡片本来就没有这些）。
	if (resourceView) return (
		<div ref={dialogRef} tabIndex={-1} className={embedded ? "flex w-full flex-col" : "fixed inset-0 z-[120] flex items-center justify-center"}
			style={embedded ? undefined : { background: "var(--dsw-mask)" }} role="dialog" aria-modal={embedded ? undefined : true} aria-label={dialog.title}
			onKeyDown={(event) => { event.stopPropagation(); if (event.key === "Escape") { event.preventDefault(); onAnswer(dialog.id, { cancelled: true }); } }}>
			<div className={embedded ? "w-full" : "popover w-full p-3"} style={embedded ? undefined : { maxWidth: "min(92vw,640px)", background: "var(--dsw-glass-modal)" }}>
				<ResourceFrame key={`${dialog.id}:${resourceView.id}`} view={resourceView} cwd={cwd} sessionPath={sessionPath}
					request={{ method: dialog.method, title: dialog.title, message: dialog.message ?? null, options: dialog.options ?? null, placeholder: dialog.placeholder ?? null, prefill: dialog.prefill ?? null }}
					data={dialog.resourceData} onAnswer={resourceAnswer} onCancel={() => onAnswer(dialog.id, { cancelled: true })} onUnavailable={() => setBasic(true)} />
			</div>
		</div>
	);
	return (
		<div
			ref={dialogRef}
			tabIndex={-1}
			className={embedded ? "mb-3 flex w-full flex-col" : "fixed inset-0 z-[120] flex items-center justify-center"}
			style={embedded ? undefined : { background: "var(--dsw-mask)" }}
			role="dialog"
			aria-modal={embedded ? undefined : true}
			aria-label={dialog.title}
			onKeyDown={(event) => {
				event.stopPropagation();
				if (event.key === "Escape") {
					event.preventDefault();
					onAnswer(dialog.id, { cancelled: true });
				} else if (dialog.method === "select" && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
					event.preventDefault();
					setIdx((current) => Math.max(0, Math.min(current + (event.key === "ArrowDown" ? 1 : -1), (dialog.options?.length ?? 1) - 1)));
				} else if (dialog.method === "select" && event.key === "Enter" && event.target === event.currentTarget) {
					event.preventDefault();
					onAnswer(dialog.id, { value: dialog.options?.[idx] });
				}
			}}
		>
			<div className="popover flex flex-col gap-3 p-5" style={{ width: embedded ? "100%" : isEditor ? "min(92vw,640px)" : dialog.method === "web" || resourceView ? "min(92vw,640px)" : "min(92vw,480px)", background: "var(--dsw-glass-modal)" }}>
				<div className="flex items-start gap-2.5">
					{isPermission && (
						<span className="flex-none flex items-center justify-center rounded-lg" style={{ width: 30, height: 30, background: "color-mix(in srgb, var(--dsw-warn) 15%, transparent)" }}>
							<IconShieldOutline16 size={16} style={{ color: "var(--dsw-warn)" }} />
						</span>
					)}
					<div className="min-w-0 flex-1">
						<div style={{ fontSize: 14.5, fontWeight: 600, lineHeight: 1.4 }}>{dialog.title}</div>
						<div className="mt-0.5" style={{ fontSize: 10.5, color: "var(--dsw-label-caption)" }}>{t.extensionDialogTag}</div>
					</div>
				</div>
				{<>
				{kvRows ? (
					<div className="flex flex-col gap-1.5 rounded-xl px-3 py-2.5" style={{ background: "var(--dsw-hover)" }}>
						{kvRows.map(({ key, value }) => (
							<div key={key} className="flex items-baseline gap-2">
								<span className="flex-none" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)", width: 72 }}>{key}</span>
								<span className="min-w-0 flex-1 break-all" style={{ fontFamily: "var(--font-mono)", fontSize: 12.5, color: "var(--dsw-label-primary)" }}>{value}</span>
							</div>
						))}
					</div>
				) : dialog.message ? (
					<div className="whitespace-pre-wrap rounded-xl px-3 py-2.5" style={{ fontSize: 12.5, color: "var(--dsw-label-secondary)", lineHeight: 1.55, background: "var(--dsw-hover)" }}>{dialog.message}</div>
				) : null}
				{dialog.method === "select" && (
					<div className="flex max-h-72 flex-col overflow-y-auto rounded-xl" style={{ border: "0.5px solid var(--dsw-border-l2)" }} role="listbox">
						{(dialog.options ?? []).map((opt, i) => {
							const affirmative = /^(yes|allow|always)/i.test(opt.trim());
							const negative = /^(no|deny|never)/i.test(opt.trim());
							return (
								<button
									key={`${i}-${opt}`}
									role="option"
									aria-selected={i === idx}
									className="px-3 py-2 text-left transition-colors"
									style={{
										fontSize: 13,
										fontWeight: affirmative || negative ? 550 : 400,
										color: affirmative ? "var(--dsw-accent)" : negative ? "var(--dsw-danger)" : "var(--dsw-label-primary)",
										background: i === idx ? "var(--dsw-hover)" : "transparent",
										borderLeft: i === idx ? "2px solid var(--dsw-accent)" : "2px solid transparent",
									}}
									onMouseEnter={() => setIdx(i)}
									onClick={() => onAnswer(dialog.id, { value: opt })}
								>
									{opt}
								</button>
							);
						})}
					</div>
				)}
				{dialog.method === "input" && (
					<input
						autoFocus
						value={text}
						placeholder={dialog.placeholder}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.nativeEvent.isComposing) onAnswer(dialog.id, { value: text });
						}}
						className="rounded-xl px-3 py-2"
						style={{ fontSize: 13, background: "var(--dsw-hover)", border: "0.5px solid var(--dsw-border-l2)" }}
					/>
				)}
				{dialog.method === "editor" && (
					<textarea
						autoFocus
						value={text}
						onChange={(e) => setText(e.target.value)}
						onKeyDown={(e) => {
							if (e.nativeEvent.isComposing || e.keyCode === 229) return;
							// Ctrl/Cmd + Enter 提交：多行编辑里单独的 Enter 是换行
							if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onAnswer(dialog.id, { value: text });
						}}
						className="rounded-xl px-3 py-2"
						style={{ fontSize: 13, minHeight: 180, maxHeight: "52vh", fontFamily: "var(--font-mono)", lineHeight: 1.6, background: "var(--dsw-hover)", border: "0.5px solid var(--dsw-border-l2)", resize: "vertical" }}
					/>
				)}
				{dialog.method === "web" && (
					<div style={{ maxHeight: "58vh", overflowY: "auto", margin: "0 -2px", padding: "0 2px" }}>
						<WebUiNodeView
							key={dialog.id}
							node={dialog.tree ?? { type: "code", text: dialog.webText ?? "" }}
							onAction={(result) => onAnswer(dialog.id, { value: JSON.stringify(result) })}
						/>
					</div>
				)}
				{dialog.method === "resource" && <>
					<pre className="max-h-48 overflow-auto whitespace-pre-wrap" style={{ fontSize: 12 }}>{JSON.stringify(dialog.resourceData, null, 2)}</pre>
					<textarea aria-label={resourceText.basicInterface} value={text} onChange={(event) => setText(event.target.value)} className="rounded-xl px-3 py-2" />
				</>}
				</>}
				<div className="flex justify-end gap-2">
					<button className="btn-outline" style={{ height: 32 }} onClick={() => onAnswer(dialog.id, { cancelled: true })}>{t.cancel}</button>
					{dialog.method === "resource" && !resourceView && <button type="button" className="btn-primary-white" onClick={() => { let value: JsonValue = text; try { value = JSON.parse(text); } catch { /* Free text remains text. */ } resourceAnswer(value); }}>{t.confirm}</button>}
					{!resourceView && dialog.method === "confirm" && (
						<button className="btn-primary-white" style={{ height: 32 }} onClick={() => onAnswer(dialog.id, { confirmed: true })}>{t.confirm}</button>
					)}
					{!resourceView && dialog.method === "input" && (
						<button className="btn-primary-white" style={{ height: 32 }} onClick={() => onAnswer(dialog.id, { value: text })}>{t.confirm}</button>
					)}
					{!resourceView && dialog.method === "editor" && (
						<button className="btn-primary-white" style={{ height: 32 }} onClick={() => onAnswer(dialog.id, { value: text })}>{t.confirm}</button>
					)}
				</div>
			</div>
		</div>
	);
}

/**
 * 扩展 setWidget 的文字块（待办列表、计划进度之类）：对应 pi 终端输入框上方 / 下方的 widget。
 * 只有字符串数组（组件工厂在 RPC 模式同样是忽略的），按 key 各占一块、等宽字体原样显示。
 */
export function ExtensionWidgets({ widgets, placement, className }: { widgets: Record<string, WebExtensionWidget>; placement: "aboveEditor" | "belowEditor"; className?: string }) {
	const { t } = useI18n();
	const entries = Object.entries(widgets).filter(([, widget]) => widget.placement === placement && widget.lines.length > 0);
	if (!entries.length) return null;
	return (
		<div className={`mx-auto flex w-full flex-col gap-1${className ? ` ${className}` : ""}`} data-widget-placement={placement} aria-label={t.extensionWidget}>
			{entries.map(([key, widget]) => (
				<pre
					key={key}
					className="overflow-x-auto whitespace-pre-wrap break-words rounded-xl px-3 py-2"
					style={{ margin: 0, fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.5, color: "var(--dsw-label-secondary)", background: "var(--dsw-hover)", border: "0.5px solid var(--dsw-border-l2)" }}
				>
					{widget.lines.join("\n")}
				</pre>
			))}
		</div>
	);
}

export function ExtensionNotices({
	notices,
	onDismiss,
	children,
}: {
	notices: PiWebNotice[];
	onDismiss: (id: string) => void;
	/** 同一摞里的其它常驻提示（如更新提示条），排在扩展通知上面，免得两处浮层叠在一起 */
	children?: React.ReactNode;
}) {
	const { t } = useI18n();
	const text = (n: PiWebNotice) => {
		if (n.code === "external_reload") return t.externalSessionReloaded.replace("{n}", String(n.count ?? 0));
		if (n.code === "external_write") return t.externalSessionWriting.replace("{n}", String(n.count ?? 0));
		return n.message;
	};
	// 通知 6 秒后自动消失
	useEffect(() => {
		if (!notices.length) return;
		const timers = notices.map((n) => setTimeout(() => onDismiss(n.id), Math.max(500, 6000 - (Date.now() - n.ts))));
		return () => timers.forEach(clearTimeout);
	}, [notices, onDismiss]);
	// 有 children 时容器常驻：children 自己决定显示与否，容器里没东西时什么也看不见（pointer-events-none）
	if (!notices.length && !children) return null;
	const color = (type: string) => (type === "error" ? "var(--dsw-danger)" : type === "warning" ? "var(--dsw-warn)" : "var(--dsw-accent)");
	// 手机上输入卡占满底部，放底部会盖住发送按钮：窄屏改挂到顶栏下面
	return (
		<div className="pointer-events-none fixed right-4 top-16 z-[110] flex w-[min(92vw,360px)] flex-col gap-2 sm:top-auto sm:bottom-24">
			{children}
			{notices.map((n) => (
				<button
					key={n.id}
					className="pointer-events-auto rounded-xl px-3 py-2 text-left"
					style={{ fontSize: 12.5, background: "var(--dsw-glass-popover)", border: "0.5px solid var(--dsw-border-l2)", boxShadow: "var(--dsw-elevation-soft)", borderLeft: `3px solid ${color(n.type)}` }}
					onClick={() => onDismiss(n.id)}
				>
					{text(n)}
				</button>
			))}
		</div>
	);
}
