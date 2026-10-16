"use client";

/**
 * 输入卡（对齐 dsh ui-conversation InputBar 结构）：
 * 22px 圆角胶囊 + elevation-soft；按钮行 = ＋命令 ｜ 模型 ｜ 圆环 ｜ 停止/发送圆钮。
 * 运行中：Enter 按设置插话 / 排队，Ctrl(⌘)+Enter 用另一种；停止按钮会把排队消息取回输入框（pi 终端同款）；
 * 排队中的消息列在输入卡上方，↑（空输入框时）取回编辑。Enter 发送 / Shift+Enter 换行。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
	IconAtOutline16,
	IconFileOutline16,
	IconFolderClose16,
	IconSendArrowUp14,
	IconStopFill16,
	IconTerminalOutline14,
} from "@/components/icons";
import { ContextMeter } from "@/components/ContextMeter";
import { COLLAPSE_AT, ComposerImages } from "@/components/composer/ComposerImages";
import { ModelSelector, type ModelChoice } from "@/components/ModelSelector";
import { useI18n } from "@/i18n";
import { useWorkspaceFiles } from "@/hooks/useWorkspaceFiles";
import { fmtBytes } from "@/lib/format";
import { otherBehavior, useEnterBehavior } from "@/lib/enter-behavior";
import { atToken, candidateText, suggestPaths, type PathCandidate } from "@/lib/workspace-index";
import type { ImageAttachment } from "@/lib/types";

export interface SlashCommand {
	name: string;
	desc: string;
	/** builtin = Web 自己处理；skill / template / extension = 原样发给 pi，由 SDK 展开或执行 */
	kind: "builtin" | "skill" | "template" | "extension";
	/** 提示模板的参数提示（frontmatter argument-hint） */
	argumentHint?: string;
}

export interface ChatDraft {
	text: string;
	images: ImageAttachment[];
	uploads: Array<{ name: string; path: string; size: number }>;
	/** 从文件树/文件面板「引用到输入框」加进来的路径引用:独立于正文,输入框里渲染成 chip */
	references?: string[];
	adopted?: SlashCommand | null;
}

export type ChatDraftUpdate = ChatDraft | ((previous: ChatDraft) => ChatDraft);
export const EMPTY_CHAT_DRAFT: ChatDraft = { text: "", images: [], uploads: [], references: [] };

type SendResult = { success: boolean; error?: string };
const MAX_UPLOAD_FILES = 16;

/** abort / clearQueue 命令的返回：服务端清出来的排队文本，放回输入框用 */
type QueueResult = { success?: boolean; data?: { steering?: string[]; followUp?: string[] } };

export function ChatInput({
	disabled,
	isStreaming,
	contextPercent,
	contextTokens,
	contextWindow,
	contextSource,
	contextVisible = true,
	cwd,
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
	initialDraft,
	onDraftChange,
	onUploadError,
	onUploadProgress,
	uploadFailure,
	pendingUploadCount = 0,
	pendingSend = false,
	onSendPendingChange,
}: {
	disabled?: boolean;
	isStreaming: boolean;
	contextPercent: number | null;
	contextTokens: number | null;
	contextWindow: number | null;
	/** 上下文分段数据源：ContextMeter 弹窗打开时才做字符统计 */
	contextSource?: {
		systemChars: number;
		messages: { role?: string; content: Array<{ type: string; text?: string; thinking?: string; arguments?: unknown; name?: string }>; usage?: import("@/lib/types").TrajTokens; stopReason?: string }[];
		breakdown?: import("@/lib/types").ContextBreakdown;
		loadFull?: () => Promise<unknown> | unknown;
	};
	/** 还没有对话时隐藏上下文计量 */
	contextVisible?: boolean;
	/** 工作区根：@ 引用的候选清单从这里取（不传就不启用 @ 引用） */
	cwd?: string;
	model?: { provider: string; id: string; name: string };
	thinkingLevel?: string;
	thinkingLevels: string[];
	models: ModelChoice[];
	providerNames: Record<string, string>;
	authByProvider: Record<string, boolean>;
	queue: { steering: string[]; followUp: string[] };
	commands?: SlashCommand[];
	onCommand?: (name: string, args: string) => void;
	onSend: (text: string, images: ImageAttachment[]) => Promise<SendResult> | SendResult;
	onSteer: (text: string, images: ImageAttachment[]) => Promise<SendResult> | SendResult;
	onFollowUp?: (text: string, images: ImageAttachment[]) => Promise<SendResult> | SendResult;
	/** 停止：服务端先清空队列再中止，并返回被清掉的文本，这里把它们放回输入框 */
	onAbort: () => Promise<QueueResult | void> | void;
	onSelectModel: (provider: string, id: string) => void;
	onSelectLevel: (level: string) => void;
	/** 清空队列并返回被清掉的文本（取回编辑 / 丢弃都走它） */
	onClearQueue?: () => Promise<QueueResult | void> | void;
	/** Parent-owned, session-scoped draft. Async work always updates this same target. */
	draft?: ChatDraft;
	initialDraft?: ChatDraft;
	onDraftChange?: (update: ChatDraftUpdate) => void;
	onUploadError?: (message: string) => void;
	onUploadProgress?: (delta: 1 | -1) => void;
	uploadFailure?: string;
	pendingUploadCount?: number;
	pendingSend?: boolean;
	onSendPendingChange?: (pending: boolean) => void;
}) {
	const [localDraft, setLocalDraft] = useState<ChatDraft>(initialDraft ?? EMPTY_CHAT_DRAFT);
	const currentDraft = draft ?? localDraft;
	const draftRef = useRef(currentDraft);
	draftRef.current = currentDraft;
	const changeDraft = (update: ChatDraftUpdate) => {
		const next = typeof update === "function" ? update(draftRef.current) : update;
		draftRef.current = next;
		if (draft === undefined) setLocalDraft(next);
		onDraftChange?.(update);
	};
	const { text, images, uploads } = currentDraft;
	const references = currentDraft.references ?? [];
	const adopted = currentDraft.adopted ?? null;
	const setText = (value: string | ((previous: string) => string)) => changeDraft((previous) => ({ ...previous, text: typeof value === "function" ? value(previous.text) : value }));
	const setAdopted = (value: SlashCommand | null) => changeDraft((previous) => ({ ...previous, adopted: value }));
	const pendingReads = useRef<Promise<void>[]>([]);
	const inFlightUploads = useRef(0);
	const mountedRef = useRef(true);
	const sendingRef = useRef(false);
	const [sending, setSending] = useState(false);
	const [attachmentError, setAttachmentError] = useState("");
	const [uploadCount, setUploadCount] = useState(0);
	const uploadBusy = uploadCount > 0 || pendingUploadCount > 0;
	const sendBusy = sending || pendingSend;
	const [dragActive, setDragActive] = useState(false);
	/** 引用 chip 超过 COLLAPSE_AT 就先折叠：手机上折行会把输入框顶掉（图片的折叠在 ComposerImages 里） */
	const [refsExpanded, setRefsExpanded] = useState(false);
	/** 上传文件超过 4 个时的展开状态（与引用同一套折叠规则） */
	const [uploadsExpanded, setUploadsExpanded] = useState(false);
	const dragDepth = useRef(0);
	const [modelOpen, setModelOpen] = useState(false);
	const [cmdIdx, setCmdIdx] = useState(0);
	const [cmdDismissed, setCmdDismissed] = useState(false);
	// @ 引用：打字触发候选，选中后落成引用 chip（发送时统一拼成 `@路径` 行）
	const [mention, setMention] = useState<{ query: string; start: number; tokenEnd: number } | null>(null);
	const [mentionIdx, setMentionIdx] = useState(0);
	/** 被 Esc 关掉的那个 token（位置 + 原文）；光标在它里面移动不再弹，改了字、或换成别的 token 重新弹 */
	const mentionDismissed = useRef<string | null>(null);
	const mentionMenuRef = useRef<HTMLDivElement>(null);
	const taRef = useRef<HTMLTextAreaElement>(null);
	const wrapRef = useRef<HTMLDivElement>(null);
	const { t } = useI18n();
	const isBlocked = !model?.id;
	const enterBehavior = useEnterBehavior();
	const queuedCount = queue.steering.length + queue.followUp.length;
	const [restoreTick, setRestoreTick] = useState(0);

	useEffect(() => {
		mountedRef.current = true;
		return () => { mountedRef.current = false; };
	}, []);
	useEffect(() => {
		setAttachmentError(uploadFailure ?? "");
	}, [uploadFailure]);
	useEffect(() => {
		autoSize();
	}, [text]);

	// 斜杠命令模式：文本以 / 开头且未输入参数空格
	const slash = text.startsWith("/") ? text.slice(1) : "";
	const hasArgs = slash.includes(" ");
	const typedCommandMode = !!commands?.length && text.startsWith("/") && !cmdDismissed && !hasArgs;
	const filteredCommands = (commands ?? []).filter((c) => c.name.toLowerCase().startsWith(slash.split(" ")[0].toLowerCase()));
	const visibleCommands = filteredCommands;
	const commandMode = typedCommandMode;

	// ---------- @ 引用：输入 @ 弹候选，选中落成引用 chip ----------
	// 候选清单一次拉全量（工作区 git 可见文件），之后每个字符都在本地匹配；规则与 pi 终端的 @ 补全一致（见 workspace-index）。
	const mentionMode = mention !== null;
	const mentionQuery = mention?.query ?? null;
	const files = useWorkspaceFiles(cwd ?? "", mentionMode);
	// 只在候选清单或查询变了时重算：光标移动、其它状态变化引起的重渲染不该每次扫一遍全量清单
	const suggestions = useMemo(
		() => (mentionQuery === null ? [] : suggestPaths(files.candidates, mentionQuery)),
		[files.candidates, mentionQuery],
	);
	const effectiveMentionIdx = Math.min(mentionIdx, Math.max(0, suggestions.length - 1));

	useEffect(() => {
		mentionMenuRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
	}, [mentionIdx, suggestions.length]);

	/**
	 * 文本 / 光标变了就重新判是否在 @ token 里（Esc 关过的同一个 token 不再弹）。
	 * 没有工作区就不弹：没有候选来源，菜单只会空转还拦着方向键和 Esc。
	 */
	const syncMention = (value: string, caret: number | null) => {
		const token = caret === null || !cwd ? null : atToken(value, caret);
		if (!token) {
			// 离开 token 就忘掉 Esc：之后在同一位置打新的 @ 照常弹
			mentionDismissed.current = null;
			setMention(null);
			return;
		}
		if (mentionDismissed.current === `${token.start}:${value.slice(token.start, token.tokenEnd)}`) {
			setMention(null);
			return;
		}
		if (!mention || mention.start !== token.start || mention.query !== token.query) setMentionIdx(0);
		if (!mention || mention.start !== token.start || mention.query !== token.query || mention.tokenEnd !== token.tokenEnd) {
			setMention({ query: token.query, start: token.start, tokenEnd: token.tokenEnd });
		}
	};

	const closeMention = (dismiss: boolean) => {
		if (dismiss && mention) mentionDismissed.current = `${mention.start}:${text.slice(mention.start, mention.tokenEnd)}`;
		setMention(null);
		setMentionIdx(0);
	};

	/** 选中候选：目录引用文件夹本身（要往下钻就继续打 `@src/lib/`），token 从正文里播掉 */
	const applyMention = (candidate: PathCandidate) => {
		if (!mention) return;
		const { start, tokenEnd } = mention;
		// 目录存成 `src/lib/`：chip 靠尾斜杠判断文件夹（去重会把尾斜杠归一化掉）
		const path = candidate.dir ? `${candidate.path}/` : candidate.path;
		changeDraft((previous) => {
			const refs = previous.references ?? [];
			// 目录带尾斜杠、文件不带：去重按去掉尾斜杠比较，
			// 否则「文件面板引用的 src/lib」与「@ 选的 src/lib/」会变成两个 chip
			const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, "") === b.replace(/[\\/]+$/, "");
			return {
				...previous,
				text: previous.text.slice(0, start) + previous.text.slice(tokenEnd),
				references: refs.some((existing) => samePath(existing, path)) ? refs : [...refs, path],
			};
		});
		setMention(null);
		setMentionIdx(0);
		requestAnimationFrame(() => {
			autoSize();
			const ta = taRef.current;
			if (ta) {
				ta.focus();
				ta.setSelectionRange(start, start);
			}
		});
	};
	// 命令菜单滚动：.popover 的 overflow:hidden 会压掉 overflow-y-auto（unlayered CSS 优先），
	// 内联 overflowY 强制可滚；键盘导航时把选中项滚进视野
	const cmdMenuRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		cmdMenuRef.current?.querySelector('button[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
	}, [cmdIdx, visibleCommands.length]);
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
			doSend(undefined, `/${entry.name}${args ? ` ${args}` : ""}`);
			return;
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

	const doSend = (override?: "steer" | "followUp", forcedText?: string) => {
		if (disabled || isBlocked || sendingRef.current || pendingSend || uploadBusy) return;
		sendingRef.current = true;
		setSending(true);
		onSendPendingChange?.(true);
		const raw = (forcedText ?? draftRef.current.text).trim();
		const refs = [...(draftRef.current.references ?? [])];
		const trimmed = adopted ? `/${adopted.name}${raw ? ` ${raw}` : ""}` : raw;
		void (async () => {
			try {
				if (pendingReads.current.length) await Promise.allSettled(pendingReads.current);
				const submitted = draftRef.current;
				const attachments = [...submitted.images];
				const files = [...submitted.uploads];
				if (!trimmed && attachments.length === 0 && files.length === 0 && refs.length === 0) return;
				if (trimmed.startsWith("/") && attachments.length === 0 && files.length === 0 && refs.length === 0) {
					const [head, ...rest] = trimmed.slice(1).split(/\s+/);
					const builtin = (commands ?? []).find((c) => c.kind === "builtin" && c.name.toLowerCase() === head.toLowerCase());
					if (builtin) {
						if (builtin.name === "model") setModelOpen(true);
						else onCommand?.(builtin.name, rest.join(" "));
						changeDraft((previous) => ({ ...previous, text: "", adopted: null }));
						setCmdDismissed(false);
						return;
					}
				}
				// 引用 chip 在发送时拼成 @路径 行(和 pi 的 @ 语法一致),显示与正文分开互不干扰
				const compose = (base: string) => {
					const parts = [base];
					if (refs.length) parts.push(refs.map((path) => `@${path}`).join("\n"));
					if (files.length) parts.push(files.map((f) => t.attachmentLine.replace("{path}", f.path).replace("{size}", fmtUploadSize(f.size))).join("\n"));
					return parts.filter(Boolean).join("\n\n");
				};
				let result: SendResult;
				if (isStreaming) {
					const mode = override ?? (enterBehavior === "steer" ? "steer" : "followUp");
					if (mode === "followUp" && onFollowUp) result = await onFollowUp(compose(trimmed), attachments);
					else result = await onSteer(compose(trimmed), attachments);
				} else result = await onSend(compose(trimmed), attachments);
				if (!result?.success) {
					if (forcedText) setText(forcedText);
					if (result?.error && mountedRef.current) setAttachmentError(result.error);
					return;
				}
				// Acceptance, not completion of streaming, releases the composer. Only remove
				// this submitted snapshot, including after unmount/session migration.
				changeDraft((previous) => ({
					...previous,
					text: previous.text === submitted.text ? "" : previous.text,
					adopted: previous.adopted === submitted.adopted ? null : previous.adopted,
					images: previous.images.filter((image) => !attachments.includes(image)),
					uploads: previous.uploads.filter((file) => !files.some((sent) => sent.path === file.path)),
					references: (previous.references ?? []).filter((path) => !refs.includes(path)),
				}));
			} catch (error) {
				if (forcedText) setText(forcedText);
				if (mountedRef.current) setAttachmentError(error instanceof Error ? error.message : String(error));
			} finally {
				sendingRef.current = false;
				onSendPendingChange?.(false);
				if (mountedRef.current) setSending(false);
			}
		})();
	};

	/** 把服务端清出来的排队文本放回输入框（接在已有草稿前面；pi 终端 Esc / Alt+Up、Claude Code ↑ 同款） */
	const restoreQueued = (r: QueueResult | void) => {
		const texts = [...(r?.data?.steering ?? []), ...(r?.data?.followUp ?? [])];
		if (!texts.length) return;
		setText((prev) => [texts.join("\n\n"), prev].filter((s) => s.trim()).join("\n\n"));
		setCmdDismissed(true);
		setRestoreTick((n) => n + 1);
	};
	useEffect(() => {
		if (!restoreTick) return;
		autoSize();
		taRef.current?.focus();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [restoreTick]);
	const stopAndRestore = async () => restoreQueued(await onAbort());
	const pullQueue = async () => restoreQueued(await onClearQueue?.());

	const pickFiles = (files: FileList | File[] | null) => {
		if (!files || disabled || isBlocked || sendingRef.current || pendingSend) return;
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
							const image: ImageAttachment = { type: "image", data: dataUrl.slice(dataUrl.indexOf(",") + 1), mimeType: f.type };
							changeDraft((previous) => previous.images.length >= 20 ? previous : { ...previous, images: [...previous.images, image] });
							resolve();
						};
						reader.onerror = () => resolve();
						reader.onabort = () => resolve();
						reader.readAsDataURL(f);
					});
					pendingReads.current.push(read);
					void read.finally(() => { pendingReads.current = pendingReads.current.filter((pending) => pending !== read); });
				} else {
					void uploadFile(f);
				}
		}
	};

	const uploadFile = async (f: File): Promise<boolean> => {
		if (f.size > 100 * 1024 * 1024) {
			setAttachmentError(t.uploadTooLarge);
			return false;
		}
		if (draftRef.current.uploads.length + Math.max(inFlightUploads.current, pendingUploadCount) >= MAX_UPLOAD_FILES) {
			setAttachmentError(t.uploadCountLimit);
			return false;
		}
		inFlightUploads.current += 1;
		onUploadProgress?.(1);
		setUploadCount((count) => count + 1);
		setAttachmentError("");
		try {
			const r = await fetch(`/api/files?action=upload&name=${encodeURIComponent(f.name)}`, {
				method: "POST",
				headers: { "Content-Type": "application/octet-stream", "x-upload-size": String(f.size) },
				body: f,
			});
			const j = await r.json();
			if (!r.ok || !j.success) throw new Error(j.error || "upload failed");
			if (j.data?.size !== f.size) throw new Error("upload size mismatch");
			const uploaded = { name: j.data.name, path: j.data.path, size: j.data.size };
			changeDraft((previous) => previous.uploads.some((file) => file.path === uploaded.path)
				? previous
				: { ...previous, uploads: [...previous.uploads, uploaded] });
			return true;
		} catch (e) {
			const message = `${t.uploadFailed}：${e instanceof Error ? e.message : String(e)}`;
			onUploadError?.(message);
			if (mountedRef.current) setAttachmentError(message);
			return false;
		} finally {
			inFlightUploads.current -= 1;
			onUploadProgress?.(-1);
			if (mountedRef.current) setUploadCount((count) => Math.max(0, count - 1));
		}
	};

	const pickFilesRef = useRef(pickFiles);
	pickFilesRef.current = pickFiles;
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
				pickFilesRef.current(e.dataTransfer.files);
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

	const hasDraft = text.trim().length > 0 || images.length > 0 || uploads.length > 0 || references.length > 0;

	return (
		<div ref={wrapRef} className="relative w-full" data-testid="composer">
			{/* 排队中的消息（Claude Code 同款：列在输入卡上方；↑ 取回编辑，或直接丢弃） */}
			{queuedCount > 0 && (
				<div className="pw-queue">
					{queue.steering.map((q, i) => (
						<div key={`s${i}`} className="pw-queue-row" title={q}>
							<span className="pw-queue-tag">{t.modeSteer}</span>
							<span className="pw-queue-text">{q}</span>
						</div>
					))}
					{queue.followUp.map((q, i) => (
						<div key={`f${i}`} className="pw-queue-row" title={q}>
							<span className="pw-queue-tag">{t.modeQueue}</span>
							<span className="pw-queue-text">{q}</span>
						</div>
					))}
					<div className="pw-queue-foot">
						<button type="button" onClick={() => void pullQueue()}>{t.queueEdit}</button>
						<button type="button" onClick={() => void onClearQueue?.()}>{t.queueDrop}</button>
					</div>
				</div>
			)}
			{attachmentError && (
				<div className="mb-2 px-2" role="alert" style={{ fontSize: 12, color: "var(--dsw-danger)" }}>
					{attachmentError}
				</div>
			)}
			{/* @ 引用候选（与斜杠菜单同一处锚点：输入卡上方） */}
			{mentionMode && (
				<div
					ref={mentionMenuRef}
					data-testid="mention-menu"
					className="popover absolute bottom-full left-0 right-0 z-50 mb-2 max-h-[340px] overflow-y-auto py-1.5"
					role="listbox"
					aria-label={t.mentionFiles}
					style={{ overflowY: "auto" }}
				>
					<div className="flex items-center gap-2 px-4 pb-1 pt-1" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>
						<span>{t.mentionFiles}</span>
						{files.truncated && <span style={{ color: "var(--dsw-warn)" }}>{t.mentionTruncated}</span>}
						{files.source === "disk" && <span title={t.mentionDiskSourceHint}>{t.mentionDiskSource}</span>}
						<span className="flex-1" />
						<span>{t.mentionHint}</span>
					</div>
					{files.status === "loading" && (
						<div className="px-4 py-2" style={{ fontSize: 12.5, color: "var(--dsw-label-caption)" }}>{t.panelLoading}</div>
					)}
					{files.status === "error" && (
						<div className="px-4 py-2" style={{ fontSize: 12.5, color: "var(--dsw-danger)" }} role="alert">{files.error}</div>
					)}
					{files.status === "ready" && suggestions.length === 0 && (
						<div className="px-4 py-2" style={{ fontSize: 12.5, color: "var(--dsw-label-caption)" }}>{t.mentionNoMatch}</div>
					)}
					{suggestions.map(({ candidate, label, description }, i) => (
						<button
							key={`${candidate.dir ? "d" : "f"}:${candidate.path}`}
							type="button"
							role="option"
							aria-selected={i === effectiveMentionIdx}
							data-active={i === effectiveMentionIdx ? "true" : undefined}
							className="isx-menu-item mx-1.5 flex w-[calc(100%-12px)] items-center gap-2 px-3 py-1.5 text-left"
							onMouseEnter={() => setMentionIdx(i)}
							onClick={() => applyMention(candidate)}
							title={candidateText(candidate)}
						>
							<span className="isx-menu-icon" style={{ display: "inline-flex", flex: "none" }}>
								{candidate.dir ? (
									<IconFolderClose16 size={13} style={{ flex: "none", color: "var(--dsw-warn)" }} />
								) : (
									<IconFileOutline16 size={13} style={{ flex: "none", color: "var(--dsw-label-caption)" }} />
								)}
							</span>
							{/* 和 pi 终端一样：名字在前，路径在后；根目录下的条目两者相同，不重复显示 */}
							<span className="isx-menu-shift flex-none truncate" style={{ maxWidth: "55%", fontSize: 12.5, fontFamily: "var(--font-mono)" }}>
								{label}
							</span>
							{description.replace(/\/$/, "") !== label.replace(/\/$/, "") && (
								<span className="isx-menu-sub min-w-0 flex-1 truncate pr-2" style={{ fontSize: 11.5, fontFamily: "var(--font-mono)", color: "var(--dsw-label-caption)" }}>
									{description}
								</span>
							)}
						</button>
					))}
				</div>
			)}

			{/* 斜杠命令菜单（dsh：悬浮于输入卡上方，同宽） */}
			{commandMode && visibleCommands.length > 0 && (
				<div ref={cmdMenuRef} className="popover absolute bottom-full left-0 right-0 z-50 mb-2 max-h-[340px] overflow-y-auto py-1.5" role="listbox" aria-label={t.slashCatalog} style={{ overflowY: "auto" }}>
					<div className="px-4 pb-1 pt-1" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>
						{t.slashCatalog}
					</div>
					{visibleCommands.map((c, i) => (
						<button
							key={`${c.kind}:${c.name}`}
							role="option"
							aria-selected={i === effectiveIdx}
							data-active={i === effectiveIdx ? "true" : undefined}
							className="isx-menu-item mx-1.5 flex w-[calc(100%-12px)] items-baseline gap-3 px-3 py-2 text-left"
							onMouseEnter={() => setCmdIdx(i)}
							onClick={() => runEntry(c)}
						>
							<span className="isx-menu-shift" style={{ fontSize: 14, fontWeight: 500, flex: "none" }}>{c.name}</span>
							{c.kind !== "builtin" && (
								<span className="isx-menu-sub rounded px-1.5 py-0.5" style={{ fontSize: 10.5, color: "var(--dsw-label-caption)", background: "var(--dsw-selector)", flex: "none" }}>
									{c.kind === "skill" ? t.skillType : c.kind === "template" ? t.promptType : t.extensionCmdType}
								</span>
							)}
							{c.argumentHint && (
								<span className="isx-menu-sub" style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--dsw-label-caption)", flex: "none" }}>{c.argumentHint}</span>
							)}
							<span className="isx-menu-sub truncate pr-2" style={{ fontSize: 13, color: "var(--dsw-label-tertiary)" }}>
								{c.desc}
							</span>
						</button>
					))}
				</div>
			)}

			{/*
			 * 附件轨（图片 / 引用 / 上传文件）：绝对定位浮在输入卡上方，**不占布局高度** ——
			 * 输入框位置不动，多出来的附件直接盖住后面的聊天记录（用户要的就是这个）。
			 * 外层 pointer-events-none，只有附件本身接收点击，免得挡住聊天区的交互。
			 */}
			<div className="pointer-events-none absolute inset-x-0 bottom-full z-20 flex flex-col gap-1.5 pb-2" data-testid="composer-attachments">
			{/* 附件轨：图片（超过 4 张折叠成牌堆，展开沿弧线扇开；点开可放大、切换、删除） */}
			{images.length > 0 && (
				<ComposerImages
					images={images}
					disabled={sendBusy}
					onRemove={(index) => changeDraft((previous) => ({ ...previous, images: previous.images.filter((_, at) => at !== index) }))}
					onClear={() => changeDraft((previous) => ({ ...previous, images: [] }))}
				/>
			)}

			{/* 路径引用(项目结构图/文件面板的「引用到输入框」):独立于正文,发送时拼成 @路径 */}
			{references.length > 0 && (
				<div className="pointer-events-auto flex flex-wrap gap-1 px-1" data-testid="composer-references">
					{(refsExpanded ? references : references.slice(0, COLLAPSE_AT)).map((path, i) => {
						const chip = referenceChipOf(path);
						return (
							<span
								key={path}
								className="pw-ref-chip group/ref"
								title={path}
								/* 与图片卡组同一套时序：从左往右错开浮上来，收起反向；不旋转（带文字转着读着累） */
								style={{ animationDelay: `${Math.min(i * 14, 140)}ms` }}
							>
								{chip.dir ? (
									<IconFolderClose16 size={12} style={{ flex: "none", color: "var(--dsw-warn)" }} />
								) : (
									<IconFileOutline16 size={12} style={{ flex: "none", color: "var(--dsw-accent)" }} />
								)}
								<span className="truncate">{chip.text}</span>
								<button
									type="button"
									className="pw-ref-close"
									disabled={sendBusy}
									onClick={() => changeDraft((previous) => ({ ...previous, references: (previous.references ?? []).filter((p) => p !== path) }))}
									aria-label={`${t.delete} ${path}`}
								>
									✕
								</button>
							</span>
						);
					})}
					{references.length > COLLAPSE_AT ? (
						<button type="button" className="pw-chip" data-testid="references-toggle" onClick={() => setRefsExpanded((open) => !open)}>
							{refsExpanded ? t.chipCollapse : t.chipExpandMore.replace("{n}", String(references.length - COLLAPSE_AT))}
						</button>
					) : null}
				</div>
			)}

			{/* 附件轨：上传的普通文件（压缩包/文档等，路径引用）；超过 4 个折叠 */}
			{uploads.length > 0 && (
				<div className="pointer-events-auto flex flex-wrap items-center gap-1 px-1" data-testid="composer-uploads">
					{(uploadsExpanded ? uploads : uploads.slice(0, COLLAPSE_AT)).map((f, i) => (
						<span key={f.path} className="pw-ref-chip group/ref" title={f.path}>
							<IconFileOutline16 size={12} style={{ flex: "none", color: "var(--dsw-label-tertiary)" }} />
							<span className="max-w-[180px] truncate">{f.name}</span>
							<span style={{ flex: "none", fontSize: 11, color: "var(--dsw-label-caption)" }}>{fmtUploadSize(f.size)}</span>
							<button
								type="button"
								className="pw-ref-close"
								disabled={sendBusy}
								onClick={() => changeDraft((previous) => ({ ...previous, uploads: previous.uploads.filter((_, index) => index !== i) }))}
								aria-label={`${t.delete} ${f.name}`}
							>
								✕
							</button>
						</span>
					))}
					{uploads.length > COLLAPSE_AT ? (
						<button type="button" className="pw-chip" data-testid="uploads-toggle" onClick={() => setUploadsExpanded((open) => !open)}>
							{uploadsExpanded ? t.chipCollapse : t.chipExpandMore.replace("{n}", String(uploads.length - COLLAPSE_AT))}
						</button>
					) : null}
				</div>
			)}

			</div>

			{/* 卡片（Iconsax .isx-composer：24px 圆角 + 聚焦高对比描边 + 底部流光短横条）—— 拖放由 document 级监听统一接管 */}
			<div className="isx-composer relative w-full">
				<div className="px-4 pt-3 flex items-start gap-1.5">
					{adopted && (
						<button
							type="button"
							className="flex-none flex items-center gap-1 self-start"
							title={`${t.delete} (Backspace)`}
							style={{
								fontSize: "var(--piweb-chat-font-size, var(--dsh-content-font-size))",
								lineHeight: "var(--piweb-chat-line-height, 1.55)",
								padding: 0,
								background: "transparent",
								border: "none",
								color: "var(--dsw-label-primary)",
							}}
							onClick={() => {
								setAdopted(null);
								requestAnimationFrame(() => taRef.current?.focus());
							}}
						>
							<IconTerminalOutline14 size={14} style={{ color: "var(--dsw-accent)", flex: "none" }} />
							<span style={{ color: "var(--dsw-accent)", fontWeight: 600 }}>/{adopted.name}</span>
						</button>
					)}
					<textarea
						ref={taRef}
						value={text}
						disabled={disabled || isBlocked || sendBusy}
						rows={1}
						placeholder={adopted ? (adopted.argumentHint ?? t.inputPlaceholder) : !disabled && isBlocked ? t.blockedComposer : t.inputPlaceholder}
						suppressHydrationWarning
						className="min-w-0 flex-1 resize-none"
						style={{ fontSize: "var(--piweb-chat-font-size, var(--dsh-content-font-size))", lineHeight: 1.55 }}
						onChange={(e) => {
							const value = e.target.value;
							setText(value);
							setCmdDismissed(false);
							setCmdIdx(0);
							syncMention(value, e.target.selectionStart);
							autoSize();
						}}
						onSelect={(e) => {
							// 选中了一段文字时不弹：那时 Enter / Tab 应该照常工作
							const ta = e.target as HTMLTextAreaElement;
							syncMention(ta.value, ta.selectionStart === ta.selectionEnd ? ta.selectionStart : null);
						}}
						onPaste={(e) => {
							const files = Array.from(e.clipboardData.files);
							if (files.length) {
								e.preventDefault();
								pickFiles(e.clipboardData.files);
							}
						}}
						onKeyDown={(e) => {
							// 输入法组字时的按键归输入法（Esc 取消组字、↑↓ 选字、Enter 上屏），一律不当候选操作
							if (mentionMode && !e.nativeEvent.isComposing) {
								// 候选开着时优先于发送：Esc 关掉、↑↓ 选、Enter / Tab 采纳。
								// 没有候选时不拦 Enter——`@某人` 这种不成候选的文字要能直接发出去。
								if (e.key === "Escape") {
									e.preventDefault();
									closeMention(true);
									return;
								}
								if (suggestions.length > 0) {
									if (e.key === "ArrowDown") {
										e.preventDefault();
										setMentionIdx((i) => Math.min(i + 1, suggestions.length - 1));
										return;
									}
									if (e.key === "ArrowUp") {
										e.preventDefault();
										setMentionIdx((i) => Math.max(i - 1, 0));
										return;
									}
									if (e.key === "Enter" || e.key === "Tab") {
										e.preventDefault();
										const picked = suggestions[effectiveMentionIdx];
										if (picked) applyMention(picked.candidate);
										return;
									}
								}
							}
							if (adopted && text === "" && (e.key === "Backspace" || e.key === "Escape")) {
								// 空参数时退格/Esc：摘掉命令胶囊
								e.preventDefault();
								setAdopted(null);
								return;
							}
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
								if (e.key === "Tab") {
									// 采纳：把命令渲染成胶囊留在输入框，参数接着补（对齐其他 Agent 平台）
									e.preventDefault();
									const entry = visibleCommands[effectiveIdx];
									if (!entry) return;
									setAdopted(entry);
									setText("");
									setCmdIdx(0);
									requestAnimationFrame(() => {
										autoSize();
										taRef.current?.focus();
									});
									return;
								}
							}
							if (e.key === "ArrowUp" && text === "" && queuedCount > 0) {
								e.preventDefault();
								void pullQueue();
								return;
							}
							if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
								e.preventDefault();
								// Ctrl / ⌘ + Enter：用设置之外的另一种方式发（只在运行中有区别）
								const alt = e.ctrlKey || e.metaKey;
								doSend(isStreaming && alt ? (otherBehavior(enterBehavior) === "steer" ? "steer" : "followUp") : undefined);
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
					<div className="flex-1" />

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
							model={model}
							source={contextSource}
						/>
					)}

					{/* 停止 / 发送圆钮：运行中没草稿 → 停止；运行中有草稿 → 幽灵停止钮 + 发送（发送即按设置插话 / 排队） */}
					{isStreaming && !hasDraft ? (
						<button className="btn-primary-circle" title={t.stop} onClick={() => void stopAndRestore()}>
							<IconStopFill16 size={16} />
						</button>
					) : (
						<>
							{isStreaming && (
								<button className="btn-ghost-circle" title={t.stop} onClick={() => void stopAndRestore()}>
									<IconStopFill16 size={14} />
								</button>
							)}
							<button
								className="btn-primary-circle"
								title={isStreaming ? (enterBehavior === "steer" ? t.sendSteer : t.sendQueue) : t.send}
								disabled={!hasDraft || disabled || isBlocked || sendBusy || uploadBusy}
								onClick={() => doSend()}
							>
								<IconSendArrowUp14 size={16} />
							</button>
						</>
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
	return fmtBytes(bytes).replace(/ /g, "");
}

/**
 * 引用 chip 上显示的短标签。只取 basename 会分不清两件事：目录与同名文件
 * （`src/lib` 与 `src/lib.ts` 都显示 `lib`；`a/index.ts` 与 `b/index.ts` 都显示 `index.ts`）。
 * 规则：目录带尾斜杠（`lib/`，配文件夹图标）；其余最多保留**尾部两段**
 * （`src/lib/index.ts` → `…/lib/index.ts`）。完整路径仍在 title 里。
 */
function referenceChipOf(path: string): { text: string; dir: boolean } {
	const dir = /[\\/]$/.test(path);
	const parts = path.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean);
	if (!parts.length) return { text: path, dir };
	const tail = parts.slice(-2).join("/");
	return { text: dir ? `${tail}/` : parts.length > 2 ? `…/${tail}` : tail, dir };
}
