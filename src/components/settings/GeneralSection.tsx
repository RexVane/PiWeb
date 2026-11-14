"use client";

import { safeLocalStorage } from "@/lib/browser-storage";
import { clientFetch as fetch } from "@/lib/client-fetch";


import { useEffect, useRef, useState } from "react";
import { type EnterBehavior, getEnterBehavior, setEnterBehavior as saveEnterBehavior } from "@/lib/enter-behavior";
import { ProxySettings } from "@/components/ProxySettings";
import { CopyCommand } from "@/components/update/CopyCommand";
import { checkUpdate, loadUpdates, runUpdate, useUpdates, type UpdateTarget } from "@/components/update/update-store";
import { useI18n } from "@/i18n";
import { applyPebrelTheme, loadPebrelTheme, loadThemeMode, type PebrelTheme, type ThemeMode } from "@/lib/theme";
import type { PiSettings } from "@/lib/pi-settings";
import { FontSizeStepper, Row, RowColumn, SelectOption } from "./SharedControls";

// ---------- General ----------

export function GeneralSection({
	lang,
	setLang,
	cwd,
}: {
	lang: "zh" | "en";
	setLang: (l: "zh" | "en") => void;
	cwd?: string;
}) {
	const { t } = useI18n();
	const [theme, setTheme] = useState<PebrelTheme>("dsh");
	const [themeMode, setThemeMode] = useState<ThemeMode>("system");
	const [fontSize, setFontSize] = useState(14);
	const [chatFontSize, setChatFontSize] = useState(14);
	const [enterBehavior, setEnterBehavior] = useState<EnterBehavior>("steer");
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
	const [maxRetriesDraft, setMaxRetriesDraft] = useState("");
	const [textDrafts, setTextDrafts] = useState({ httpProxy: "" });
	const [logoutError, setLogoutError] = useState("");
	const [scope, setScope] = useState<"user" | "project">("user");
	const settingsUrl = scope === "project" && cwd ? `/api/pi-settings?cwd=${encodeURIComponent(cwd)}` : "/api/pi-settings";
	const currentSettingsUrl = useRef(settingsUrl);
	currentSettingsUrl.current = settingsUrl;

	const loadRemoteSettings = async () => {
		const requestId = ++settingsRequest.current;
		const targetUrl = settingsUrl;
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
			request(settingsUrl),
			request("/api/version"),
			request("/api/web-auth"),
		]);
		if (requestId !== settingsRequest.current || targetUrl !== currentSettingsUrl.current) return;
		if (ps.status === "fulfilled") {
			setPiSettings(ps.value);
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
		void loadRemoteSettings();
	}, [settingsUrl]);

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
		const targetUrl = settingsUrl;
		try {
			const r = await fetch(settingsUrl, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(patch),
			});
			const j = await r.json();
			if (targetUrl !== currentSettingsUrl.current) return true;
			if (!r.ok || !j.success) throw new Error(j.error || "save failed");
			if (j.data?.compaction && j.data?.retry) setPiSettings(j.data);
			setSettingsWarning(typeof j.warning === "string" ? j.warning : "");
			return true;
		} catch (error) {
			if (targetUrl !== currentSettingsUrl.current) return true;
			setSettingsError("save");
			setSaveErrorDetail(error instanceof Error && error.message !== "save failed" ? error.message : "");
			return false;
		} finally {
			if (targetUrl === currentSettingsUrl.current) setSettingsSaving(false);
		}
	};

	/** 网络代理：失焦或回车时保存；保存失败就退回原值 */
	const commitText = async (field: "httpProxy") => {
		if (!piSettings) return;
		const value = textDrafts[field].trim();
		if (value === piSettings[field]) return;
		if (!(await patchPiSettings({ [field]: value }))) setTextDrafts((previous) => ({ ...previous, [field]: piSettings[field] }));
	};

	const commitMaxRetries = async () => {
		if (!piSettings) return;
		const raw = maxRetriesDraft.trim();
		const value = Number(raw);
		if (!raw || !Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000) {
			setSettingsError("save");
			setMaxRetriesDraft(String(piSettings.retry.maxRetries));
			return;
		}
		if (value === piSettings.retry.maxRetries) return;
		const targetUrl = currentSettingsUrl.current;
		if (!(await patchPiSettings({ retry: { maxRetries: value } })) && currentSettingsUrl.current === targetUrl) setMaxRetriesDraft(String(piSettings.retry.maxRetries));
	};

	const themes: { id: PebrelTheme; label: string; light: string; dark: string; accent: string }[] = [
		{ id: "dsh", label: t.themeDsh, light: "#FFFFFF", dark: "#040405", accent: "#02DEFC" },
		{ id: "silver-steel", label: t.themeSilverSteel, light: "#F3F4F6", dark: "#1A1C24", accent: "#94A3B8" },
		{ id: "limestone-coal", label: t.themeLimestoneCoal, light: "#F0EFEB", dark: "#171717", accent: "#CEB27E" },
		{ id: "linen-moss", label: t.themeLinenMoss, light: "#F2F2EC", dark: "#1E211E", accent: "#A3B3A3" },
		{ id: "nord-paper", label: t.themeNordPaper, light: "#FCFBF9", dark: "#2E3440", accent: "#88C0D0" },
		{ id: "pebrel", label: t.themePebrel, light: "#F3F4F6", dark: "#0F111A", accent: "#52A8FF" },
	];

	return (
		<div className="flex flex-col gap-6">
			{cwd && <Row title={t.workspaceScope} desc={scope === "project" ? cwd : t.skillScopeUserHint}>
			<SelectOption label={t.workspaceScope} value={scope} disabled={settingsSaving} options={[{ value: "user", label: t.skillScopeUser }, { value: "project", label: t.skillScopeProject }]} onChange={(value) => setScope(value as "user" | "project")} />
			</Row>}
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
			<RowColumn title={t.appearance}>
				<div className="flex w-full flex-wrap gap-2">
					{themes.map((th) => (
						<button
							key={th.id}
							className="isx-card flex flex-col items-center justify-center gap-1"
							style={{
								flex: "1 1 150px",
								padding: "20px 32px",
								borderRadius: 20,
								background: theme === th.id ? "var(--dsw-module-platform)" : "var(--dsw-bg-elevated)",
								color: "var(--dsw-label-primary)",
								fontSize: 14,
								lineHeight: "22px",
							}}
							aria-pressed={theme === th.id}
							onClick={() => pickTheme(th.id)}
						>
							<span className="flex items-center overflow-hidden rounded-md" style={{ border: "1px solid var(--dsw-border-l3)", width: 42, height: 20 }}>
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
							className="isx-card flex flex-col items-center justify-center gap-1"
							style={{
								flex: "1 1 120px",
								padding: "16px 24px",
								borderRadius: 20,
								background: themeMode === mode.id ? "var(--dsw-module-platform)" : "var(--dsw-bg-elevated)",
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
					{ value: "steer", label: t.enterSteer },
					{ value: "queue", label: t.enterQueue },
				]}
				onChange={(v) => pickEnter(v as EnterBehavior)}
			/>
			</Row>
			<div role="group" aria-label={t.autoCompact} className="hairline-b flex min-w-0 flex-col gap-4 pb-5">
				<div className="flex items-center justify-between gap-6">
					<div className="min-w-0">
						<div style={{ fontSize: 14 }}>{t.autoCompact}</div>
						<div className="mt-0.5" style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>{t.autoCompactDesc}</div>
					</div>
					<button aria-label={t.autoCompact} disabled={!piSettings || settingsSaving} className="liq-sw flex-none" data-on={piSettings?.compaction.enabled ? "true" : undefined} role="switch" aria-checked={piSettings?.compaction.enabled ?? false} onClick={() => void patchPiSettings({ compaction: { enabled: !piSettings?.compaction.enabled } })}>
						<span className="liq-thumb" />
					</button>
				</div>
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
						onBlur={() => void commitMaxRetries()}
						onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
						className="rounded-lg px-2 py-1"
						title={t.maxRetries}
						style={{ width: 90, textAlign: "right", background: "var(--dsw-hover)" }}
					/>
				</div>
			</Row>
			{scope === "project" && piSettings?.projectTrusted === false && <p role="status">{lang === "en" ? "Project settings are saved here. They take effect after this project is trusted; current chats use personal settings." : "这里编辑项目设置。信任此项目后才会生效，当前会话使用个人设置。"}</p>}
			{settingsWarning && <p role="status" style={{ color: "var(--dsw-warning)" }}>{settingsWarning}</p>}
			<Row title={t.cacheWarming} desc={scope === "project" ? (lang === "en" ? "This setting applies to all projects. Change it under Personal settings." : "此设置对所有项目生效，请在个人设置中修改。") : t.cacheWarmingDesc}>
				<SelectOption
					value={piSettings?.cacheWarming ?? "idle"}
					disabled={!piSettings || settingsSaving || scope === "project"}
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
			{scope === "user" && <Row title={t.httpProxy} desc={t.httpProxyRestart}>
				<ProxySettings value={textDrafts.httpProxy} disabled={!piSettings || settingsLoading || settingsSaving}
					onChange={(httpProxy) => setTextDrafts({ httpProxy })} onCommit={() => void commitText("httpProxy")} />
			</Row>}
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
						style={{ height: 30, padding: "0 14px", fontSize: 12.5 }}
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
			style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--dsw-label-secondary)", textDecoration: "none" }}
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
				style={{ height: 26, padding: "0 10px", fontSize: 12, color }}
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
					<span style={{ fontSize: 11, color: "var(--dsw-label-tertiary)", textAlign: "right" }}>{t.updateManualHint}</span>
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
