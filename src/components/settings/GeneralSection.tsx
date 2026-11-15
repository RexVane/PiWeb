"use client";

import { safeLocalStorage } from "@/lib/browser-storage";
import { clientFetch as fetch } from "@/lib/client-fetch";


import { useEffect, useRef, useState } from "react";
import { type EnterBehavior, getEnterBehavior, setEnterBehavior as saveEnterBehavior } from "@/lib/enter-behavior";
import { type AttentionNotifySupport, attentionNotifySupport, setAttentionNotify, useAttentionNotifyPreferred } from "@/lib/attention-notify";
import { ProxySettings } from "@/components/ProxySettings";
import { CopyCommand } from "@/components/update/CopyCommand";
import { checkUpdate, loadUpdates, runUpdate, useUpdates, type UpdateTarget } from "@/components/update/update-store";
import { useI18n } from "@/i18n";
import { applyPebrelTheme, DEFAULT_PEBREL_THEME, DEFAULT_THEME_MODE, loadPebrelTheme, loadThemeMode, type PebrelTheme, type ThemeMode } from "@/lib/theme";
import type { PiSettings } from "@/lib/pi-settings";
import { FontSizeStepper, Row, RowColumn, SelectOption } from "./SharedControls";

// ---------- General ----------

export function GeneralSection({
	lang,
	setLang,
}: {
	lang: "zh" | "en";
	setLang: (l: "zh" | "en") => void;
}) {
	const { t } = useI18n();
	const [theme, setTheme] = useState<PebrelTheme>(DEFAULT_PEBREL_THEME);
	const [themeMode, setThemeMode] = useState<ThemeMode>(DEFAULT_THEME_MODE);
	const [fontSize, setFontSize] = useState(14);
	const [chatFontSize, setChatFontSize] = useState(14);
	const [enterBehavior, setEnterBehavior] = useState<EnterBehavior>("steer");
	const [notifySupport, setNotifySupport] = useState<AttentionNotifySupport>("ok");
	// 开关是用户的选择；这个地址发不了通知时显示为关
	const notifyAttention = useAttentionNotifyPreferred() && notifySupport !== "unsupported";
	const [piSettings, setPiSettings] = useState<PiSettings | null>(null);
	const [versions, setVersions] = useState<{ piWeb: string; piEngine: string } | null>(null);
	const [webAuth, setWebAuth] = useState<{ enabled: boolean; authenticated: boolean } | null>(null);
	const [settingsLoading, setSettingsLoading] = useState(true);
	const [settingsSaving, setSettingsSaving] = useState(false);
	const [settingsError, setSettingsError] = useState<"load" | "save" | null>(null);
	/** 服务端给的保存失败原因；有就接在通用提示后面 */
	const [saveErrorDetail, setSaveErrorDetail] = useState("");
	const [settingsWarning, setSettingsWarning] = useState("");
	const settingsRequest = useRef(0);
	const [reserveTokensDraft, setReserveTokensDraft] = useState("");
	const [keepRecentTokensDraft, setKeepRecentTokensDraft] = useState("");
	const [maxRetriesDraft, setMaxRetriesDraft] = useState("");
	const [textDrafts, setTextDrafts] = useState({ httpProxy: "" });
	const [logoutError, setLogoutError] = useState("");

	const loadRemoteSettings = async () => {
		const requestId = ++settingsRequest.current;
		setSettingsLoading(true);
		setSettingsSaving(false);
		setSettingsError(null);
		setSettingsWarning("");
		const request = async (url: string) => {
			const response = await fetch(url);
			const json = await response.json();
			if (!response.ok || !json.success) throw new Error(json.error || `request failed (${response.status})`);
			return json.data;
		};
		const [sec, ps, health, auth] = await Promise.allSettled([
			request("/api/security"),
			request("/api/pi-settings"),
			request("/api/version"),
			request("/api/web-auth"),
		]);
		if (requestId !== settingsRequest.current) return;
		if (ps.status === "fulfilled") {
			setPiSettings(ps.value);
			setReserveTokensDraft(String(ps.value.compaction?.reserveTokens ?? ""));
			setKeepRecentTokensDraft(String(ps.value.compaction?.keepRecentTokens ?? ""));
			setMaxRetriesDraft(String(ps.value.retry.maxRetries));
			setTextDrafts({ httpProxy: ps.value.httpProxy ?? "" });
		} else setPiSettings(null);
		if (health.status === "fulfilled" && health.value?.piWeb) setVersions({ piWeb: health.value.piWeb, piEngine: health.value.piEngine });
		else setVersions(null);
		if (auth.status === "fulfilled" && typeof auth.value?.enabled === "boolean") setWebAuth({ enabled: auth.value.enabled, authenticated: auth.value.authenticated === true });
		else setWebAuth(null);
		if ([sec, ps, health].some((item) => item.status === "rejected")) setSettingsError("load");
		setSettingsLoading(false);
	};

	useEffect(() => {
		setTheme(loadPebrelTheme());
		setThemeMode(loadThemeMode());
		const fs = parseInt(safeLocalStorage.getItem("piweb.fontSize") ?? "14", 10);
		if (!Number.isNaN(fs)) setFontSize(fs);
		const chatFs = parseInt(safeLocalStorage.getItem("piweb.chatFontSize") ?? "14", 10);
		if (!Number.isNaN(chatFs)) setChatFontSize(chatFs);
		setEnterBehavior(getEnterBehavior());
		setNotifySupport(attentionNotifySupport());
		void loadRemoteSettings();
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
		safeLocalStorage.setItem("piweb.fontSize", String(v));
		document.documentElement.style.setProperty("--dsh-content-font-size", `${v}px`);
		document.documentElement.style.setProperty("--dsh-content-font-delta", `${v - 14}px`);
	};

	/** 对话字号：消息正文/用户气泡/输入框 */
	const pickChatFont = (n: number) => {
		const v = Math.max(12, Math.min(20, n));
		setChatFontSize(v);
		safeLocalStorage.setItem("piweb.chatFontSize", String(v));
		document.documentElement.style.setProperty("--piweb-chat-font-size", `${v}px`);
	};

	const pickEnter = (v: EnterBehavior) => {
		setEnterBehavior(v);
		saveEnterBehavior(v);
	};

	const patchPiSettings = async (patch: Record<string, unknown>) => {
		if (!piSettings || settingsSaving) return false;
		setSettingsSaving(true);
		setSettingsError(null);
		setSaveErrorDetail("");
		try {
			const r = await fetch("/api/pi-settings", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(patch),
			});
			const j = await r.json();
			if (!r.ok || !j.success) throw new Error(j.error || "save failed");
			if (j.data?.compaction && j.data?.retry) {
				setPiSettings(j.data);
				if (j.data.compaction.reserveTokens !== undefined) setReserveTokensDraft(String(j.data.compaction.reserveTokens));
				if (j.data.compaction.keepRecentTokens !== undefined) setKeepRecentTokensDraft(String(j.data.compaction.keepRecentTokens));
				if (j.data.retry.maxRetries !== undefined) setMaxRetriesDraft(String(j.data.retry.maxRetries));
			}
			setSettingsWarning(typeof j.warning === "string" ? j.warning : "");
			return true;
		} catch (error) {
			setSettingsError("save");
			setSaveErrorDetail(error instanceof Error && error.message !== "save failed" ? error.message : "");
			return false;
		} finally {
			setSettingsSaving(false);
		}
	};

	/** 网络代理：失焦或回车时保存；保存失败就退回原值 */
	const commitText = async (field: "httpProxy") => {
		if (!piSettings) return;
		const value = textDrafts[field].trim();
		if (value === piSettings[field]) return;
		if (!(await patchPiSettings({ [field]: value }))) setTextDrafts((previous) => ({ ...previous, [field]: piSettings[field] }));
	};

	const commitIntegerSetting = async (
		section: "compaction" | "retry",
		field: "reserveTokens" | "keepRecentTokens" | "maxRetries",
		draft: string,
		setDraft: (value: string) => void,
		saved: number | undefined,
	) => {
		if (!piSettings) return;
		const rollback = saved === undefined ? "" : String(saved);
		const raw = draft.trim();
		const value = Number(raw);
		if (!raw || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) {
			setSettingsError("save");
			setDraft(rollback);
			return;
		}
		if (saved !== undefined && value === saved) return;
		if (!(await patchPiSettings({ [section]: { [field]: value } }))) setDraft(rollback);
	};

	const themes: { id: PebrelTheme; label: string; light: string; dark: string; accent: string }[] = [
		{ id: "dsh", label: t.themeDsh, light: "#FFFFFF", dark: "#040405", accent: "#02DEFC" },
		{ id: "nord-paper", label: t.themeNordPaper, light: "#FCFBF9", dark: "#2E3440", accent: "#88C0D0" },
		{ id: "ripple", label: t.themeRipple, light: "#EBF4F4", dark: "#0A1919", accent: "#2CC5C5" },
		{ id: "dawn", label: t.themeDawn, light: "#FCF7F8", dark: "#251D1E", accent: "#A93755" },
	];

	return (
		<div className="flex flex-col gap-6">
			{(settingsLoading || settingsError) && (
				<div role={settingsError ? "alert" : "status"} className="flex items-center gap-3 rounded-lg px-3 py-2" style={{ background: "var(--dsw-hover)", color: settingsError ? "var(--dsw-danger)" : "var(--dsw-label-secondary)" }}>
					<span className="flex-1">{settingsError === "load" ? t.settingsLoadFailed : settingsError === "save" ? `${t.settingsSaveFailed}${saveErrorDetail ? ` (${saveErrorDetail})` : ""}` : t.settingsLoading}</span>
					{settingsError === "load" && <button type="button" className="pw-chip" onClick={() => void loadRemoteSettings()}>{t.settingsRetry}</button>}
				</div>
			)}
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
			<Row title={t.appearance}>
				<SelectOption
					label={t.appearance}
					value={theme}
					options={themes.map((th) => ({ value: th.id, label: th.label, dotColor: th.accent }))}
					onChange={(v) => pickTheme(v as PebrelTheme)}
				/>
			</Row>
			<RowColumn title={t.appearanceMode}>
				<div className="flex w-full flex-wrap gap-2">
					{([
						{ id: "light", label: t.themeLight },
						{ id: "dark", label: t.themeDark },
						{ id: "system", label: t.themeSystem },
					] as { id: ThemeMode; label: string }[]).map((mode) => (
						<button
							key={mode.id}
							className="isx-card flex flex-col items-center justify-center gap-1"
							style={{
								flex: "1 1 120px",
								padding: "16px 24px",
								borderRadius: 20,
								background: themeMode === mode.id ? "var(--dsw-module-platform)" : "var(--dsw-bg-elevated)",
								color: "var(--dsw-label-primary)",
								fontSize: "var(--dsh-content-font-size)",
								lineHeight: 1.55,
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
					{ value: "steer", label: t.enterSteer },
					{ value: "queue", label: t.enterQueue },
				]}
				onChange={(v) => pickEnter(v as EnterBehavior)}
			/>
			</Row>
			<Row title={t.notifyAttention} desc={notifySupport === "unsupported" ? t.notifyAttentionUnsupported : !notifyAttention || notifySupport === "ok" ? t.notifyAttentionDesc : notifySupport === "blocked" ? t.notifyAttentionBlocked : t.notifyAttentionPending}>
				<button aria-label={t.notifyAttention} disabled={notifySupport === "unsupported"} className="liq-sw flex-none" data-on={notifyAttention ? "true" : undefined} role="switch" aria-checked={notifyAttention} onClick={() => void setAttentionNotify(!notifyAttention).then(setNotifySupport)}>
					<span className="liq-thumb" />
				</button>
			</Row>
			<div role="group" aria-label={t.autoCompact} className="hairline-b flex min-w-0 flex-col gap-4 pb-5">
				<div className="flex items-center justify-between gap-6">
					<div className="min-w-0">
						<div style={{ fontSize: "var(--dsh-content-font-size)" }}>{t.autoCompact}</div>
						<div className="mt-0.5" style={{ fontSize: "var(--dsh-ui-font-xs)", color: "var(--dsw-label-caption)" }}>{t.autoCompactDesc}</div>
					</div>
					<button aria-label={t.autoCompact} disabled={!piSettings || settingsSaving} className="liq-sw flex-none" data-on={piSettings?.compaction.enabled ? "true" : undefined} role="switch" aria-checked={piSettings?.compaction.enabled ?? false} onClick={() => void patchPiSettings({ compaction: { enabled: !piSettings?.compaction.enabled } })}>
						<span className="liq-thumb" />
					</button>
				</div>
				{piSettings?.compaction.enabled && (
					<div className="flex flex-col gap-3 rounded-xl px-3.5 py-3" style={{ background: "var(--dsw-bg-elevated)" }}>
						{[
							{ key: "reserveTokens" as const, label: t.reserveTokens, desc: t.reserveTokensDesc, value: reserveTokensDraft, setValue: setReserveTokensDraft, saved: piSettings.compaction.reserveTokens },
							{ key: "keepRecentTokens" as const, label: t.keepRecentTokens, desc: t.keepRecentTokensDesc, value: keepRecentTokensDraft, setValue: setKeepRecentTokensDraft, saved: piSettings.compaction.keepRecentTokens },
						].map((item) => (
							<div key={item.key} className="flex items-center justify-between gap-6">
								<div className="min-w-0">
									<div style={{ fontSize: "var(--dsh-ui-font-sm)" }}>{item.label}</div>
									<div className="mt-0.5" style={{ fontSize: "var(--dsh-ui-font-xs)", color: "var(--dsw-label-caption)" }}>{item.desc}</div>
								</div>
								<input
									type="number"
									min={0}
									aria-label={item.label}
									value={item.value}
									disabled={!piSettings || settingsLoading || settingsSaving}
									onChange={(event) => item.setValue(event.target.value)}
									onBlur={() => void commitIntegerSetting("compaction", item.key, item.value, item.setValue, item.saved)}
									onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
									className="flex-none rounded-lg px-2 py-1 tabular-nums"
									title={item.label}
									style={{ width: 110, textAlign: "right", background: "var(--dsw-hover)" }}
								/>
							</div>
						))}
					</div>
				)}
			</div>
			<Row title={t.autoRetry} desc={t.autoRetryDesc}>
				<div className="flex items-center gap-2">
					<button aria-label={t.autoRetry} disabled={!piSettings || settingsSaving} className="liq-sw flex-none" data-on={piSettings?.retry.enabled ? "true" : undefined} role="switch" aria-checked={piSettings?.retry.enabled ?? false} onClick={() => void patchPiSettings({ retry: { enabled: !piSettings?.retry.enabled } })}>
						<span className="liq-thumb" />
					</button>
					<input
						type="number"
						min={0}
						aria-label={t.maxRetries}
						value={maxRetriesDraft}
						disabled={!piSettings || settingsLoading || settingsSaving}
						onChange={(event) => setMaxRetriesDraft(event.target.value)}
						onBlur={() => void commitIntegerSetting("retry", "maxRetries", maxRetriesDraft, setMaxRetriesDraft, piSettings?.retry.maxRetries)}
						onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
						className="rounded-lg px-2 py-1"
						title={t.maxRetries}
						style={{ width: 90, textAlign: "right", background: "var(--dsw-hover)" }}
					/>
				</div>
			</Row>
			{settingsWarning && <p role="status" style={{ color: "var(--dsw-warning)" }}>{settingsWarning}</p>}
			<Row title={t.cacheWarming} desc={t.cacheWarmingDesc}>
				<SelectOption
					value={piSettings?.cacheWarming ?? "idle"}
					disabled={!piSettings || settingsSaving}
					options={[
						{ value: "idle", label: t.cacheWarmingIdle },
						{ value: "streaming", label: t.cacheWarmingStreaming },
						{ value: "off", label: t.cacheWarmingOff },
					]}
					onChange={(v) => void patchPiSettings({ cacheWarming: v })}
				/>
			</Row>
			<Row title={t.steeringMode} desc={t.steeringModeDesc}>
				<SelectOption
					label={t.steeringMode}
					value={piSettings?.steeringMode ?? "one-at-a-time"}
					disabled={!piSettings || settingsSaving}
					options={[
						{ value: "one-at-a-time", label: t.queueModeOne },
						{ value: "all", label: t.queueModeAll },
					]}
					onChange={(v) => void patchPiSettings({ steeringMode: v })}
				/>
			</Row>
			<Row title={t.followUpMode} desc={t.followUpModeDesc}>
				<SelectOption
					label={t.followUpMode}
					value={piSettings?.followUpMode ?? "one-at-a-time"}
					disabled={!piSettings || settingsSaving}
					options={[
						{ value: "one-at-a-time", label: t.queueModeOne },
						{ value: "all", label: t.queueModeAll },
					]}
					onChange={(v) => void patchPiSettings({ followUpMode: v })}
				/>
			</Row>
			<Row title={t.httpProxy} desc={t.httpProxyRestart}>
				<ProxySettings value={textDrafts.httpProxy} disabled={!piSettings || settingsLoading || settingsSaving}
					onChange={(httpProxy) => setTextDrafts({ httpProxy })} onCommit={() => void commitText("httpProxy")} />
			</Row>
			<Row title={t.versionPiweb} desc={t.versionPiwebDesc}>
				<div className="flex items-center gap-2.5">
					<VersionLink href="https://github.com/RexVane/PiWeb" value={versions?.piWeb} />
					<UpdateControl target="piweb" />
				</div>
			</Row>
			<Row title={t.versionPi} desc={t.versionPiDesc}>
				<div className="flex items-center gap-2.5">
					<VersionLink href="https://github.com/earendil-works/pi" value={versions?.piEngine} />
					<UpdateControl target="pi" />
				</div>
			</Row>
			{webAuth?.enabled ? (
				<Row title={t.webAuth} desc={t.webAuthTokenOn}>
					<button
						className="btn-outline"
						style={{ height: "max(30px, calc(30px + var(--dsh-content-font-delta)))", padding: "0 14px", fontSize: "var(--dsh-ui-font-125)" }}
						onClick={async () => {
							setLogoutError("");
							try {
								const response = await fetch("/api/web-auth", { method: "DELETE" });
								const result = await response.json();
								if (!response.ok || !result?.success) throw new Error(result?.error || t.remoteFailed);
								window.location.href = "/login";
							} catch (error) { setLogoutError(error instanceof Error ? error.message : t.remoteFailed); }
						}}
					>
						{t.logout}
					</button>
				</Row>
			) : null}
			{logoutError ? <p role="alert" style={{ color: "var(--dsw-danger)" }}>{logoutError}</p> : null}
		</div>
	);
}

/** 版本号文本链接：等宽字体，悬停变主题色（新窗口打开对应仓库） */
function VersionLink({ href, value }: { href: string; value?: string }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			style={{ fontFamily: "var(--font-mono)", fontSize: "var(--dsh-ui-font-sm)", color: "var(--dsw-label-secondary)", textDecoration: "none" }}
			onMouseEnter={(e) => (e.currentTarget.style.color = "var(--dsw-accent)")}
			onMouseLeave={(e) => (e.currentTarget.style.color = "var(--dsw-label-secondary)")}
		>
			{value ?? "—"}
		</a>
	);
}

/** 检查更新 / 更新控件：npm 安装的 piweb 走 npm install -g @rexvane/piweb@latest（服务端固定参数），
 *  Git 检出仍走 git pull + 本地构建；pi 走 npm install @latest（npm 安装只换依赖、不重建）。
 *  状态和右下角提示条共用（update-store）：启动检查的结果一到，这里直接显示「更新到 vX」或「已是最新」。 */
function UpdateControl({ target }: { target: UpdateTarget }) {
	const { t } = useI18n();
	const { phase, latest, command, error, busy: sessionBusy } = useUpdates().targets[target];
	const busy = phase === "checking" || phase === "updating";

	useEffect(() => {
		void loadUpdates();
	}, []);

	if (phase === "idle" || phase === "latest" || phase === "error") {
		const label = phase === "latest" ? t.upToDate : phase === "error" ? (sessionBusy ? t.updateBusy : t.updateFailed) : t.checkUpdate;
		const color = phase === "latest" ? "var(--dsw-label-tertiary)" : phase === "error" ? "var(--dsw-danger)" : "var(--dsw-label-primary)";
		return (
			<button
				type="button"
				className="btn-outline"
				style={{ height: "max(26px, calc(26px + var(--dsh-content-font-delta)))", padding: "0 10px", fontSize: "var(--dsh-ui-font-xs)", color }}
				title={error || undefined}
				disabled={busy}
				onClick={() => void checkUpdate(target)}
			>
				{label}
			</button>
		);
	}
	if (phase === "available") {
		// Windows 无法替换运行中的安装目录（npm 会 EBUSY），此时给命令而不是按钮。
		if (command) {
			return (
				<span className="flex flex-col items-end gap-0.5" style={{ maxWidth: 300 }}>
					<CopyCommand command={command} />
					<span style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-label-tertiary)", textAlign: "right" }}>{t.updateManualHint}</span>
				</span>
			);
		}
		return (
			<button type="button" className="btn-primary-white" style={{ height: 26, padding: "0 12px", fontSize: 12 }} onClick={() => void runUpdate(target)}>
				{t.updateTo.replace("{v}", latest)}
			</button>
		);
	}
	if (phase === "updated") {
		return (
			<span className="flex flex-col items-end gap-0.5" style={{ maxWidth: 280, textAlign: "right" }}>
				<span style={{ fontSize: 12, color: "var(--dsw-success)" }}>{t.updatedTo.replace("{v}", latest)}</span>
				<span style={{ fontSize: 11, color: "var(--dsw-label-tertiary)" }}>{t.updateRestartHint}</span>
			</span>
		);
	}
	return (
		<span className="flex items-center gap-1.5" style={{ fontSize: 12, color: "var(--dsw-label-tertiary)" }}>
			<span className="h-3 w-3 flex-none animate-spin rounded-full border-2 border-current border-t-transparent" />
			{phase === "updating" ? t.updatingNow : t.checkingUpdate}
		</span>
	);
}
