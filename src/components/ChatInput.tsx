"use client";

/**
 * 输入卡（对齐 dsh ui-conversation InputBar 结构）：
 * 22px 圆角胶囊 + elevation-soft；按钮行 = ＋命令 ｜ 模型 ｜ 圆环 ｜ 停止/发送圆钮。
 * dsh 语义：运行中 + 空文案 → 停止圆钮；有文案 → 发送即排队 steer；Enter 发送 / Shift+Enter 换行。
 */
import { useEffect, useRef, useState } from "react";
import {
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
	kind: "builtin" | "template" | "skill";
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
	onCommand?: (name: string) => void;
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
			onCommand?.(entry.name);
		} else {
			// prompt 模板 / 技能：交给 pi 展开执行
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
			if (!trimmed && attachments.length === 0) return;
			if (isStreaming) {
				// Enter 键行为（设置）：排队发送 = followUp；插话 = steer
				const behavior = localStorage.getItem("piweb.enterBehavior") ?? "queue";
				if (behavior === "steer") onSteer(trimmed, attachments);
				else if (onFollowUp) onFollowUp(trimmed, attachments);
				else onSteer(trimmed, attachments);
			} else onSend(trimmed, attachments);
			setText("");
			imagesRef.current = [];
			setImages([]);
			requestAnimationFrame(autoSize);
		})();
	};

	const pickFiles = (files: FileList | null) => {
		if (!files) return;
		for (const f of Array.from(files)) {
			if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(f.type)) {
				setAttachmentError(t.imageTypeUnsupported);
				continue;
			}
			if (f.size > 10 * 1024 * 1024) {
				setAttachmentError(t.imageTooLarge);
				continue;
			}
			const read = new Promise<void>((resolve) => {
				const reader = new FileReader();
				reader.onload = () => {
					const dataUrl = String(reader.result);
					const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
					const next = imagesRef.current;
					if (next.length >= 8) setAttachmentError(t.imageCountLimit);
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
		}
	};

	const hasDraft = text.trim().length > 0 || images.length > 0;

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
									{c.kind === "template" ? t.promptType : t.skillType}
								</span>
							)}
							<span className="truncate" style={{ fontSize: 13, color: "var(--dsw-label-tertiary)" }}>
								{c.desc}
							</span>
						</button>
					))}
				</div>
			)}

			{/* 附件轨 */}
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

			{/* 卡片（玻璃态） */}
			<div
				className="relative w-full"
				style={{
					borderRadius: 22,
					background: "var(--dsw-input-major)",
					boxShadow: "var(--dsw-elevation-soft)",
					border: "0.5px solid var(--dsw-border-l1)",
				}}
			>
				<div
					className="px-4 pt-3"
					onDragOver={(e) => e.preventDefault()}
					onDrop={(e) => {
						e.preventDefault();
						pickFiles(e.dataTransfer.files);
					}}
				>
					<textarea
						ref={taRef}
						value={text}
						disabled={disabled || isBlocked}
						rows={1}
						placeholder={!disabled && isBlocked ? t.blockedComposer : t.inputPlaceholder}
						suppressHydrationWarning
						className="block w-full resize-none"
						style={{ fontSize: "var(--dsh-content-font-size)", lineHeight: 1.55 }}
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
		</div>
	);
}
