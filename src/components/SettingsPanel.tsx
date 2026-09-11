"use client";

/**
 * 设置弹窗（对齐 dsh SettingsRoot）：居中模态、左导航 + 右侧行式内容。
 * 五节：General / Models / 安全 / 技能 / 插件。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	IconAgentPresetOutline16,
	IconChevronDown14,
	IconCheckOutline14,
	IconCloseOutline14,
	IconCopyOutline16,
	IconDownloadOutline16,
	IconModelOutline16,
	IconPluginOutline16,
	IconPlusOutline16,
	IconRefreshOutline14,
	IconSearchOutline16,
	IconSettingsOutline16,
	IconShieldOutline16,
	IconSkillOutline16,
	IconTrashOutline16,
} from "@/components/icons";
import { ProviderBrand } from "@/components/ProviderBrand";
import {
	ModelCatalog,
	ProviderSetupModal,
	serializeModelDraft,
	type ModelDraft,
	validateModelDrafts,
	type BuiltinProviderSetup,
	type CustomProviderSetup,
} from "@/components/ProviderSetupModal";
import { useI18n } from "@/i18n";
import { applyPebrelTheme, loadPebrelTheme, loadThemeMode, type PebrelTheme, type ThemeMode } from "@/lib/theme";
import type { ProviderView } from "@/lib/models-service";
import type { ToolPreset } from "@/lib/types";

type Section = "general" | "models" | "tools" | "skills" | "plugins";

export function SettingsPanel({
	open,
	onClose,
	cwd,
	toolPreset,
	onToolPresetChange,
	tools,
	onSetTools,
}: {
	open: boolean;
	onClose: () => void;
	cwd: string;
	toolPreset: ToolPreset;
	onToolPresetChange: (preset: ToolPreset) => void;
	/** 当前会话的工具状态（快照数据；无会话时为 null） */
	tools?: { active: string[]; all: { name: string; description?: string }[] } | null;
	/** 逐个启停当前会话的工具（写回 setActiveTools） */
	onSetTools?: (names: string[]) => void;
}) {
	const { t, lang, setLang } = useI18n();
	const [section, setSection] = useState<Section>("general");

	useEffect(() => {
		if (!open) return;
		const h = (e: KeyboardEvent) => {
			if (e.key === "Escape" && !document.querySelector('[data-provider-modal="true"]')) onClose();
		};
		document.addEventListener("keydown", h);
		return () => document.removeEventListener("keydown", h);
	}, [open, onClose]);

	if (!open) return null;

	const navItems: { id: Section; label: string; icon: React.ReactNode }[] = [
		{ id: "general", label: t.setGeneral, icon: <IconSettingsOutline16 size={15} /> },
		{ id: "models", label: t.setModels, icon: <IconModelOutline16 size={15} /> },
		{ id: "tools", label: t.toolsSection, icon: <IconAgentPresetOutline16 size={15} /> },
		{ id: "plugins", label: t.setPlugins, icon: <IconPluginOutline16 size={15} /> },
		{ id: "skills", label: t.setSkills, icon: <IconSkillOutline16 size={15} /> },
	];

	return (
		<div
			className="modal-mask fixed inset-0 z-[100] flex items-center justify-center"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				className="settings-dialog glass-modal flex overflow-hidden"
				style={{
					width: 800,
					maxWidth: "calc(100vw - 48px)",
					height: "min(800px, calc(100vh - 48px))",
					borderRadius: 32,
					boxShadow: "var(--dsw-elevation-prominent)",
				}}
			>
				{/* 左导航（dsh trigger：h42 r12，active 填充） */}
				<div className="settings-nav flex w-52 flex-none flex-col gap-0.5 py-4 pl-4 pr-3">
					<div className="settings-title px-2 pb-3" style={{ fontSize: 16, fontWeight: 500 }}>
						{t.settings}
					</div>
					{navItems.map((n) => (
						<button
							key={n.id}
							className="flex h-[42px] items-center gap-2 rounded-xl px-3 text-left transition-colors"
							style={{
								paddingLeft: 8,
								paddingRight: 10,
								fontSize: 14,
								background: section === n.id ? "var(--dsw-active)" : "transparent",
								color: section === n.id ? "var(--dsw-label-primary)" : "var(--dsw-label-secondary)",
							}}
							onMouseEnter={(e) => {
								if (section !== n.id) e.currentTarget.style.background = "var(--dsw-hover)";
							}}
							onMouseLeave={(e) => {
								if (section !== n.id) e.currentTarget.style.background = "transparent";
							}}
							onClick={() => setSection(n.id)}
						>
							{section === n.id ? <span style={{ color: "var(--dsw-accent)" }}>{n.icon}</span> : n.icon}
							{n.label}
						</button>
					))}
				</div>

				{/* 右侧内容 */}
				<div className="flex min-w-0 flex-1 flex-col">
					<div className="flex items-center gap-2 px-6 py-3.5">
						<div className="flex-1" />
						<button className="btn-outline" style={{ height: 32, fontSize: 13 }} onClick={() => window.open("/api/config", "_blank")}>
							<IconDownloadOutline16 size={14} /> {t.openConfigFile}
						</button>
						<button className="icon-btn" onClick={onClose}>
							<IconCloseOutline14 size={15} />
						</button>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
						{section === "general" && <GeneralSection lang={lang} setLang={setLang} />}
						{section === "models" && <ModelsSection />}
						{section === "skills" && <SkillsSection cwd={cwd} />}
						{section === "tools" && <ToolsSection toolPreset={toolPreset} onToolPresetChange={onToolPresetChange} tools={tools} onSetTools={onSetTools} />}
						{section === "plugins" && <PluginsSection cwd={cwd} />}
					</div>
				</div>
			</div>
		</div>
	);
}

// ---------- General ----------

function GeneralSection({
	lang,
	setLang,
}: {
	lang: "zh" | "en";
	setLang: (l: "zh" | "en") => void;
}) {
	const { t } = useI18n();
	const [theme, setTheme] = useState<PebrelTheme>("dsh");
	const [themeMode, setThemeMode] = useState<ThemeMode>("system");
	const [fontSize, setFontSize] = useState(14);
	const [chatFontSize, setChatFontSize] = useState(14);
	const [enterBehavior, setEnterBehavior] = useState<"queue" | "steer">("queue");
	const [trust, setTrust] = useState<"ask" | "always" | "never">("ask");
	const [piSettings, setPiSettings] = useState<{ compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number }; retry: { enabled: boolean; maxRetries: number; baseDelayMs: number } } | null>(null);

	useEffect(() => {
		setTheme(loadPebrelTheme());
		setThemeMode(loadThemeMode());
		const fs = parseInt(localStorage.getItem("piweb.fontSize") ?? "14", 10);
		if (!Number.isNaN(fs)) setFontSize(fs);
		const chatFs = parseInt(localStorage.getItem("piweb.chatFontSize") ?? "14", 10);
		if (!Number.isNaN(chatFs)) setChatFontSize(chatFs);
		const eb = localStorage.getItem("piweb.enterBehavior");
		if (eb === "steer" || eb === "queue") setEnterBehavior(eb);
		void (async () => {
			const r = await fetch("/api/security");
			const j = await r.json();
			if (j.success) setTrust(j.data.defaultProjectTrust);
			const r2 = await fetch("/api/pi-settings");
			const j2 = await r2.json();
			if (j2.success) setPiSettings(j2.data);
		})();
	}, []);

	const pickTheme = (p: PebrelTheme) => {
		setTheme(p);
		applyPebrelTheme(p, themeMode);
	};

	/** dsh 亮暗三选一（light / dark / system），与配色主题独立 */
	const pickThemeMode = (m: ThemeMode) => {
		setThemeMode(m);
		applyPebrelTheme(theme, m);
	};

	/** 界面字号：body/导航/标签等（与 theme.ts applyFontSize 同一套变量，改完即生效并持久化） */
	const pickFont = (n: number) => {
		const v = Math.max(12, Math.min(18, n));
		setFontSize(v);
		localStorage.setItem("piweb.fontSize", String(v));
		document.documentElement.style.setProperty("--dsh-content-font-size", `${v}px`);
		document.documentElement.style.setProperty("--dsh-content-font-delta", `${v - 14}px`);
	};

	/** 对话字号：消息正文/用户气泡/输入框 */
	const pickChatFont = (n: number) => {
		const v = Math.max(12, Math.min(20, n));
		setChatFontSize(v);
		localStorage.setItem("piweb.chatFontSize", String(v));
		document.documentElement.style.setProperty("--piweb-chat-font-size", `${v}px`);
	};

	const pickEnter = (v: "queue" | "steer") => {
		setEnterBehavior(v);
		localStorage.setItem("piweb.enterBehavior", v);
	};

	const patchPiSettings = async (patch: Record<string, unknown>) => {
		const r = await fetch("/api/pi-settings", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(patch),
		});
		const j = await r.json();
		if (j.success) setPiSettings(j.data);
	};

	const pickTrust = async (v: "ask" | "always" | "never") => {
		setTrust(v);
		await fetch("/api/security", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ defaultProjectTrust: v }),
		});
	};

	const themes: { id: PebrelTheme; label: string; light: string; dark: string; accent: string }[] = [
		{ id: "dsh", label: t.themeDsh, light: "#F9FAFB", dark: "#151517", accent: "#4176E6" },
		{ id: "silver-steel", label: t.themeSilverSteel, light: "#F3F4F6", dark: "#1A1C24", accent: "#94A3B8" },
		{ id: "limestone-coal", label: t.themeLimestoneCoal, light: "#F0EFEB", dark: "#171717", accent: "#CEB27E" },
		{ id: "linen-moss", label: t.themeLinenMoss, light: "#F2F2EC", dark: "#1E211E", accent: "#A3B3A3" },
		{ id: "nord-paper", label: t.themeNordPaper, light: "#FCFBF9", dark: "#2E3440", accent: "#88C0D0" },
		{ id: "pebrel", label: t.themePebrel, light: "#F3F4F6", dark: "#0F111A", accent: "#52A8FF" },
	];

	return (
		<div className="flex flex-col gap-6">
			<Row title={t.language}>
				<SelectOption
				value={lang}
				options={[
					{ value: "zh", label: "中文" },
					{ value: "en", label: "English" },
				]}
				onChange={(v) => setLang(v as "zh" | "en")}
			/>
			</Row>
			<RowColumn title={t.appearance}>
				<div className="flex w-full flex-wrap gap-2">
					{themes.map((th) => (
						<button
							key={th.id}
							className="flex flex-col items-center justify-center gap-1 transition-colors"
							style={{
								flex: "1 1 150px",
								padding: "20px 32px",
								borderRadius: 20,
								border: `0.5px solid ${theme === th.id ? "var(--dsw-border-strong)" : "var(--dsw-border-l4)"}`,
								background: theme === th.id ? "var(--dsw-module-platform)" : "transparent",
								color: "var(--dsw-label-primary)",
								fontSize: 14,
								lineHeight: "22px",
							}}
							aria-pressed={theme === th.id}
							onClick={() => pickTheme(th.id)}
						>
							<span className="flex items-center overflow-hidden rounded-md" style={{ border: "0.5px solid var(--dsw-border-l3)", width: 42, height: 20 }}>
								<span style={{ background: th.light, flex: 1, height: "100%" }} />
								<span style={{ background: th.dark, flex: 1, height: "100%" }} />
							</span>
							<span className="flex items-center gap-1.5">
								<span className="inline-block rounded-full" style={{ width: 8, height: 8, background: th.accent }} />
								{th.label}
							</span>
						</button>
					))}
				</div>
			</RowColumn>
			<RowColumn title={t.appearanceMode}>
				<div className="flex w-full flex-wrap gap-2">
					{([
						{ id: "light", label: t.themeLight },
						{ id: "dark", label: t.themeDark },
						{ id: "system", label: t.themeSystem },
					] as { id: ThemeMode; label: string }[]).map((mode) => (
						<button
							key={mode.id}
							className="flex flex-col items-center justify-center gap-1 transition-colors"
							style={{
								flex: "1 1 120px",
								padding: "16px 24px",
								borderRadius: 20,
								border: `0.5px solid ${themeMode === mode.id ? "var(--dsw-border-strong)" : "var(--dsw-border-l4)"}`,
								background: themeMode === mode.id ? "var(--dsw-module-platform)" : "transparent",
								color: "var(--dsw-label-primary)",
								fontSize: 14,
								lineHeight: "22px",
							}}
							aria-pressed={themeMode === mode.id}
							onClick={() => pickThemeMode(mode.id)}
						>
							{mode.label}
						</button>
					))}
				</div>
			</RowColumn>
			<Row title={t.fontUiSize} desc={t.fontUiSizeDesc}>
				<FontSizeStepper value={fontSize} onChange={pickFont} max={18} />
			</Row>
			<Row title={t.fontChatSize} desc={t.fontChatSizeDesc}>
				<FontSizeStepper value={chatFontSize} onChange={pickChatFont} max={20} />
			</Row>
			<Row title={t.enterBehavior} desc={t.enterBehaviorDesc}>
				<SelectOption
				value={enterBehavior}
				options={[
					{ value: "queue", label: t.enterQueue },
					{ value: "steer", label: t.enterSteer },
				]}
				onChange={(v) => pickEnter(v as "queue" | "steer")}
			/>
			</Row>
			<Row title={t.autoCompact} desc={t.autoCompactDesc}>
				<div className="flex items-center gap-2">
					<button className="relative h-5 w-9 flex-none rounded-full transition-colors" style={{ background: piSettings?.compaction.enabled ? "var(--dsw-accent)" : "var(--dsw-border-l3)" }} role="switch" aria-checked={piSettings?.compaction.enabled ?? true} onClick={() => patchPiSettings({ compaction: { enabled: !(piSettings?.compaction.enabled ?? true) } })}>
						<span className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all" style={{ left: piSettings?.compaction.enabled ? 18 : 2 }} />
					</button>
					<input type="number" value={piSettings?.compaction.reserveTokens ?? 16384} onChange={(e) => patchPiSettings({ compaction: { reserveTokens: Number(e.target.value) || 0 } })} className="rounded-lg px-2 py-1" title={t.reserveTokens} style={{ width: 90, textAlign: "right", background: "var(--dsw-hover)" }} />
					<input type="number" value={piSettings?.compaction.keepRecentTokens ?? 20000} onChange={(e) => patchPiSettings({ compaction: { keepRecentTokens: Number(e.target.value) || 0 } })} className="rounded-lg px-2 py-1" title={t.keepRecentTokens} style={{ width: 90, textAlign: "right", background: "var(--dsw-hover)" }} />
				</div>
			</Row>
			<Row title={t.autoRetry} desc={t.autoRetryDesc}>
				<div className="flex items-center gap-2">
					<button className="relative h-5 w-9 flex-none rounded-full transition-colors" style={{ background: piSettings?.retry.enabled ? "var(--dsw-accent)" : "var(--dsw-border-l3)" }} role="switch" aria-checked={piSettings?.retry.enabled ?? true} onClick={() => patchPiSettings({ retry: { enabled: !(piSettings?.retry.enabled ?? true) } })}>
						<span className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all" style={{ left: piSettings?.retry.enabled ? 18 : 2 }} />
					</button>
					<input type="number" value={piSettings?.retry.maxRetries ?? 3} onChange={(e) => patchPiSettings({ retry: { maxRetries: Number(e.target.value) || 0 } })} className="rounded-lg px-2 py-1" title={t.maxRetries} style={{ width: 90, textAlign: "right", background: "var(--dsw-hover)" }} />
					<input type="number" value={piSettings?.retry.baseDelayMs ?? 2000} onChange={(e) => patchPiSettings({ retry: { baseDelayMs: Number(e.target.value) || 0 } })} className="rounded-lg px-2 py-1" title={t.baseDelayMs} style={{ width: 90, textAlign: "right", background: "var(--dsw-hover)" }} />
				</div>
			</Row>
			<Row title={t.securityTrust} desc={t.securityTrustDesc}>
				<SelectOption
				value={trust}
				options={[
					{ value: "ask", label: t.trustAsk },
					{ value: "always", label: t.trustAlways },
					{ value: "never", label: t.trustNever },
				]}
				onChange={(v) => pickTrust(v as "ask" | "always" | "never")}
			/>
			</Row>
		</div>
	);
}

/** 通用下选芯片：自定义深色圆角浮层，替代原生 select */
function SelectOption({
	value,
	options,
	onChange,
	width,
}: {
	value: string;
	options: { value: string; label: string }[];
	onChange: (v: string) => void;
	width?: number;
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!open) return;
		const h = (e: MouseEvent) => {
			if (!ref.current?.contains(e.target as Node)) setOpen(false);
		};
		document.addEventListener("mousedown", h);
		return () => document.removeEventListener("mousedown", h);
	}, [open]);
	const current = options.find((o) => o.value === value);
	return (
		<div ref={ref} className="relative">
			<button className="select-chip" data-open={open} onClick={() => setOpen((o) => !o)}>
				{current?.label ?? value}
				<span className="chevron">
					<IconChevronDown14 size={14} />
				</span>
			</button>
			{open && (
				<div
					// left-0：根容器在表单里占满整行宽，right-0 会把弹层甩到行右缘（远离 chip）；
					// chip 恒在容器左缘，左对齐两种用法（Row 的 flex-none / Field 的整行）都正确
					className="popover absolute left-0 top-10 z-50 p-1.5 shadow-xl"
					style={{ minWidth: width ?? 140, width: "max-content", maxHeight: 280, overflowY: "auto" }}
				>
					{options.map((o) => {
						const selected = o.value === value;
						return (
							<button
								key={o.value}
								className="flex w-full items-center justify-between gap-3 rounded-xl px-3.5 py-2 text-left transition-colors"
								style={{
									background: selected ? "var(--dsw-accent-soft)" : "transparent",
								}}
								onMouseEnter={(e) => {
									if (!selected) e.currentTarget.style.background = "var(--dsw-hover)";
								}}
								onMouseLeave={(e) => {
									if (!selected) e.currentTarget.style.background = "transparent";
								}}
								onClick={() => {
									onChange(o.value);
									setOpen(false);
								}}
							>
								<span style={{ fontSize: 13.5, color: selected ? "var(--dsw-accent)" : "var(--dsw-label-primary)", whiteSpace: "nowrap" }}>
									{o.label}
								</span>
								{selected && (
									<span style={{ display: "inline-flex", color: "var(--dsw-accent)", flex: "none" }}>
										<IconCheckOutline14 size={14} />
									</span>
								)}
							</button>
						);
					})}
				</div>
			)}
		</div>
	);
}

function Row({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
	return (
		<div className="hairline-b flex items-center justify-between gap-6 pb-5">
			<div className="min-w-0">
				<div style={{ fontSize: 14, fontWeight: 400 }}>{title}</div>
				{desc && (
					<div className="mt-0.5" style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>
						{desc}
					</div>
				)}
			</div>
			<div className="flex-none">{children}</div>
		</div>
	);
}

/** 标题在上、内容整行在下（dsh 外观三卡的排布） */
function RowColumn({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
	return (
		<div className="hairline-b flex flex-col gap-3 pb-5">
			<div>
				<div style={{ fontSize: 14, fontWeight: 400 }}>{title}</div>
				{desc && (
					<div className="mt-0.5" style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>
						{desc}
					</div>
				)}
			</div>
			{children}
		</div>
	);
}

/** 字号步进器：− 值 ＋（越界禁用；点中间数值回到 14 默认） */
function FontSizeStepper({ value, onChange, max }: { value: number; onChange: (v: number) => void; max: number }) {
	return (
		<div className="flex items-center gap-2">
			<button
				className="icon-btn"
				style={{ width: 26, height: 26, border: "0.5px solid var(--dsw-border-l3)", borderRadius: 8 }}
				disabled={value <= 12}
				onClick={() => onChange(value - 1)}
				aria-label="decrease font size"
			>
				−
			</button>
			<button
				style={{ minWidth: 48, textAlign: "center", fontSize: 13, color: value === 14 ? "var(--dsw-label-tertiary)" : "var(--dsw-label-primary)" }}
				title="reset"
				onClick={() => onChange(14)}
			>
				{value} px
			</button>
			<button
				className="icon-btn"
				style={{ width: 26, height: 26, border: "0.5px solid var(--dsw-border-l3)", borderRadius: 8 }}
				disabled={value >= max}
				onClick={() => onChange(value + 1)}
				aria-label="increase font size"
			>
				＋
			</button>
		</div>
	);
}

// ---------- Models ----------

function ModelsSection() {
	const { t } = useI18n();
	const [providers, setProviders] = useState<ProviderView[]>([]);
	const [custom, setCustom] = useState<{ providers: Record<string, any> }>({ providers: {} });
	const [secretProviderIds, setSecretProviderIds] = useState<Set<string>>(new Set());
	const [editing, setEditing] = useState<string | null>(null);
	const [keyDraft, setKeyDraft] = useState("");
	const [adding, setAdding] = useState<"builtin" | "custom" | null>(null);
	const [cId, setCId] = useState("");
	const [cBaseUrl, setCBaseUrl] = useState("");
	const [cApi, setCApi] = useState("openai-completions");
	const [cKey, setCKey] = useState("");
	const [cModels, setCModels] = useState<ModelDraft[]>([]);
	const [cName, setCName] = useState("");
	const [bBaseUrl, setBBaseUrl] = useState("");
	const [bModels, setBModels] = useState<ModelDraft[]>([]);
	const [editBusy, setEditBusy] = useState(false);
	const [editAdvanced, setEditAdvanced] = useState(false);
	const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
	const [oauthProvider, setOauthProvider] = useState<string | null>(null);
	const [oauthPrompt, setOauthPrompt] = useState<{ type: string; message: string; placeholder?: string } | null>(null);
	const [oauthLog, setOauthLog] = useState<string[]>([]);
	const [oauthInput, setOauthInput] = useState("");
	const [oauthDone, setOauthDone] = useState<{ ok: boolean; msg: string } | null>(null);

	const load = useCallback(async () => {
		const r = await fetch("/api/models?custom=1");
		const j = await r.json();
		if (j.success) {
			setProviders(j.data.providers);
			setSecretProviderIds(new Set(j.data.customProviders?.secretProviderIds ?? []));
			try {
				setCustom(JSON.parse(j.data.customProviders?.content ?? "{}"));
			} catch {
				setCustom({ providers: {} });
			}
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	// OAuth 状态轮询
	useEffect(() => {
		if (!oauthProvider) return;
		let alive = true;
		const poll = async () => {
			const r = await fetch("/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "loginState", providerId: oauthProvider }) });
			const j = await r.json();
			if (!alive || !j.success) return;
			setOauthPrompt(j.data.prompt);
			setOauthLog(j.data.notifyLog ?? []);
			if (j.data.done) {
				setOauthDone({ ok: !j.data.error, msg: j.data.error ?? (lang_or_default(j)) });
				if (!j.data.error) void load();
			}
		};
		void poll();
		const t2 = setInterval(poll, 1500);
		return () => { alive = false; clearInterval(t2); };
		function lang_or_default(j: any) {
			return oauthProvider + " ✓";
		}
	}, [oauthProvider, load]);

	const notify = (ok: boolean, msg?: string) => {
		setToast({ ok, msg: msg ?? (ok ? t.toastSaved : t.toastError) });
		setTimeout(() => setToast(null), 2400);
	};

	const request = async (body: Record<string, unknown>) => {
		const r = await fetch("/api/models", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		});
		return r.json();
	};

	const call = async (body: Record<string, unknown>) => {
		const j = await request(body);
		notify(j.success, j.success && j.data?.requiresSessionReopen ? t.modelConfigReopen : j.error);
		if (j.success) void load();
		return j;
	};

	const customIds = new Set(Object.keys(custom.providers ?? {}));
	// 显示为卡片的 provider：已配置认证 或 自定义
	const shown = providers.filter((p) => p.authReady || customIds.has(p.id));
	// 添加提供方下拉：内置目录里未显示的
	const addable = providers.filter((p) => p.builtIn && !shown.some((s) => s.id === p.id));

	const saveCustom = async (content: Record<string, any>) => {
		return call({ action: "saveCustomProviders", content: JSON.stringify({ providers: content }, null, 2) });
	};

	const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? id;
	const credentialSource = (provider: ProviderView) => {
		const source = provider.authSource;
		if (source === "stored") return "auth.json";
		if (source === "runtime") return t.authSourceRuntime;
		if (source === "environment") return t.authSourceEnvironment;
		if (source === "models_json_key") return "models.json";
		if (source === "models_json_command") return t.authSourceCommand;
		if (source === "fallback") return t.authSourceProvider;
		return provider.resolvedAuthSource || t.authUnavailable;
	};

	const startEdit = (id: string) => {
		setEditing(editing === id ? null : id);
		setKeyDraft("");
		setEditBusy(false);
		setEditAdvanced(false);
		const override = custom.providers[id];
		if (customIds.has(id)) {
			setCId(id);
			setCBaseUrl(override?.baseUrl ?? "");
			setCApi(override?.api ?? "openai-completions");
			setCKey("");
			setCName(typeof override?.name === "string" ? override.name : "");
			setCModels((override?.models ?? []).map((m: any) => ({
				id: typeof m === "string" ? m : String(m?.id ?? ""),
				name: typeof m?.name === "string" ? m.name : "",
				...(Number.isFinite(m?.contextWindow) ? { contextWindow: m.contextWindow } : {}),
				...(Number.isFinite(m?.maxTokens) ? { maxTokens: m.maxTokens } : {}),
			})));
		} else {
			// 内置 provider：从 models.json 覆盖层初始化（若有）
			setBBaseUrl(typeof override?.baseUrl === "string" ? override.baseUrl : "");
			setBModels((override?.models ?? []).map((m: any) => ({
				id: typeof m === "string" ? m : String(m?.id ?? ""),
				name: typeof m?.name === "string" ? m.name : "",
				...(Number.isFinite(m?.contextWindow) ? { contextWindow: m.contextWindow } : {}),
				...(Number.isFinite(m?.maxTokens) ? { maxTokens: m.maxTokens } : {}),
			})));
		}
	};

	const saveCustomEdit = async () => {
		if (editBusy) return;
		const invalid = validateModelDrafts(cModels);
		if (invalid || !cBaseUrl.trim()) return;
		setEditBusy(true);
		try {
			const next = { ...custom.providers };
			const previousId = editing ?? cId.trim();
			const previous = next[previousId] ?? {};
			if (previousId !== cId.trim()) delete next[previousId];
			const trimmed = cModels
				.map((model) => ({
					id: model.id.trim(),
					name: model.name.trim(),
					...(Number.isFinite(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
					...(Number.isFinite(model.maxTokens) ? { maxTokens: model.maxTokens } : {}),
				}))
				.filter((model) => model.id);
			next[cId.trim()] = {
				...(cName.trim() || previous.name ? { name: cName.trim() || previous.name } : {}),
				baseUrl: cBaseUrl.trim(),
				api: cApi,
				...(cKey.trim() ? { apiKey: cKey.trim() } : {}),
				models: trimmed.map(serializeModelDraft),
			};
			const j = await saveCustom(next);
			if (j.success) setEditing(null);
		} finally {
			setEditBusy(false);
		}
	};

	/** 内置 provider 的编辑保存：写 models.json 覆盖层 + 可选 setKey（多步认证走登录弹窗） */
	const saveBuiltinEdit = async (provider: { id: string; apis: string[] }) => {
		if (editBusy) return;
		const invalid = validateModelDrafts(bModels);
		if (invalid) return;
		setEditBusy(true);
		try {
			const next = { ...custom.providers };
			const config: Record<string, unknown> = {};
			if (bBaseUrl.trim()) config.baseUrl = bBaseUrl.trim();
			if (bModels.length) {
				config.api = provider.apis[0] ?? "openai-completions";
				config.models = bModels
					.map((model) => ({
						id: model.id.trim(),
						name: model.name.trim(),
						...(Number.isFinite(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
						...(Number.isFinite(model.maxTokens) ? { maxTokens: model.maxTokens } : {}),
					}))
					.filter((model) => model.id)
					.map(serializeModelDraft);
			}
			if (Object.keys(config).length) next[provider.id] = { ...(next[provider.id] ?? {}), ...config };
			else delete next[provider.id];
			const j = await saveCustom(next);
			if (j.success && keyDraft.trim()) {
				void call({ action: "setKey", providerId: provider.id, apiKey: keyDraft.trim() });
				setOauthDone(null);
				setOauthProvider(provider.id);
			}
			if (j.success) setEditing(null);
		} finally {
			setEditBusy(false);
		}
	};

	const deleteCustom = async (id: string) => {
		const next = { ...custom.providers };
		delete next[id];
		// 内置 provider（“添加提供方”加入）只写有 models.json 覆盖：删除时
		// 连带移除认证密钥，否则 authReady 仍为真、行不会从列表消失
		const target = providers.find((provider) => provider.id === id);
		if (target?.builtIn) {
			try {
				await call({ action: "removeKey", providerId: id });
			} catch {
				/* 无已存密钥时忽略 */
			}
		}
		const j = await saveCustom(next);
		if (j.success) setEditing(null);
	};

	const saveBuiltinSetup = async ({ providerId, apiKey, config }: BuiltinProviderSetup) => {
		const next = { ...custom.providers, [providerId]: config };
		const result = await request({ action: "saveCustomProviders", content: JSON.stringify({ providers: next }, null, 2) });
		const requiresSessionReopen = result.success && result.data?.requiresSessionReopen === true;
		if (result.success && apiKey) {
			// 多步认证（Vertex/Bedrock/Cloudflare 等）的后续提示经登录弹窗应答；
			// 不能 await setKey —— 它会挂起到全部提示答完。
			void request({ action: "setKey", providerId, apiKey });
			setOauthDone(null);
			setOauthProvider(providerId);
		}
		notify(result.success, result.success && requiresSessionReopen ? t.modelConfigReopen : result.error);
		if (result.success) void load();
		return result;
	};

	const saveCustomSetup = async ({ providerId, config }: CustomProviderSetup) => {
		const next = { ...custom.providers, [providerId]: config };
		const result = await request({ action: "saveCustomProviders", content: JSON.stringify({ providers: next }, null, 2) });
		notify(result.success, result.success && result.data?.requiresSessionReopen ? t.modelConfigReopen : result.error);
		if (result.success) void load();
		return result;
	};

	return (
		<div className="flex flex-col gap-5">
			<div>
				<div style={{ fontSize: 14, fontWeight: 400 }}>{t.modelsTitle}</div>
				<div className="mt-0.5" style={{ fontSize: 12.5, color: "var(--dsw-label-caption)" }}>
					{t.modelsDesc}
				</div>
				<div className="mt-1" style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>
					{t.customModelIdentityNotice}
				</div>
			</div>

			{toast && (
				<div
					className="rounded-xl px-3 py-2"
					style={{
						fontSize: 12.5,
						background: toast.ok ? "rgba(34,197,94,.1)" : "rgba(236,19,19,.1)",
						color: toast.ok ? "var(--dsw-success)" : "var(--dsw-danger)",
					}}
				>
					{toast.msg}
				</div>
			)}

			{/* Provider 卡片 */}
			<div className="flex flex-col gap-2.5">
				{shown.map((p) => {
					const isCustom = customIds.has(p.id) && !p.builtIn;
					const editingThis = editing === p.id;
					return (
						<div key={p.id}>
							<div className="flex items-center gap-3 rounded-2xl px-4 py-3" style={{ border: "0.5px solid var(--dsw-border-l2)" }}>
								<ProviderBrand id={p.id} name={providerName(p.id)} size={34} />
								<div className="min-w-0 flex-1">
									<div className="truncate" style={{ fontSize: 14, fontWeight: 500 }}>{providerName(p.id)}</div>
									<div className="truncate" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>
										{p.id}{p.baseUrl ? ` · ${p.baseUrl}` : ""}
									</div>
								</div>
								{isCustom && (
									<span
										className="rounded-md px-1.5 py-0.5"
										style={{ fontSize: 10.5, border: "0.5px solid var(--dsw-border-l3)", color: "var(--dsw-label-tertiary)" }}
									>
										{t.customBadge}
									</span>
								)}
								<span
									className="inline-block h-2 w-2 rounded-full"
									style={{ background: p.authReady ? "var(--dsw-success)" : "var(--dsw-danger)" }}
									title={p.authError || (p.authReady ? t.providerReady : t.authUnavailable)}
								/>
								<span
									className="rounded-md px-1.5 py-0.5"
									style={{ fontSize: 10.5, border: "0.5px solid var(--dsw-border-l3)", color: "var(--dsw-label-tertiary)" }}
								>
									{t.credentialSource.replace("{source}", credentialSource(p))}
								</span>
								<button className="btn-outline" style={{ height: 28, padding: "0 12px", fontSize: 12 }} onClick={() => startEdit(p.id)}>
									{t.edit}
								</button>
								{p.authTypes?.includes("oauth") && (
									<button
										className="btn-outline"
										style={{ height: 28, padding: "0 12px", fontSize: 12 }}
										onClick={() => {
											setOauthDone(null);
											void call({ action: "loginStart", providerId: p.id });
											setOauthProvider(p.id);
										}}
									>
										{t.oauthLogin}
									</button>
								)}
								{customIds.has(p.id) && (
									<button style={{ fontSize: 12.5, color: "var(--dsw-danger)" }} onClick={() => deleteCustom(p.id)}>
										{t.delete}
									</button>
								)}
							</div>

							{editingThis && (
								<div className="mt-2 rounded-2xl p-4" style={{ border: "0.5px solid var(--dsw-border-l2)" }}>
									{isCustom ? (
										<div className="flex flex-col gap-3">
											<Field label={t.apiKey}>
												<input
													type="password"
													value={cKey}
													onChange={(e) => setCKey(e.target.value)}
													className={fieldCls}
													placeholder={secretProviderIds.has(p.id) ? t.apiKeyStored : t.apiKeyOptional}
												/>
											</Field>
											<Field label={t.displayName}>
												<input value={cName} onChange={(e) => setCName(e.target.value)} className={fieldCls} placeholder={p.id} />
											</Field>
											<Field label={t.baseUrl}>
												<input value={cBaseUrl} onChange={(e) => setCBaseUrl(e.target.value)} className={fieldCls} placeholder="https://api.example.com/v1" />
											</Field>
											<Field label={t.apiType}>
												<SelectOption
													value={cApi}
													options={[
														{ value: "openai-completions", label: "openai-completions" },
														{ value: "openai-responses", label: "openai-responses" },
														{ value: "anthropic-messages", label: "anthropic-messages" },
														{ value: "google-generative-ai", label: "google-generative-ai" },
													]}
													onChange={setCApi}
												/>
											</Field>
											<ModelCatalog
												models={cModels}
												setModels={setCModels}
												updateModel={(index, patch) => setCModels((current) => current.map((model, at) => (at === index ? { ...model, ...patch } : model)))}
												discover={async () => {
													const response = await fetch("/api/models", {
														method: "POST",
														headers: { "Content-Type": "application/json" },
														// providerId：key 留空（保持不变）时后端回退到已存密钥
														body: JSON.stringify({ action: "discoverModels", providerId: p.id, baseUrl: cBaseUrl.trim(), api: cApi, apiKey: cKey.trim() }),
													});
													const result = await response.json();
													if (!result.success) throw new Error(result.error || t.toastError);
													return (result.data.models ?? []).map((model: { id: string; name?: string }) => ({ id: model.id, name: model.name ?? "" }));
												}}
												discoverDisabled={!cBaseUrl.trim()}
											/>
											<div className="flex justify-end gap-2">
												<button className="btn-outline" style={{ height: 32 }} disabled={editBusy} onClick={() => setEditing(null)}>{t.cancel}</button>
												<button
													className="btn-primary-white"
													disabled={editBusy || !cBaseUrl.trim() || !!validateModelDrafts(cModels) || !cModels.some((m) => m.id.trim())}
													onClick={() => void saveCustomEdit()}
												>
													{editBusy ? t.saving : t.save}
												</button>
											</div>
										</div>
									) : (
										<div className="flex flex-col gap-3">
											<Field label={t.apiKey}>
												<input
													type="password"
													value={keyDraft}
													onChange={(e) => setKeyDraft(e.target.value)}
													className={fieldCls}
													placeholder={p.keyManaged ? t.apiKeyStored : (p.apiKeyLabel ?? t.apiKey)}
												/>
											</Field>
											<div>
												<button
													className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left transition-colors"
													style={{ fontSize: 13, color: "var(--dsw-label-secondary)", background: editAdvanced ? "var(--dsw-hover)" : "transparent" }}
													onClick={() => setEditAdvanced((v) => !v)}
												>
													<span style={{ display: "inline-flex", transform: editAdvanced ? "none" : "rotate(-90deg)", transition: "transform 120ms ease" }}>
														<IconChevronDown14 size={13} />
													</span>
													{t.customSettings}
												</button>
												{editAdvanced ? (
													<div className="flex flex-col gap-3 pl-1 pt-2">
														<Field label={t.baseUrl}>
															<input value={bBaseUrl} onChange={(e) => setBBaseUrl(e.target.value)} className={fieldCls} placeholder={p.baseUrl ?? t.providerDefault} />
														</Field>
														<ModelCatalog
															models={bModels}
															setModels={setBModels}
															updateModel={(index, patch) => setBModels((current) => current.map((model, at) => (at === index ? { ...model, ...patch } : model)))}
															inheritedCount={p.modelCount}
															discover={async () => {
																const response = await fetch("/api/models", {
																	method: "POST",
																	headers: { "Content-Type": "application/json" },
																	// providerId：key 留空（保持不变）时后端回退到已存密钥
																	body: JSON.stringify({ action: "discoverModels", providerId: p.id, baseUrl: (bBaseUrl.trim() || p.baseUrl || ""), api: p.apis[0], apiKey: keyDraft.trim() }),
																});
																const result = await response.json();
																if (!result.success) throw new Error(result.error || t.toastError);
																return (result.data.models ?? []).map((model: { id: string; name?: string }) => ({ id: model.id, name: model.name ?? "" }));
															}}
															discoverDisabled={!(bBaseUrl.trim() || p.baseUrl)}
														/>
													</div>
												) : null}
											</div>
											<div className="flex items-center justify-end gap-2">
												{p.keyManaged && (
													<button
														style={{ fontSize: 12.5, color: "var(--dsw-danger)" }}
														disabled={editBusy}
														onClick={async () => {
															const j = await call({ action: "removeKey", providerId: p.id });
															if (j.success) setEditing(null);
														}}
													>
														{t.removeKey}
													</button>
												)}
												<button className="btn-outline" style={{ height: 32 }} disabled={editBusy} onClick={() => setEditing(null)}>{t.cancel}</button>
												<button
													className="btn-primary-white"
													disabled={editBusy || !!validateModelDrafts(bModels) || (!keyDraft.trim() && !bBaseUrl.trim() && bModels.length === 0)}
													onClick={() => void saveBuiltinEdit({ id: p.id, apis: p.apis })}
												>
													{editBusy ? t.saving : t.save}
												</button>
											</div>
										</div>
									)}
								</div>
							)}
						</div>
					);
				})}
			</div>

			{/* 两个添加按钮 */}
			<div className="flex gap-3">
				<button
					className="flex flex-1 items-center justify-center gap-2 rounded-2xl px-4 py-3.5 transition-colors"
					style={{ border: "0.5px solid var(--dsw-border-l3)", fontSize: 14 }}
					onMouseEnter={(e) => (e.currentTarget.style.background = "var(--dsw-hover)")}
					onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
					onClick={() => setAdding("builtin")}
				>
					<IconPlusOutline16 size={15} />
					{t.addProvider}
				</button>
				<button
					className="flex flex-1 items-center justify-center gap-2 rounded-2xl px-4 py-3.5 transition-colors"
					style={{ border: "0.5px solid var(--dsw-border-l3)", fontSize: 14 }}
					onMouseEnter={(e) => (e.currentTarget.style.background = "var(--dsw-hover)")}
					onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
					onClick={() => setAdding("custom")}
				>
					<IconPlusOutline16 size={15} />
					{t.addCustomProvider}
				</button>
			</div>

			{adding ? (
				<ProviderSetupModal
					mode={adding}
					providers={addable}
					existingIds={providers.map((provider) => provider.id)}
					onClose={() => setAdding(null)}
					onSaveBuiltin={saveBuiltinSetup}
					onSaveCustom={saveCustomSetup}
				/>
			) : null}

	{/* OAuth 登录弹窗 */}
	{oauthProvider && (
		<div className="modal-mask fixed inset-0 z-[120] flex items-center justify-center" onMouseDown={(e) => { if (e.target === e.currentTarget) setOauthProvider(null); }}>
			<div className="glass-modal flex flex-col gap-4 p-6" style={{ width: 460, maxWidth: "92vw", borderRadius: 24, boxShadow: "var(--dsw-elevation-prominent)" }}>
				<div style={{ fontSize: 15, fontWeight: 600 }}>{t.oauthLogin} · {oauthProvider}</div>
				{oauthLog.length > 0 && (
					<div className="flex flex-col gap-0.5" style={{ fontSize: 12, color: "var(--dsw-label-tertiary)" }}>
						{oauthLog.slice(-3).map((l, i) => (
							<div key={i} className="truncate">{l}</div>
						))}
					</div>
				)}
				{oauthDone ? (
					<div style={{ fontSize: 13, color: oauthDone.ok ? "var(--dsw-success)" : "var(--dsw-danger)" }}>{oauthDone.ok ? oauthProvider + " ✓" : oauthDone.msg}</div>
				) : oauthPrompt ? (
					<>
						<div style={{ fontSize: 13.5, color: "var(--dsw-label-primary)" }}>{oauthPrompt.message}</div>
						{oauthPrompt.message.match(/https?:\/\/[^\s)]+/) && (
							<a
								href={oauthPrompt.message.match(/https?:\/\/[^\s)]+/)![0]}
								target="_blank"
								rel="noreferrer"
								className="break-all"
								style={{ fontSize: 12.5, color: "var(--dsw-accent)" }}
							>
								{oauthPrompt.message.match(/https?:\/\/[^\s)]+/)![0]}
							</a>
						)}
						<input
							autoFocus
							type={oauthPrompt.type === "secret" ? "password" : "text"}
							value={oauthInput}
							onChange={(e) => setOauthInput(e.target.value)}
							placeholder={oauthPrompt.placeholder ?? ""}
							className="w-full rounded-xl px-3 py-2"
							style={{ fontSize: 13, background: "var(--dsw-hover)" }}
							onKeyDown={(e) => {
								if (e.key === "Enter" && oauthInput.trim()) {
									void fetch("/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "loginAnswer", providerId: oauthProvider, text: oauthInput.trim() }) });
									setOauthInput("");
								}
							}}
						/>
						<div className="flex items-center justify-between gap-2">
							<span style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>{t.oauthWait}</span>
							<div className="flex gap-2">
								<button
									className="btn-outline"
									style={{ height: 32 }}
									onClick={async () => {
										await fetch("/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "loginCancel", providerId: oauthProvider }) });
										setOauthProvider(null);
									}}
								>
									{t.oauthCancel}
								</button>
								<button
									className="btn-primary-white"
									disabled={!oauthInput.trim()}
									style={{ opacity: oauthInput.trim() ? 1 : 0.5 }}
									onClick={async () => {
										await fetch("/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "loginAnswer", providerId: oauthProvider, text: oauthInput.trim() }) });
										setOauthInput("");
									}}
								>
									{t.confirm}
								</button>
							</div>
						</div>
					</>
				) : (
					<div style={{ fontSize: 13, color: "var(--dsw-label-tertiary)" }}>{t.oauthWait}</div>
				)}
				{oauthDone && (
					<div className="flex justify-end">
						<button className="btn-primary-white" onClick={() => setOauthProvider(null)}>{t.close}</button>
					</div>
				)}
			</div>
		</div>
	)}

		</div>
	);
}const fieldCls = "w-full rounded-xl px-3 py-2";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div>
			<div className="mb-1" style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>
				{label}
			</div>
			{children}
		</div>
	);
}

// ---------- 工具启用情况 ----------

/** 内置工具的一句话说明（未知/扩展工具只显示原名） */
const TOOL_DESCRIPTIONS: Record<string, { zh: string; en: string }> = {
	read: { zh: "读取文件", en: "Read files" },
	bash: { zh: "执行 Shell 命令", en: "Run shell commands" },
	powershell: { zh: "执行 PowerShell", en: "Run PowerShell" },
	edit: { zh: "编辑文件", en: "Edit files" },
	write: { zh: "写入文件", en: "Write files" },
	grep: { zh: "搜索文件内容", en: "Search file contents" },
	find: { zh: "按名称查找文件", en: "Find files by name" },
	ls: { zh: "列出目录内容", en: "List directories" },
};

function ToolsSection({
	toolPreset,
	onToolPresetChange,
	tools,
	onSetTools,
}: {
	toolPreset: ToolPreset;
	onToolPresetChange: (preset: ToolPreset) => void;
	tools?: { active: string[]; all: { name: string; description?: string }[] } | null;
	onSetTools?: (names: string[]) => void;
}) {
	const { t, lang } = useI18n();
	const active = new Set(tools?.active ?? []);
	const all = tools?.all ?? [];

	const toggle = (name: string) => {
		if (!onSetTools) return;
		const next = active.has(name) ? [...active].filter((n) => n !== name) : [...active, name];
		onSetTools(next);
	};

	const describe = (name: string) => {
		const d = TOOL_DESCRIPTIONS[name];
		return d ? (lang === "zh" ? d.zh : d.en) : "";
	};

	return (
		<div className="flex flex-col gap-5">
			<div>
				<div style={{ fontSize: 14, fontWeight: 400 }}>{t.toolsSection}</div>
				<div className="mt-0.5" style={{ fontSize: 12.5, color: "var(--dsw-label-caption)" }}>
					{t.toolsSectionDesc}
				</div>
			</div>

			<Row title={t.securityToolPreset} desc={t.securityToolPresetDesc}>
				<SelectOption
					value={toolPreset}
					options={[
						{ value: "readonly", label: t.toolReadonly },
						{ value: "standard", label: t.toolStandard },
						{ value: "full", label: t.toolFull },
					]}
					onChange={(value) => onToolPresetChange(value as ToolPreset)}
				/>
			</Row>

			{all.length === 0 ? (
				<div className="rounded-2xl p-4" style={{ border: "0.5px dashed var(--dsw-border-l3)", fontSize: 12.5, color: "var(--dsw-label-caption)" }}>
					{t.toolsNoSession}
				</div>
			) : (
				<div className="flex flex-col gap-2.5">
					<div className="flex items-center gap-2" style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>
						<span style={{ fontWeight: 600 }}>{t.toolsCurrentSession}</span>
						<span>{t.toolsActiveCount.replace("{n}", String(active.size)).replace("{total}", String(all.length))}</span>
					</div>
					{all.map((tool) => {
						const on = active.has(tool.name);
						const desc = tool.description || describe(tool.name);
						return (
							<div key={tool.name} className="flex items-center gap-3 rounded-2xl px-4 py-2.5" style={{ border: "0.5px solid var(--dsw-border-l2)" }}>
								<div className="min-w-0 flex-1">
									<div style={{ fontSize: 13.5, fontWeight: 500, fontFamily: "var(--font-mono)" }}>{tool.name}</div>
									{desc && (
										<div className="truncate" style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>
											{desc}
										</div>
									)}
								</div>
								<button
									className="relative h-5 w-9 flex-none rounded-full transition-colors"
									style={{ background: on ? "var(--dsw-accent)" : "var(--dsw-border-l3)" }}
									role="switch"
									aria-checked={on}
									aria-label={tool.name}
									disabled={!onSetTools || (on && active.size <= 1)}
									onClick={() => toggle(tool.name)}
								>
									<span className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all" style={{ left: on ? 18 : 2 }} />
								</button>
						</div>
						);
					})}
				</div>
			)}
		</div>
	);
}

// ---------- Skills ----------

interface SkillRow {
	name: string;
	description: string;
	filePath: string;
	disabled: boolean;
	scope: "global" | "project" | "package";
}

function SkillsSection({ cwd }: { cwd: string }) {
	const { t } = useI18n();
	const [skills, setSkills] = useState<SkillRow[]>([]);
	const [expanded, setExpanded] = useState<string | null>(null);
	const [fileContent, setFileContent] = useState("");

	const load = useCallback(async () => {
		const r = await fetch(`/api/skills${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`);
		const j = await r.json();
		if (j.success) setSkills(j.data.skills);
	}, [cwd]);

	useEffect(() => {
		void load();
	}, [load]);

	const toggle = async (s: SkillRow) => {
		const r = await fetch("/api/skills", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "toggle", filePath: s.filePath, disabled: !s.disabled, cwd }),
		});
		if ((await r.json()).success) void load();
	};

	const view = async (s: SkillRow) => {
		if (expanded === s.filePath) {
			setExpanded(null);
			return;
		}
		const r = await fetch("/api/skills", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ action: "read", filePath: s.filePath, cwd }),
		});
		const j = await r.json();
		if (j.success) {
			setFileContent(j.data.content);
			setExpanded(s.filePath);
		}
	};

	const scopeLabel = (s: SkillRow["scope"]) => (s === "global" ? t.scopeGlobal : s === "project" ? t.scopeProject : t.scopePackage);

	return (
		<div className="flex flex-col gap-4">
			<div style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>{t.skillsDesc}</div>
			{skills.length === 0 && (
				<div style={{ fontSize: 13, color: "var(--dsw-label-caption)" }}>—</div>
			)}
			<div className="flex flex-col gap-2">
				{skills.map((s) => (
					<div key={s.filePath} className="rounded-2xl px-4 py-3" style={{ border: "0.5px solid var(--dsw-border-l2)" }}>
						<div className="flex items-center gap-3">
							<div className="min-w-0 flex-1">
								<div className="flex items-center gap-2">
									<span style={{ fontSize: 13.5, fontWeight: 500 }}>{s.name}</span>
									<span
										className="rounded-full px-2 py-0.5"
										style={{ fontSize: 10, background: "var(--dsw-hover)", color: "var(--dsw-label-tertiary)" }}
									>
										{scopeLabel(s.scope)}
									</span>
								</div>
								<div className="mt-0.5 truncate" style={{ fontSize: 12, color: "var(--dsw-label-caption)" }} title={s.description}>
									{s.description}
								</div>
							</div>
							<button
								className="rounded-lg px-2.5 py-1"
								style={{ fontSize: 11.5, color: "var(--dsw-label-tertiary)" }}
								onClick={() => view(s)}
							>
								{t.viewSkillFile}
							</button>
							<button
								className="relative h-5 w-9 flex-none rounded-full transition-colors"
								style={{ background: s.disabled ? "var(--dsw-border-l3)" : "var(--dsw-accent)" }}
								role="switch"
								aria-checked={!s.disabled}
								onClick={() => toggle(s)}
							>
								<span
									className="absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all"
									style={{ left: s.disabled ? 2 : 18 }}
								/>
							</button>
						</div>
						{expanded === s.filePath && (
							<pre
								className="mt-3 max-h-64 overflow-auto rounded-xl p-3"
								style={{ background: "var(--dsw-hover)", fontFamily: "var(--font-mono)", fontSize: 11.5, lineHeight: 1.55 }}
							>
								{fileContent}
							</pre>
						)}
					</div>
				))}
			</div>
		</div>
	);
}

// ---------- Plugins ----------

function PluginsSection({ cwd }: { cwd: string }) {
	const { t, lang } = useI18n();
	const [tab, setTab] = useState<"config" | "list">("config");
	const [packages, setPackages] = useState<any[]>([]);
	const [extensions, setExtensions] = useState<any[]>([]);
	const [q, setQ] = useState("");
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [source, setSource] = useState("");
	const [local, setLocal] = useState(false);
	const [busy, setBusy] = useState(false);
	const [busyKey, setBusyKey] = useState<string | null>(null);
	const [toast, setToast] = useState<{ ok: boolean; msg: string; loading?: boolean } | null>(null);
	const [menuKey, setMenuKey] = useState<string | null>(null);
	const menuRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		const close = (event: PointerEvent) => {
			if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
			setMenuKey(null);
		};
		window.addEventListener("pointerdown", close);
		return () => window.removeEventListener("pointerdown", close);
	}, []);

	const load = useCallback(async () => {
		const r = await fetch(`/api/plugins${cwd ? `?cwd=${encodeURIComponent(cwd)}` : ""}`);
		const j = await r.json();
		if (j.success) {
			setPackages(j.data.packages);
			setExtensions(j.data.extensions);
		}
	}, [cwd]);

	useEffect(() => {
		void load();
	}, [load]);

	const notify = (ok: boolean, msg?: string) => {
		setToast({ ok, msg: msg ?? (ok ? t.toastSaved : t.toastError), loading: false });
		setTimeout(() => setToast(null), 2600);
	};

	const act = async (
		action: string,
		payload: Record<string, unknown> = {},
		itemKey?: string,
		loadingMsg?: string,
		successMsg?: string
	) => {
		setBusy(true);
		if (itemKey) setBusyKey(itemKey);
		if (loadingMsg) setToast({ ok: true, msg: loadingMsg, loading: true });
		try {
			const r = await fetch("/api/plugins", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action, cwd, ...payload }),
			});
			const j = await r.json();
			if (j.success) {
				notify(true, successMsg ?? (action === "toggle" ? (payload.disabled ? t.disabled : t.enabled) : t.toastSaved));
				await load();
			} else {
				notify(false, j.error ?? t.toastError);
			}
		} catch (e: any) {
			notify(false, e?.message ?? t.toastError);
		} finally {
			setBusy(false);
			setBusyKey(null);
		}
	};

	const toggle = (key: string) =>
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});

	const classify = (path: string): "global" | "project" | "package" => {
		const norm = path.replace(/\\/g, "/");
		if (norm.includes("/.pi/agent/npm/") || norm.includes("/.pi/agent/git/")) return "package";
		if (norm.includes("/.pi/agent/")) return "global";
		if (norm.includes("/.pi/")) return "project";
		return "project";
	};

	const scopeLabel = (s: "global" | "project" | "package") =>
		s === "global" ? t.scopeGlobal : s === "project" ? t.scopeProject : t.scopePackage;

	// 独立扩展 = 排除随包安装的（包已在 packages 里展示）
	const standalone = extensions.filter((e: any) => classify(e.path) !== "package");
	const query = q.trim().toLowerCase();

	const listItems = [
		...packages.map((p) => ({
			key: `pkg:${p.scope}:${p.source}`,
			kind: "package" as const,
			name: p.source.replace(/^npm:/, "").replace(/^git[^:]*:/, ""),
			p,
		})),
		...standalone.map((e: any) => ({
			key: `ext:${e.path}`,
			kind: "extension" as const,
			name: e.name,
			e,
		})),
	].filter((x) => !query || x.name.toLowerCase().includes(query));

	const badge = (
		<span
			className="flex flex-none items-center gap-1.5 rounded-md px-1.5 py-0.5"
			style={{ fontSize: 10.5, background: "rgba(34,197,94,.12)", color: "var(--dsw-success)" }}
		>
			<span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--dsw-success)" }} />
			{t.enabled}
		</span>
	);

	return (
		<div className="flex flex-col gap-5">
			<div>
				<div style={{ fontSize: 20, fontWeight: 600, color: "var(--dsw-label-primary)" }}>{t.setPlugins}</div>
				<div className="mt-1" style={{ fontSize: 13, color: "var(--dsw-label-tertiary)" }}>
					{t.pluginPageDesc}
				</div>
			</div>

			{toast && (
				<div
					className="fixed top-6 left-1/2 -translate-x-1/2 z-[9999] flex items-center gap-2.5 px-4 py-2 rounded-xl shadow-2xl transition-all pointer-events-none"
					style={{
						fontSize: 13,
						fontWeight: 500,
						background: "var(--dsw-surface-l1, #1e2025)",
						border: toast.loading
							? "1px solid var(--dsw-border-l3)"
							: toast.ok
							? "1px solid rgba(34,197,94,.4)"
							: "1px solid rgba(236,19,19,.4)",
						color: toast.loading
							? "var(--dsw-label-primary)"
							: toast.ok
							? "var(--dsw-success)"
							: "var(--dsw-danger)",
						backdropFilter: "blur(12px)",
						boxShadow: "0 10px 30px rgba(0,0,0,0.5)",
					}}
				>
					{toast.loading && (
						<span className="h-3.5 w-3.5 flex-none animate-spin rounded-full border-2 border-current border-t-transparent" />
					)}
					<span>{toast.msg}</span>
				</div>
			)}

			{/* 双标签（dsh：插件配置 / 插件列表，白色下划线） */}
			<div className="hairline-b flex items-center gap-6">
				<button className="settings-tab-underline" data-active={tab === "config"} onClick={() => setTab("config")}>
					{t.pluginConfig}
				</button>
				<button className="settings-tab-underline" data-active={tab === "list"} onClick={() => setTab("list")}>
					{t.pluginList}
				</button>
			</div>

			{tab === "config" && (
				<div className="flex flex-col gap-2.5">
					{/* 安装入口：pi 包管理器支持 npm:包名 / git 地址 / 本地路径；安装后自动重载加载器与活跃会话 */}
					<div className="flex flex-col gap-2 rounded-2xl px-4 py-3" style={{ border: "0.5px solid var(--dsw-border-l2)" }}>
						<div style={{ fontSize: 13.5, fontWeight: 500 }}>{t.addPackage}</div>
						<div className="flex flex-wrap items-center gap-2">
							<input
								value={source}
								onChange={(e) => setSource(e.target.value)}
								placeholder={t.addPackagePlaceholder}
								className="min-w-0 flex-1 rounded-xl px-3 py-2"
								style={{ fontSize: 13, background: "var(--dsw-hover)", border: "0.5px solid var(--dsw-border-l2)", fontFamily: "var(--font-mono)" }}
								onKeyDown={(e) => {
									if (e.key === "Enter" && source.trim() && !busy) void act("install", { source: source.trim(), local }, undefined, t.installing, t.installSuccess).then(() => setSource(""));
								}}
							/>
							<label className="flex items-center gap-1.5" style={{ fontSize: 12.5, color: "var(--dsw-label-secondary)" }}>
								<input type="checkbox" checked={local} onChange={(e) => setLocal(e.target.checked)} disabled={!cwd} />
								{t.installLocal}
							</label>
							<button
								className="btn-primary-white"
								style={{ height: 32, padding: "0 14px" }}
								disabled={!source.trim() || busy}
								onClick={() => void act("install", { source: source.trim(), local }, undefined, t.installing, t.installSuccess).then(() => setSource(""))}
							>
								{t.install}
							</button>
						</div>
					</div>
					<div className="flex justify-end">
						<button
							className="btn-outline"
							style={{ height: 30, fontSize: 12.5 }}
							disabled={busy}
							onClick={async () => {
								setBusy(true);
								try {
									const r = await fetch("/api/plugins", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "reload", cwd }) });
									const j = await r.json();
									notify(j.success, j.success ? t.reloadedSessions.replace("{loaders}", String(j.data?.loaders ?? 0)).replace("{sessions}", String(j.data?.sessions ?? 0)) : j.error);
									if (j.success) await load();
								} finally {
									setBusy(false);
								}
							}}
						>
							<IconRefreshOutline14 size={13} /> {t.reloadExtensions}
						</button>
					</div>
					{standalone.length === 0 && (
						<div style={{ fontSize: 12.5, color: "var(--dsw-label-caption)" }}>{t.extensionsEmpty}</div>
					)}
					{standalone.map((e: any) => {
						const key = `ext:${e.path}`;
						const open = expanded.has(key);
						const scope = classify(e.path);
						return (
							<div key={key} className="rounded-2xl" style={{ border: "0.5px solid var(--dsw-border-l2)" }}>
								<button className="flex w-full items-center gap-3 px-4 py-3.5 text-left" onClick={() => toggle(key)}>
									<div className="min-w-0 flex-1">
										<div className="flex items-center gap-2" style={{ fontSize: 14, fontWeight: 500 }}>
											<span>{e.name}</span>
											{e.error && (
												<span className="rounded px-1.5 py-0.5" style={{ fontSize: 10.5, color: "var(--dsw-danger)", background: "var(--pw-danger-soft, rgba(236,19,19,.12))" }}>{t.extensionLoadError}</span>
											)}
											{e.disabled && !e.error && (
												<span className="rounded px-1.5 py-0.5" style={{ fontSize: 10.5, color: "var(--dsw-label-tertiary)", background: "var(--dsw-selector)" }}>{t.disabled}</span>
											)}
										</div>
										<div className="truncate" style={{ fontSize: 12, color: e.error ? "var(--dsw-danger)" : "var(--dsw-label-caption)" }} title={e.error ?? e.path}>
											{e.error ?? e.path}
										</div>
									</div>
									<span
										className="chevron"
										style={{ color: "var(--dsw-label-tertiary)", display: "inline-flex", transform: open ? "rotate(180deg)" : "none", transition: "transform 120ms var(--ds-ease-in-out)" }}
									>
										<IconChevronDown14 size={14} />
									</span>
								</button>
								{open && (
									<div className="hairline-t flex flex-col gap-1.5 px-4 py-3" style={{ fontSize: 12, color: "var(--dsw-label-secondary)" }}>
										<div className="flex items-center gap-2">
											<span
												className="rounded-md px-1.5 py-0.5"
												style={{ fontSize: 10.5, border: "0.5px solid var(--dsw-border-l3)", color: "var(--dsw-label-tertiary)" }}
											>
												{scopeLabel(scope)}
											</span>
											{badge}
										</div>
										<div className="break-all" style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--dsw-label-caption)" }}>
											{e.path}
										</div>
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}

			{tab === "list" && (
				<div className="flex flex-col gap-3.5">
					<div
						className="flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 transition-colors"
						style={{ background: "var(--dsw-hover)", border: "0.5px solid var(--dsw-border-l2)" }}
					>
						<IconSearchOutline16 size={15} style={{ color: "var(--dsw-label-caption)" }} />
						<input
							value={q}
							onChange={(e) => setQ(e.target.value)}
							placeholder={t.searchPlugins}
							className="w-full bg-transparent outline-none"
							style={{ fontSize: 13, color: "var(--dsw-label-primary)" }}
						/>
					</div>

					<div className="flex items-baseline gap-2">
						<span style={{ fontSize: 13.5, fontWeight: 600, color: "var(--dsw-label-primary)" }}>{t.pluginList}</span>
						<span style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>{listItems.length}</span>
					</div>

					{listItems.length === 0 ? (
						<div style={{ fontSize: 12.5, color: "var(--dsw-label-caption)" }}>{t.packagesEmpty}</div>
					) : (
						<div className="grid grid-cols-1 items-start sm:grid-cols-2 gap-2.5">
							{listItems.map((x) => {
								const open = expanded.has(x.key);
								const isDisabled = x.kind === "package" ? x.p.disabled === true : x.e.disabled === true;
								const isMenuOpen = menuKey === x.key;
								const isBusy = busyKey === x.key;
								return (
									<div
										key={x.key}
										className="flex flex-col rounded-xl transition-colors"
										style={{
											background: "var(--dsw-hover)",
											border: "0.5px solid var(--dsw-border-l2)",
										}}
									>
										<div className="flex h-11 items-center justify-between px-3.5 gap-2">
											<span
												className="min-w-0 flex-1 truncate font-medium text-[var(--dsw-label-primary)] cursor-pointer select-none"
												style={{ fontSize: 13.5 }}
												onClick={() => toggle(x.key)}
												title={x.name}
											>
												{x.name}
											</span>
											<div ref={isMenuOpen ? menuRef : undefined} className="relative flex-none">
												<button
													type="button"
													className="flex min-w-[86px] items-center justify-center rounded-lg px-3 transition-colors cursor-pointer select-none disabled:cursor-wait"
													style={{
														gap: 7,
														height: 30,
														background: "rgba(255, 255, 255, 0.04)",
														border: "1px solid rgba(255, 255, 255, 0.08)",
													}}
													aria-haspopup="menu"
													aria-expanded={isMenuOpen}
													disabled={isBusy}
													onClick={(e) => {
														e.stopPropagation();
														setMenuKey((prev) => (prev === x.key ? null : x.key));
													}}
												>
													{isBusy ? (
														<span className="h-3 w-3 flex-none animate-spin rounded-full border border-[var(--dsw-label-tertiary)] border-t-transparent" />
													) : !isDisabled ? (
														<span
																	className="h-2 w-2 flex-none rounded-full"
															style={{ background: "#22c55e", boxShadow: "0 0 5px rgba(34, 197, 94, 0.4)" }}
														/>
													) : null}
													<span
														style={{
															fontSize: 12,
															fontWeight: 500,
															color: isDisabled ? "var(--dsw-label-tertiary)" : "var(--dsw-success)",
															lineHeight: 1,
														}}
													>
														{isDisabled ? t.disabled : t.enabled}
													</span>
														<IconChevronDown14
															size={13}
														style={{
															color: "var(--dsw-label-tertiary)",
															transform: isMenuOpen ? "rotate(180deg)" : "none",
															transition: "transform 140ms ease",
														}}
													/>
												</button>

												{isMenuOpen && (
													<div
														className="popover absolute right-0 top-full mt-1.5 z-50 w-36 py-1 rounded-xl shadow-xl"
														role="menu"
														style={{
															background: "var(--dsw-surface-l1, #1e2025)",
															border: "0.5px solid var(--dsw-border-l3)",
															boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 8px 10px -6px rgba(0, 0, 0, 0.5)",
														}}
													>
														<button
															type="button"
															role="menuitem"
															className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--dsw-hover)] cursor-pointer"
															style={{ color: isDisabled ? "var(--dsw-success)" : "var(--dsw-label-primary)" }}
															disabled={busy}
															onClick={() => {
																setMenuKey(null);
																void act(
																	"toggle",
																	x.kind === "package"
																		? { kind: "package", source: x.p.source, scope: x.p.scope, disabled: !isDisabled }
																		: { kind: "extension", path: x.e.path, disabled: !isDisabled },
																	x.key,
																	isDisabled ? (lang === "zh" ? "正在启用..." : "Enabling...") : (lang === "zh" ? "正在停用..." : "Disabling..."),
																	isDisabled ? t.enabled : t.disabled
																);
															}}
														>
															{isDisabled ? t.enablePlugin : t.disablePlugin}
														</button>
														{x.kind === "package" && (
															<>
																<button
																	type="button"
																	role="menuitem"
																	className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--dsw-hover)] cursor-pointer disabled:opacity-50"
																	style={{ color: "var(--dsw-label-secondary)" }}
																	disabled={busy}
																	onClick={() => {
																		setMenuKey(null);
																		void act(
																			"update",
																			{ source: x.p.source },
																			x.key,
																			t.updating,
																			t.updateSuccess
																		);
																	}}
																>
																	{t.update}
																</button>
																<button
																	type="button"
																	role="menuitem"
																	className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--dsw-hover)] cursor-pointer disabled:opacity-50"
																	style={{ color: "var(--dsw-danger)" }}
																	disabled={busy}
																	onClick={() => {
																		setMenuKey(null);
																		void act(
																			"remove",
																			{ source: x.p.source, local: x.p.scope === "project" },
																			x.key,
																			t.uninstalling,
																			t.uninstallSuccess
																		);
																	}}
																>
																	{t.uninstall}
																</button>
															</>
														)}
														<div className="my-1 border-t border-[var(--dsw-border-l1)]" />
														<button
															type="button"
															role="menuitem"
															className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs transition-colors hover:bg-[var(--dsw-hover)] cursor-pointer"
															style={{ color: "var(--dsw-label-tertiary)" }}
															onClick={() => {
																toggle(x.key);
																setMenuKey(null);
															}}
														>
															{open ? (lang === "zh" ? "收起详情" : "Hide details") : (lang === "zh" ? "查看详情" : "View details")}
														</button>
													</div>
												)}
											</div>
										</div>

										{open && (
											<div className="hairline-t flex flex-col gap-2 px-3.5 py-3" style={{ fontSize: 12 }}>
												{x.kind === "package" ? (
													<>
														<div className="break-all" style={{ color: "var(--dsw-label-tertiary)", fontSize: 11.5 }}>
															{x.p.source}
														</div>
														<div className="flex items-center gap-2">
															<span
																className="rounded-md px-1.5 py-0.5"
																style={{ fontSize: 10.5, border: "0.5px solid var(--dsw-border-l3)", color: "var(--dsw-label-tertiary)" }}
															>
																{x.p.scope === "user" ? t.scopeGlobal : t.scopeProject}
															</span>
															<span style={{ color: "var(--dsw-label-caption)", fontSize: 11.5 }}>
																{t.resources}: {x.p.resources.extensions} ext · {x.p.resources.skills} skills · {x.p.resources.prompts} prompts
															</span>
														</div>
														<div className="flex items-center justify-end gap-3 pt-1">
															<button
																disabled={busy}
																style={{ fontSize: 12, color: "var(--dsw-label-secondary)" }}
																className="hover:underline cursor-pointer disabled:opacity-50"
																onClick={() =>
																	void act(
																		"update",
																		{ source: x.p.source },
																		x.key,
																		t.updating,
																		t.updateSuccess
																	)
																}
															>
																{t.update}
															</button>
															<button
																disabled={busy}
																style={{ fontSize: 12, color: "var(--dsw-danger)" }}
																className="hover:underline cursor-pointer disabled:opacity-50"
																onClick={() =>
																	void act(
																		"remove",
																		{ source: x.p.source, local: x.p.scope === "project" },
																		x.key,
																		t.uninstalling,
																		t.uninstallSuccess
																	)
																}
															>
																{t.uninstall}
															</button>
														</div>
													</>
												) : (
													<div className="break-all" style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--dsw-label-caption)" }}>
														{x.e.path}
													</div>
												)}
											</div>
										)}
									</div>
								);
							})}
					</div>
				)}

			</div>
		)}
	</div>
	);
}

