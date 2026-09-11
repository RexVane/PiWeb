"use client";

/**
 * 输入卡（对齐 dsh ui-conversation InputBar 结构）：
 * 22px 圆角胶囊 + elevation-soft；按钮行 = ＋命令 ｜ 模型 ｜ 圆环 ｜ 停止/发送圆钮。
 * dsh 语义：运行中 + 空文案 → 停止圆钮；有文案 → 发送即排队 steer；Enter 发送 / Shift+Enter 换行。
 */
import { useEffect, useRef, useState } from "react";
import {
	IconFileOutline16,
	IconSendArrowUp14,
	IconStopFill16,
} from "@/components/icons";
import { ContextMeter } from "@/components/ContextMeter";
import { ModelSelector, type ModelChoice } from "@/components/ModelSelector";
import { useI18n } from "@/i18n";
import type { ImageAttachment } from "@/lib/types";

export interface SlashCommand {
	name: string;
	desc: string;
	/** builtin = Web 自己处理；skill / template / extension = 原样发给 pi，由 SDK 展开或执行 */
	kind: "builtin" | "skill" | "template" | "extension";
	/** 提示模板的参数提示（frontmatter argument-hint） */
	argumentHint?: string;
}

export function ChatInput({
	disabled,
	isStreaming,
	contextPercent,
	contextTokens,
	contextWindow,
	contextSource,
	contextVisible = true,
	model,
	thinkingLevel,
	thinkingLevels,
	models,
	providerNames,
	authByProvider,
	queue,
	commands,
	onCommand,
	onSend,
	onSteer,
	onFollowUp,
	onAbort,
	onSelectModel,
	onSelectLevel,
	onClearQueue,
	draft,
	insert,
}: {
	disabled?: boolean;
	isStreaming: boolean;
	contextPercent: number | null;
	contextTokens: number | null;
	contextWindow: number | null;
	/** 上下文分段数据源：ContextMeter 弹窗打开时才做字符统计 */
	contextSource?: { systemChars: number; messages: { content: Array<{ type: string; text?: string; thinking?: string }> }[] };
	/** 还没有对话时隐藏上下文计量 */
	contextVisible?: boolean;
	model?: { provider: string; id: string; name: string };
	thinkingLevel?: string;
	thinkingLevels: string[];
	models: ModelChoice[];
	providerNames: Record<string, string>;
	authByProvider: Record<string, boolean>;
	queue: { steering: string[]; followUp: string[] };
	commands?: SlashCommand[];
	onCommand?: (name: string, args: string) => void;
	onSend: (text: string, images: ImageAttachment[]) => void;
	onSteer: (text: string, images: ImageAttachment[]) => void;
	onFollowUp?: (text: string, images: ImageAttachment[]) => void;
	onAbort: () => void;
	onSelectModel: (provider: string, id: string) => void;
	onSelectLevel: (level: string) => void;
	onClearQueue?: () => void;
	draft?: { key: number; text: string } | null;
	/** 在光标处插入文本（文件面板「引用」、Git 面板「让 pi 提交」），不覆盖已有草稿 */
	insert?: { key: number; text: string } | null;
}) {
	const [text, setText] = useState("");
	const [images, setImages] = useState<ImageAttachment[]>([]);
	const imagesRef = useRef<ImageAttachment[]>([]);
	const pendingReads = useRef<Promise<void>[]>([]);
	const [attachmentError, setAttachmentError] = useState("");
	/** 拖入的普通文件（非图片）：上传到 ~/.pi/agent/web-uploads，发送时以路径引用（dsh 附件语义） */
	const [uploads, setUploads] = useState<Array<{ name: string; path: string; size: number }>>([]);
	const uploadsRef = useRef<Array<{ name: string; path: string; size: number }>>([]);
	const [uploadBusy, setUploadBusy] = useState(false);
	const [dragActive, setDragActive] = useState(false);
	const dragDepth = useRef(0);
	const [modelOpen, setModelOpen] = useState(false);
	const [cmdIdx, setCmdIdx] = useState(0);
	const [cmdDismissed, setCmdDismissed] = useState(false);
	const taRef = useRef<HTMLTextAreaElement>(null);
	const wrapRef = useRef<HTMLDivElement>(null);
	const { t } = useI18n();
	const isBlocked = !model?.id;

	useEffect(() => {
		if (!insert) return;
		setText((prev) => {
			const ta = taRef.current;
			const pos = ta && ta.selectionStart !== null ? ta.selectionStart : prev.length;
			const before = prev.slice(0, pos);
			const after = prev.slice(pos);
			const sep = before && !/\s$/.test(before) ? " " : "";
			return `${before}${sep}${insert.text}${after}`;
		});
		setCmdDismissed(false);
		requestAnimationFrame(() => {
			autoSize();
			taRef.current?.focus();
		});
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [insert]);

	useEffect(() => {
		if (!draft) return;
		setText(draft.text);
		setCmdDismissed(false);
		requestAnimationFrame(() => {
			autoSize();
			taRef.current?.focus();
		});
	}, [draft]);

	// 斜杠命令模式：文本以 / 开头且未输入参数空格
	const slash = text.startsWith("/") ? text.slice(1) : "";
	const hasArgs = slash.includes(" ");
	const typedCommandMode = !!commands?.length && text.startsWith("/") && !cmdDismissed && !hasArgs;
	const filteredCommands = (commands ?? []).filter((c) => c.name.toLowerCase().startsWith(slash.split(" ")[0].toLowerCase()));
	const visibleCommands = filteredCommands;
	const commandMode = typedCommandMode;
	const effectiveIdx = Math.min(cmdIdx, Math.max(0, visibleCommands.length - 1));

	const runEntry = (entry: SlashCommand) => {
		const args = slash.slice(entry.name.length).trim();
		if (entry.kind === "builtin" && entry.name === "model") {
			setModelOpen(true);
			setText("");
			setCmdDismissed(false);
			return;
		}
		if (entry.kind === "builtin") {
			onCommand?.(entry.name, args);
		} else if (entry.kind === "template" && entry.argumentHint && !args) {
			// 模板要参数：把 /name 留在输入框里等用户补参数，而不是直接发空参数
			setText(`/${entry.name} `);
			setCmdDismissed(true);
			requestAnimationFrame(() => taRef.current?.focus());
			return;
		} else {
			// 技能 / 模板 / 扩展命令：交给 pi 展开执行（SDK 的 prompt() 会识别 /skill:x、/template、扩展命令）
			onSend(`/${entry.name}${args ? ` ${args}` : ""}`, []);
		}
		setText("");
		setCmdIdx(0);
		setCmdDismissed(false);
	};

	// 自动高度：上限 14 行（约 336px）
	const autoSize = () => {
		const ta = taRef.current;
		if (!ta) return;
		ta.style.height = "auto";
		ta.style.height = `${Math.min(ta.scrollHeight, 336)}px`;
	};

	const doSend = () => {
		const trimmed = text.trim();
		// FileReader 可能尚未完成（粘贴后立刻回车）：先等所有读取结束，
		// 再从 ref 取最新附件，避免漏发或图片窜到下一条消息。
		void (async () => {
			if (pendingReads.current.length) {
				await Promise.allSettled(pendingReads.current);
				pendingReads.current = [];
			}
			const attachments = imagesRef.current;
			const files = uploadsRef.current;
			if (!trimmed && attachments.length === 0 && files.length === 0) return;
			// 直接敲 "/compact 只留结论" 这类 Web 内置命令：走命令处理，不能当普通文本发给模型
			if (trimmed.startsWith("/") && attachments.length === 0 && files.length === 0) {
				const [head, ...rest] = trimmed.slice(1).split(/\s+/);
				const builtin = (commands ?? []).find((c) => c.kind === "builtin" && c.name.toLowerCase() === head.toLowerCase());
				if (builtin) {
					onCommand?.(builtin.name, rest.join(" "));
					setText("");
					setCmdDismissed(false);
					requestAnimationFrame(autoSize);
					return;
				}
			}
			// 普通文件以路径行附在消息尾部，模型经 read/bash 等工具访问（dsh FileAttachmentRef 语义）
			const compose = (base: string) =>
				files.length ? `${base}${base ? "\n\n" : ""}${files.map((f) => t.attachmentLine.replace("{path}", f.path).replace("{size}", fmtUploadSize(f.size))).join("\n")}` : base;
			if (isStreaming) {
				// Enter 键行为（设置）：排队发送 = followUp；插话 = steer
				const behavior = localStorage.getItem("piweb.enterBehavior") ?? "queue";
				if (behavior === "steer") onSteer(compose(trimmed), attachments);
				else if (onFollowUp) onFollowUp(compose(trimmed), attachments);
				else onSteer(compose(trimmed), attachments);
			} else onSend(compose(trimmed), attachments);
			setText("");
			imagesRef.current = [];
			setImages([]);
			uploadsRef.current = [];
			setUploads([]);
			requestAnimationFrame(autoSize);
		})();
	};

	const pickFiles = (files: FileList | File[] | null) => {
		if (!files) return;
		for (const f of Array.from(files)) {
			if (["image/jpeg", "image/png", "image/webp", "image/gif"].includes(f.type)) {
				if (f.size > 20 * 1024 * 1024) {
					setAttachmentError(t.imageTooLarge);
					continue;
				}
				const read = new Promise<void>((resolve) => {
					const reader = new FileReader();
					reader.onload = () => {
					const dataUrl = String(reader.result);
					const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
					const next = imagesRef.current;
					if (next.length >= 20) setAttachmentError(t.imageCountLimit);
					else {
						imagesRef.current = [...next, { type: "image", data: base64, mimeType: f.type }];
						setImages(imagesRef.current);
					}
					resolve();
				};
				reader.onerror = () => resolve();
				reader.readAsDataURL(f);
			});
			pendingReads.current.push(read);
			} else {
				// 非图片文件：上传到本机 uploads 目录，发送时以路径引用
				void uploadFile(f);
			}
		}
	};

	const uploadFile = async (f: File) => {
		if (f.size > 100 * 1024 * 1024) {
			setAttachmentError(t.uploadTooLarge);
			return;
		}
		if (uploadsRef.current.length >= 16) {
			setAttachmentError(t.uploadCountLimit);
			return;
		}
		setUploadBusy(true);
		setAttachmentError("");
		try {
			const dataUrl = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () => resolve(String(reader.result));
				reader.onerror = () => reject(reader.error);
				reader.readAsDataURL(f);
			});
			const r = await fetch("/api/files", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "upload", name: f.name, data: dataUrl.slice(dataUrl.indexOf(",") + 1) }),
			});
			const j = await r.json();
			if (!j.success) throw new Error(j.error || "upload failed");
			uploadsRef.current = [...uploadsRef.current, { name: j.data.name, path: j.data.path, size: j.data.size }];
			setUploads(uploadsRef.current);
		} catch (e) {
			setAttachmentError(`${t.uploadFailed}：${e instanceof Error ? e.message : String(e)}`);
		} finally {
			setUploadBusy(false);
		}
	};

	// 全窗口拖放（照 dsh ComposerAttachments）：拖文件悬停时整窗高亮，任意位置松开即接收
	useEffect(() => {
		const withFiles = (e: DragEvent) => e.dataTransfer !== null && e.dataTransfer.types.includes("Files");
		const reset = () => {
			dragDepth.current = 0;
			setDragActive(false);
		};
		const onDragEnter = (e: DragEvent) => {
			if (!withFiles(e)) return;
			e.preventDefault();
			dragDepth.current += 1;
			setDragActive(true);
		};
		const onDragOver = (e: DragEvent) => {
			if (!withFiles(e)) return;
			e.preventDefault();
		};
		const onDragLeave = (e: DragEvent) => {
			if (!withFiles(e)) return;
			dragDepth.current = Math.max(0, dragDepth.current - 1);
			if (dragDepth.current === 0) setDragActive(false);
		};
		const onDrop = (e: DragEvent) => {
			if (e.dataTransfer === null) return;
			e.preventDefault();
			reset();
			pickFiles(e.dataTransfer.files);
		};
		document.addEventListener("dragenter", onDragEnter);
		document.addEventListener("dragover", onDragOver);
		document.addEventListener("dragleave", onDragLeave);
		document.addEventListener("drop", onDrop);
		window.addEventListener("dragend", reset);
		return () => {
			document.removeEventListener("dragenter", onDragEnter);
			document.removeEventListener("dragover", onDragOver);
			document.removeEventListener("dragleave", onDragLeave);
			document.removeEventListener("drop", onDrop);
			window.removeEventListener("dragend", reset);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	const hasDraft = text.trim().length > 0 || images.length > 0 || uploads.length > 0;

	return (
		<div ref={wrapRef} className="relative w-full">
			{attachmentError && (
				<div className="mb-2 px-2" role="alert" style={{ fontSize: 12, color: "var(--dsw-danger)" }}>
					{attachmentError}
				</div>
			)}
			{/* 斜杠命令菜单（dsh：悬浮于输入卡上方，同宽） */}
			{commandMode && visibleCommands.length > 0 && (
				<div className="popover absolute bottom-full left-0 right-0 z-50 mb-2 max-h-[340px] overflow-y-auto py-1.5" role="listbox" aria-label={t.slashCatalog}>
					<div className="px-4 pb-1 pt-1" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>
						{t.slashCatalog}
					</div>
					{visibleCommands.map((c, i) => (
						<button
							key={`${c.kind}:${c.name}`}
							role="option"
							aria-selected={i === effectiveIdx}
							className="flex w-full items-baseline gap-3 px-4 py-2 text-left transition-colors"
							style={{ background: i === effectiveIdx ? "var(--dsw-hover)" : "transparent" }}
							onMouseEnter={() => setCmdIdx(i)}
							onClick={() => runEntry(c)}
						>
							<span style={{ fontSize: 14, fontWeight: 500, color: "var(--dsw-label-primary)", flex: "none" }}>{c.name}</span>
							{c.kind !== "builtin" && (
								<span className="rounded px-1.5 py-0.5" style={{ fontSize: 10.5, color: "var(--dsw-label-caption)", background: "var(--dsw-selector)", flex: "none" }}>
									{c.kind === "skill" ? t.skillType : c.kind === "template" ? t.promptType : t.extensionCmdType}
								</span>
							)}
							{c.argumentHint && (
								<span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--dsw-label-caption)", flex: "none" }}>{c.argumentHint}</span>
							)}
							<span className="truncate" style={{ fontSize: 13, color: "var(--dsw-label-tertiary)" }}>
								{c.desc}
							</span>
						</button>
					))}
				</div>
			)}

			{/* 附件轨：图片 */}
			{images.length > 0 && (
				<div className="mb-2 flex flex-wrap gap-2 px-1">
					{images.map((img, i) => (
						<div key={i} className="relative">
							<img
								src={`data:${img.mimeType};base64,${img.data}`}
								alt=""
								className="h-14 w-14 rounded-lg object-cover"
								style={{ border: "0.5px solid var(--dsw-border-l2)" }}
							/>
							<button
								className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full text-[10px]"
								style={{ background: "var(--dsw-label-primary)", color: "var(--dsw-bg-base)" }}
								onClick={() => setImages((prev) => prev.filter((_, j) => j !== i))}
							>
								✕
							</button>
						</div>
					))}
				</div>
			)}

			{/* 附件轨：上传的普通文件（压缩包/文档等，路径引用） */}
			{uploads.length > 0 && (
				<div className="mb-2 flex flex-wrap gap-2 px-1">
					{uploads.map((f, i) => (
						<div
							key={f.path}
							className="flex items-center gap-2 rounded-lg px-2.5 py-1.5"
							style={{ border: "0.5px solid var(--dsw-border-l2)", background: "var(--dsw-hover)" }}
							title={f.path}
						>
							<IconFileOutline16 size={14} style={{ flex: "none", color: "var(--dsw-label-tertiary)" }} />
							<span className="max-w-[180px] truncate" style={{ fontSize: 12.5, color: "var(--dsw-label-secondary)" }}>{f.name}</span>
							<span style={{ fontSize: 11, color: "var(--dsw-label-caption)" }}>{fmtUploadSize(f.size)}</span>
							<button
								className="flex h-5 w-5 items-center justify-center rounded-full text-[10px]"
								style={{ color: "var(--dsw-label-caption)" }}
								onClick={() => {
									uploadsRef.current = uploadsRef.current.filter((_, j) => j !== i);
									setUploads(uploadsRef.current);
								}}
								aria-label="remove"
							>
								✕
							</button>
						</div>
					))}
				</div>
			)}

			{/* 卡片（玻璃态）—— 拖放由 document 级监听统一接管 */}
			<div
				className="relative w-full"
				style={{
					borderRadius: 22,
					background: "var(--dsw-input-major)",
					boxShadow: "var(--dsw-elevation-soft)",
					border: "0.5px solid var(--dsw-border-l1)",
				}}
			>
				<div className="px-4 pt-3">
					<textarea
						ref={taRef}
						value={text}
						disabled={disabled || isBlocked}
						rows={1}
						placeholder={!disabled && isBlocked ? t.blockedComposer : t.inputPlaceholder}
						suppressHydrationWarning
						className="block w-full resize-none"
						style={{ fontSize: "var(--piweb-chat-font-size, var(--dsh-content-font-size))", lineHeight: 1.55 }}
							onChange={(e) => {
							setText(e.target.value);
									setCmdDismissed(false);
							setCmdIdx(0);
							autoSize();
						}}
						onPaste={(e) => {
							const files = Array.from(e.clipboardData.files);
							if (files.length) {
								e.preventDefault();
								pickFiles(e.clipboardData.files);
							}
						}}
						onKeyDown={(e) => {
							if (commandMode && visibleCommands.length > 0) {
								if (e.key === "ArrowDown") {
									e.preventDefault();
									setCmdIdx((i) => Math.min(i + 1, visibleCommands.length - 1));
									return;
								}
								if (e.key === "ArrowUp") {
									e.preventDefault();
									setCmdIdx((i) => Math.max(i - 1, 0));
									return;
								}
								if (e.key === "Escape") {
									e.preventDefault();
										setCmdDismissed(true);
									return;
								}
								if (e.key === "Enter" && !e.nativeEvent.isComposing) {
									e.preventDefault();
									runEntry(visibleCommands[effectiveIdx]);
									return;
								}
							}
							if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
								e.preventDefault();
								doSend();
							}
						}}
					/>
				</div>

				{/* 按钮行：左侧只保留命令入口；图片通过拖放或粘贴添加。 */}
				<div
					className="flex items-center gap-2"
					style={{
						paddingLeft: 8,
						paddingRight: 12,
						paddingBottom: 8,
						paddingTop: 4,
						height: 40,
						containerType: "inline-size",
					}}
				>
					{/* 命令菜单通过输入 / 触发（dsh 同款），不再提供 ＋ 启动按钮 */}
					{/* 运行中且有草稿：告诉用户 Enter 会怎么发（插话 / 排队） */}
					{isStreaming && hasDraft ? (
						<span className="min-w-0 flex-1 truncate" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)", paddingLeft: 6 }} suppressHydrationWarning>
							{(typeof window !== "undefined" ? localStorage.getItem("piweb.enterBehavior") : null) === "steer" ? t.hintSteer : t.hintFollowUp}
						</span>
					) : (
						<div className="flex-1" />
					)}

					{/* 队列提示 */}
					{isStreaming && queue.steering.length + queue.followUp.length > 0 && (
						<button type="button" title={t.clearQueue} onClick={onClearQueue} style={{ fontSize: 11, color: "var(--dsw-label-caption)" }}>
							+{queue.steering.length + queue.followUp.length}
						</button>
					)}

					{/* 模型芯片（右组，dsh 分组菜单；/model 命令可受控打开） */}
					<ModelSelector
						model={model}
						thinkingLevel={thinkingLevel}
						thinkingLevels={thinkingLevels}
						models={models}
						providerNames={providerNames}
						authByProvider={authByProvider}
						onSelectModel={onSelectModel}
						onSelectLevel={onSelectLevel}
						open={modelOpen}
						onOpenChange={setModelOpen}
					/>

					{/* 上下文圆环 */}
					{contextVisible && (
						<ContextMeter
							percent={contextPercent}
							tokens={contextTokens}
							contextWindow={contextWindow}
							source={contextSource}
						/>
					)}

					{/* 停止 / 发送圆钮 */}
					{isStreaming && !hasDraft ? (
						<button className="btn-primary-circle" title={t.stop} onClick={onAbort}>
							<IconStopFill16 size={16} />
						</button>
					) : (
						<button className="btn-primary-circle" title={isStreaming ? t.queueNote : t.send} disabled={!hasDraft || disabled || isBlocked} onClick={doSend}>
							<IconSendArrowUp14 size={16} />
						</button>
					)}
				</div>
			</div>

			{/* 全窗口拖放遮罩（dsh：拖文件悬停时高亮，松开即添加） */}
			{dragActive && (
				<div
					className="pointer-events-none fixed inset-0 z-[95] flex items-center justify-center"
					style={{ background: "color-mix(in srgb, var(--dsw-bg-base) 65%, transparent)" }}
				>
					<div
						className="flex flex-col items-center gap-3 rounded-3xl px-12 py-10"
						style={{
							border: "2px dashed var(--dsw-accent)",
							background: "var(--dsw-glass-popover)",
							boxShadow: "var(--dsw-elevation-prominent)",
						}}
					>
						<IconFileOutline16 size={32} style={{ color: "var(--dsw-accent)" }} />
						<div style={{ fontSize: 15, fontWeight: 500, color: "var(--dsw-label-primary)" }}>
							{uploadBusy ? t.uploading : t.dropToAttach}
						</div>
						<div style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>{t.dropToAttachHint}</div>
						<div
							className="rounded-full px-3 py-1"
							style={{ fontSize: 11.5, color: "var(--dsw-label-secondary)", background: "var(--dsw-hover)", lineHeight: "18px" }}
						>
							{t.dropLimits}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

function fmtUploadSize(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
	return `${bytes}B`;
}
