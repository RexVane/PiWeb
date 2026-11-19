"use client";
import { clientFetch as fetch } from "@/lib/client-fetch";


import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { IconChevronDown14, IconPlusOutline16, IconWarningOutline16 } from "@/components/icons";
import { ProviderBrand } from "@/components/ProviderBrand";
import { ModelCatalog, ProviderSetupModal, type BuiltinProviderSetup, type CustomProviderSetup } from "@/components/ProviderSetupModal";
import { localizeApiError, useI18n } from "@/i18n";
import type { Lang } from "@/lib/lang";
import { fmtTokens } from "@/lib/format";
import { customModelGaps, fillModelFields, formatCapacity, headerEntriesFromConfig, headerEntriesToConfig, isInertProviderConfig, modelDraftFromCatalog, modelDraftFromConfig, modelDraftsFromProviderConfig, parseCapacity, PI_MODEL_FALLBACKS, serializeProviderDraft, validateHeaderEntries, validateModelDrafts, type CustomModelGap, type ModelDraft, type ModelFieldFill } from "@/lib/model-draft";
import { customApiOptions } from "@/lib/provider-display";
import { quotaWindowKind, supportsUsageProbe, type BalanceAmount, type BalanceDetailKey, type BalanceUsage, type ProviderUsage, type QuotaExtraUsage, type QuotaWindow, type XaiUsage } from "@/lib/provider-usage";
import type { ModelView, ProviderView } from "@/lib/models-service";
import { Field, fieldCls, SelectOption } from "./SharedControls";

// ---------- Models ----------

type AuditRow = { contextWindow: string; maxTokens: string; vision: "" | "image" | "text"; reasoning: "" | "on" | "off" };
const EMPTY_AUDIT_ROW: AuditRow = { contextWindow: "", maxTokens: "", vision: "", reasoning: "" };

/**
 * 模型配置体检：models[] 里有字段没写的模型，pi 会按 PI_MODEL_FALLBACKS / 纯文本处理。
 * 不替用户猜——空着的格子由用户填（支持 256K / 1M 写法），保存时只补空字段，已写的值不改。
 */
function ModelFieldAudit({ gaps, providerLabel, busy, onSave }: {
	gaps: CustomModelGap[];
	providerLabel: (id: string) => string;
	busy: boolean;
	/** 保存成功返回 true（之后清空填写） */
	onSave: (fills: ModelFieldFill[]) => Promise<boolean>;
}) {
	const { t, lang } = useI18n();
	const fieldLabels = { contextWindow: t.modelAuditColContext, maxTokens: t.modelAuditColOutput, input: t.modelAuditColVision, reasoning: t.reasoningLabel };
	const [rows, setRows] = useState<Record<string, AuditRow>>({});
	const identities = new Map<string, number>();
	for (const gap of gaps) {
		const id = JSON.stringify([gap.provider, gap.id]);
		identities.set(id, (identities.get(id) ?? 0) + 1);
	}
	// 409 后重载可能改变 models[] 的顺序，未保存的输入要跟随模型 ID，不能落到原位置的新模型上。
	// 手写重复 ID 无法稳定区分时，把位置和可见声明也纳入身份；宁可重新填写，也不能串行。
	const keyOf = (gap: CustomModelGap) => {
		const id = JSON.stringify([gap.provider, gap.id]);
		return identities.get(id) === 1 ? id : JSON.stringify([gap.provider, gap.id, gap.index, gap.name, gap.contextWindow, gap.maxTokens, gap.vision, gap.reasoning, gap.missing]);
	};
	const rowOf = (gap: CustomModelGap) => rows[keyOf(gap)] ?? EMPTY_AUDIT_ROW;
	const edit = (gap: CustomModelGap, patch: Partial<AuditRow>) =>
		setRows((current) => ({ ...current, [keyOf(gap)]: { ...(current[keyOf(gap)] ?? EMPTY_AUDIT_ROW), ...patch } }));
	const visionGaps = gaps.filter((gap) => gap.missing.includes("input"));
	const markVision = (vision: "image" | "text") =>
		setRows((current) => {
			const next = { ...current };
			for (const gap of visionGaps) next[keyOf(gap)] = { ...(next[keyOf(gap)] ?? EMPTY_AUDIT_ROW), vision };
			return next;
		});

	// 每行填的文本 → 要写的值；有一格格式不对就不让保存（那一格标红）
	let invalid = false;
	const fills: ModelFieldFill[] = [];
	for (const gap of gaps) {
		const row = rows[keyOf(gap)];
		if (!row) continue;
		const contextWindow = gap.missing.includes("contextWindow") ? parseCapacity(row.contextWindow) : undefined;
		const maxTokens = gap.missing.includes("maxTokens") ? parseCapacity(row.maxTokens) : undefined;
		if (Number.isNaN(contextWindow) || Number.isNaN(maxTokens)) {
			invalid = true;
			continue;
		}
		const vision = gap.missing.includes("input") && row.vision ? row.vision === "image" : undefined;
		const reasoning = gap.missing.includes("reasoning") && row.reasoning ? row.reasoning === "on" : undefined;
		if (contextWindow === undefined && maxTokens === undefined && vision === undefined && reasoning === undefined) continue;
		fills.push({ provider: gap.provider, index: gap.index, id: gap.id, contextWindow, maxTokens, vision, reasoning });
	}

	const save = async (useDefaults = false) => {
		const saveFills = useDefaults ? gaps.map((gap) => {
			const fill = fills.find((entry) => entry.provider === gap.provider && entry.index === gap.index && entry.id === gap.id);
			return {
				provider: gap.provider, index: gap.index, id: gap.id,
				contextWindow: gap.missing.includes("contextWindow") ? fill?.contextWindow ?? PI_MODEL_FALLBACKS.contextWindow : undefined,
				maxTokens: gap.missing.includes("maxTokens") ? fill?.maxTokens ?? PI_MODEL_FALLBACKS.maxTokens : undefined,
				vision: gap.missing.includes("input") ? fill?.vision ?? PI_MODEL_FALLBACKS.vision : undefined,
				reasoning: gap.missing.includes("reasoning") ? fill?.reasoning ?? PI_MODEL_FALLBACKS.reasoning : undefined,
			};
		}) : fills;
		if (await onSave(saveFills)) setRows({});
	};

	const capacityCell = (gap: CustomModelGap, field: "contextWindow" | "maxTokens", label: string) => {
		if (!gap.missing.includes(field)) {
			return (
				<span className="truncate" style={{ fontFamily: "var(--font-mono)", color: "var(--dsw-label-secondary)" }}>
					<span className="sm:hidden" style={{ color: "var(--dsw-label-caption)" }}>{label} </span>
					{formatCapacity(gap[field]) || "—"}
				</span>
			);
		}
		const text = rowOf(gap)[field];
		return (
			<input
				className="pw-audit-field"
				style={{ fontFamily: "var(--font-mono)" }}
				value={text}
				onChange={(event) => edit(gap, { [field]: event.target.value })}
				placeholder={label}
				aria-label={`${gap.id} ${label}`}
				aria-invalid={Number.isNaN(parseCapacity(text)) || undefined}
				disabled={busy}
			/>
		);
	};

	return (
		<section className="flex flex-col gap-3 rounded-2xl p-4" style={{ border: "0.5px solid var(--dsw-border-l3)", background: "var(--dsw-hover)" }} data-testid="model-audit">
			<div className="flex items-start gap-2.5">
				<IconWarningOutline16 size={16} style={{ flex: "none", marginTop: 1, color: "var(--dsw-warn)" }} />
				<div className="min-w-0 flex-1">
					<div style={{ fontSize: "var(--dsh-ui-font-135)", fontWeight: 600 }}>{t.modelAuditTitle.replace("{n}", String(gaps.length))}</div>
					<div className="mt-1" style={{ fontSize: "var(--dsh-ui-font-xs)", color: "var(--dsw-label-caption)", lineHeight: 1.65 }}>
						{t.modelAuditDesc
							.replace("{ctx}", formatCapacity(PI_MODEL_FALLBACKS.contextWindow))
							.replace("{out}", formatCapacity(PI_MODEL_FALLBACKS.maxTokens))}
					</div>
				</div>
			</div>

			<div style={{ fontSize: "var(--dsh-ui-font-125)" }} role="table" aria-label={t.modelAuditTitle.replace("{n}", String(gaps.length))}>
				<div role="row" className="hidden gap-x-2 px-1 pb-1.5 sm:grid sm:grid-cols-[minmax(0,1fr)_80px_80px_108px_104px]" style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-label-caption)" }}>
					<span role="columnheader">{t.modelAuditColModel}</span>
					<span role="columnheader">{t.modelAuditColContext}</span>
					<span role="columnheader">{t.modelAuditColOutput}</span>
					<span role="columnheader">{t.modelAuditColVision}</span>
					<span role="columnheader">{t.reasoningLabel}</span>
				</div>
				<div className="max-h-[320px] overflow-y-auto" style={{ borderTop: "0.5px solid var(--dsw-border-l2)" }}>
					{gaps.map((gap) => (
						<div
							key={keyOf(gap)}
							role="rowgroup"
							style={{ borderBottom: "0.5px solid var(--dsw-border-l1)" }}
						>
							<div role="row" className="grid grid-cols-2 items-center gap-x-2 gap-y-1.5 px-1 py-2 sm:grid-cols-[minmax(0,1fr)_80px_80px_108px_104px]">
								<div role="cell" className="col-span-2 min-w-0 sm:col-span-1" title={`${gap.provider} / ${gap.id}`}>
									<div className="truncate" style={{ fontWeight: 500 }}>{gap.name ?? gap.id}</div>
									<div className="truncate" style={{ fontSize: "var(--dsh-ui-font-2xs)", fontFamily: "var(--font-mono)", color: "var(--dsw-label-caption)" }}>
										{providerLabel(gap.provider)} / {gap.id}
									</div>
								</div>
								<div role="cell" className="min-w-0">{capacityCell(gap, "contextWindow", t.modelAuditColContext)}</div>
								<div role="cell" className="min-w-0">{capacityCell(gap, "maxTokens", t.modelAuditColOutput)}</div>
								<div role="cell" className="min-w-0">
									{/* 输入类型：文本 pi 总是接受（勾上不可点），图片这一勾就是 models.json 的 input 里加 image */}
									<div className="flex flex-col gap-1">
										<div className="flex items-center gap-3" role="group" aria-label={`${gap.id} ${t.modelAuditColVision}`}>
											<label className="flex cursor-default items-center gap-1" style={{ color: "var(--dsw-label-tertiary)" }} title={t.visionInputTextHint}>
												<input type="checkbox" checked disabled readOnly />
												{t.visionInputText}
											</label>
											<label className="flex items-center gap-1" style={{ color: "var(--dsw-label-secondary)" }} title={t.visionInputImageHint}>
												<input
													type="checkbox"
													checked={gap.missing.includes("input") ? rowOf(gap).vision === "image" : gap.vision === true}
													disabled={busy || !gap.missing.includes("input")}
													onChange={(event) => edit(gap, { vision: event.target.checked ? "image" : "text" })}
													aria-label={`${gap.id} ${t.visionInputImage}`}
												/>
												{t.visionInputImage}
											</label>
										</div>
										{gap.missing.includes("input") && rowOf(gap).vision === "" && (
											<button type="button" className="text-left underline" style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-label-caption)" }}
												disabled={busy} aria-label={`${gap.id} ${t.modelAuditTextOnly}`} onClick={() => edit(gap, { vision: "text" })}>
												{t.modelAuditTextOnly}
											</button>
										)}
										{gap.missing.includes("input") && rowOf(gap).vision === "text" && (
											<span style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-label-caption)" }}>{t.visionOff}</span>
										)}
									</div>
								</div>
								<div role="cell" className="min-w-0" title={t.reasoningHint}>
									{gap.missing.includes("reasoning") ? (
										<select className="pw-audit-field" aria-label={`${gap.id} ${t.reasoningLabel}`} value={rowOf(gap).reasoning} disabled={busy}
											onChange={(event) => edit(gap, { reasoning: event.target.value as AuditRow["reasoning"] })}>
											<option value="">{t.reasoningUnset}</option>
											<option value="on">{t.reasoningOn}</option>
											<option value="off">{t.reasoningOff}</option>
										</select>
									) : <span style={{ color: "var(--dsw-label-secondary)" }}>{gap.reasoning ? t.reasoningOn : t.reasoningOff}</span>}
								</div>
							</div>
							<div role="row">
								<div role="cell" aria-colspan={5} className="px-1 pb-2" style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-warn)" }}>
									{t.modelAuditRemaining.replace("{fields}", gap.missing.map((field) => fieldLabels[field]).join(lang === "zh" || lang === "zh-Hant" ? "、" : ", "))}
								</div>
							</div>
						</div>
					))}
				</div>
			</div>

			<div className="flex flex-wrap items-center gap-2">
				{visionGaps.length > 0 ? (
					<>
						<span style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>{t.modelAuditVisionQuick}</span>
						<button className="btn-outline" style={{ height: 28, padding: "0 11px", fontSize: 12.5 }} disabled={busy} onClick={() => markVision("image")}>{t.modelAuditVisionOn}</button>
						<button className="btn-outline" style={{ height: 28, padding: "0 11px", fontSize: 12.5 }} disabled={busy} onClick={() => markVision("text")}>{t.modelAuditVisionOff}</button>
					</>
				) : null}
				<span className="flex-1" />
				<button className="btn-outline" style={{ height: 32 }} disabled={busy || invalid} onClick={() => void save(true)}>
					{t.modelAuditUseDefaults}
				</button>
				<button className="btn-primary-white" style={{ height: 32 }} disabled={busy || invalid || fills.length === 0} onClick={() => void save()}>
					{busy ? t.saving : fills.length ? t.modelAuditSave.replace("{n}", String(fills.length)) : t.modelAuditSaveIdle}
				</button>
			</div>
			<p style={{ fontSize: 11.5, lineHeight: 1.6, color: "var(--dsw-label-caption)" }}>
				{t.modelAuditDefaultsHint.replace("{ctx}", formatCapacity(PI_MODEL_FALLBACKS.contextWindow)).replace("{out}", formatCapacity(PI_MODEL_FALLBACKS.maxTokens))}
			</p>
		</section>
	);
}

export function ModelsSection({ onChanged }: { onChanged?: () => void | Promise<void> }) {
	const { t, lang } = useI18n();
	const { confirm, confirmDialog } = useConfirmDialog();
	const [providers, setProviders] = useState<ProviderView[]>([]);
	const [catalogModels, setCatalogModels] = useState<ModelView[]>([]);
	const [custom, setCustom] = useState<{ providers: Record<string, any>; [key: string]: unknown }>({ providers: {} });
	const [customRevision, setCustomRevision] = useState<string | null>(null);
	const [secretProviderIds, setSecretProviderIds] = useState<Set<string>>(new Set());
	const [secretHeaderKeys, setSecretHeaderKeys] = useState<Record<string, string[]>>({});
	// 内置 provider → 目录里的模型 ID：编辑时同 ID 的行写 modelOverrides，「获取可用模型」里不再可选
	const [catalogModelIds, setCatalogModelIds] = useState<Record<string, string[]>>({});
	const [editing, setEditing] = useState<string | null>(null);
	const editBaseRevision = useRef<string | null>(null);
	const [adding, setAdding] = useState<"builtin" | "custom" | null>(null);
	const [editBusy, setEditBusy] = useState(false);
	const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
	const [oauthProvider, setOauthProvider] = useState<string | null>(null);
	const [oauthPrompt, setOauthPrompt] = useState<{ type: string; message: string; placeholder?: string; options?: Array<{ label: string; value: string }> } | null>(null);
	const [oauthLog, setOauthLog] = useState<string[]>([]);
	const [oauthDone, setOauthDone] = useState<{ ok: boolean; msg: string } | null>(null);
	const [oauthCodeCopied, setOauthCodeCopied] = useState(false);

	// 设备码/授权链接流程（xAI/Codex/Copilot/Kimi 发 device_code；Anthropic/OpenRouter 发 auth_url）：
	// SDK 经 notify 发 JSON 事件，解析出授权链接（设备码流程附用户码）
	const oauthDeviceCode = useMemo(() => {
		for (let i = oauthLog.length - 1; i >= 0; i--) {
			const line = oauthLog[i];
			if (!line.startsWith("{")) continue;
			try {
				const parsed = JSON.parse(line) as { type?: string; userCode?: string; verificationUri?: string; url?: string; instructions?: string };
				if (parsed.type === "device_code" && typeof parsed.verificationUri === "string") {
					return { userCode: typeof parsed.userCode === "string" ? parsed.userCode : "", verificationUri: parsed.verificationUri, instructions: "" };
				}
				if (parsed.type === "auth_url" && typeof parsed.url === "string") {
					return { userCode: "", verificationUri: parsed.url, instructions: typeof parsed.instructions === "string" ? parsed.instructions : "" };
				}
			} catch {
				/* 非 JSON 的 notify 行忽略 */
			}
		}
		return null;
	}, [oauthLog]);

	// 拿到设备码后自动打开授权页一次；被弹窗拦截时仍有可见链接可点
	const openedDeviceUriRef = useRef<string | null>(null);
	useEffect(() => {
		if (!oauthDeviceCode?.verificationUri || openedDeviceUriRef.current === oauthDeviceCode.verificationUri) return;
		openedDeviceUriRef.current = oauthDeviceCode.verificationUri;
		window.open(oauthDeviceCode.verificationUri, "_blank", "noopener");
	}, [oauthDeviceCode]);

	const copyDeviceCode = () => {
		if (!oauthDeviceCode?.userCode) return;
		const text = oauthDeviceCode.userCode;
		const done = () => {
			setOauthCodeCopied(true);
			setTimeout(() => setOauthCodeCopied(false), 2000);
		};
		void navigator.clipboard.writeText(text).then(done).catch(() => {
			const area = document.createElement("textarea");
			area.value = text;
			document.body.appendChild(area);
			area.select();
			document.execCommand("copy");
			area.remove();
			done();
		});
	};

	const load = useCallback(async () => {
		try {
			const r = await fetch("/api/models?custom=1");
			const j = await r.json();
			if (!r.ok || !j.success) throw Object.assign(new Error(j.error || "failed to load model configuration"), { errorCode: j.errorCode });
			const parsed = JSON.parse(j.data.customProviders?.content ?? "{}");
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || (parsed.providers !== undefined && (!parsed.providers || typeof parsed.providers !== "object" || Array.isArray(parsed.providers)))) {
				throw new Error("invalid model configuration");
			}
			if (j.data.providers.some((provider: ProviderView) => provider.authError)) setToast({ ok: false, msg: j.data.providers.filter((provider: ProviderView) => provider.authError).map((provider: ProviderView) => `${provider.name}: ${provider.authError}`).join("；") });
			setProviders(j.data.providers);
			setCatalogModels(j.data.models ?? []);
			setCatalogModelIds(j.data.catalogModelIds ?? {});
			setSecretProviderIds(new Set(j.data.customProviders?.secretProviderIds ?? []));
			setSecretHeaderKeys(j.data.customProviders?.secretHeaderKeys ?? {});
			setCustom({ ...parsed, providers: parsed.providers ?? {} });
			setCustomRevision(typeof j.data.customProviders?.revision === "string" ? j.data.customProviders.revision : null);
		} catch (error) {
			setCustomRevision(null);
			const code = (error as { errorCode?: string }).errorCode;
			const message = error instanceof Error ? error.message : "failed to load model configuration";
			setToast({ ok: false, msg: localizeApiError(lang, code, message) });
		}
	}, [lang]);
	const thinkingPending = catalogModels.some((model) => model.thinkingProbePending);
	useEffect(() => {
		if (!thinkingPending) return;
		const timer = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 5000);
		return () => clearInterval(timer);
	}, [thinkingPending, load]);
	const changed = useCallback(async () => {
		await onChanged?.();
	}, [onChanged]);

	useEffect(() => {
		void load();
	}, [load]);

	// OAuth 状态轮询
	useEffect(() => {
		if (!oauthProvider) return;
		let alive = true;
		let finished = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const poll = async () => {
			try {
				const r = await fetch("/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "loginState", providerId: oauthProvider }) });
				const j = await r.json();
				if (!alive || !j.success) return;
				setOauthPrompt(j.data.prompt);
				setOauthLog(j.data.notifyLog ?? []);
				if (j.data.done) {
					finished = true;
					setOauthDone({ ok: !j.data.error, msg: j.data.error ?? `${oauthProvider} ✓` });
					if (!j.data.error) await Promise.all([load(), changed()]);
				}
			} catch {
				// 短暂断线后继续轮询，不能留下未处理的 Promise 拒绝。
			} finally {
				if (alive && !finished) timer = setTimeout(poll, 1500);
			}
		};
		void poll();
		return () => { alive = false; if (timer) clearTimeout(timer); };
	}, [oauthProvider, load, changed]);

	// xAI 订阅配额（x-ratelimit-* 响应头；后端 5 分钟缓存，force 跳过）
	const [xaiUsage, setXaiUsage] = useState<XaiUsage | null>(null);
	const [usageBusy, setUsageBusy] = useState(false);
	const [usageError, setUsageError] = useState(false);
	const fetchUsage = useCallback(async (force: boolean) => {
		setUsageBusy(true);
		setUsageError(false);
		try {
			const r = await fetch("/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "providerUsage", providerId: "xai", force }) });
			const j = await r.json();
			if (!r.ok || !j.success) throw new Error(j.error || "usage probe failed");
			setXaiUsage(j.data.usage ?? null);
		} catch {
			setUsageError(true);
		} finally {
			setUsageBusy(false);
		}
	}, []);

	// 窗口制/余额制配额：各提供商走各自的只读端点（后端有 5 分钟缓存，force 跳过）
	const [providerUsages, setProviderUsages] = useState<Record<string, ProviderUsage | null>>({});
	const [usageBusyId, setUsageBusyId] = useState<string | null>(null);
	const [usageFailedIds, setUsageFailedIds] = useState<Record<string, boolean>>({});
	const usageFetchAt = useRef(new Map<string, number>());
	const fetchProviderUsage = useCallback(async (providerId: string, force: boolean, silent = false) => {
		// 静默刷新（定时器 / 切回页面）不闪「探测中」，失败了也不把卡片打成失败，保留上一次的数据
		if (!silent) setUsageBusyId(providerId);
		usageFetchAt.current.set(providerId, Date.now());
		try {
			const r = await fetch("/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "providerUsage", providerId, force }) });
			const j = await r.json();
			if (!r.ok || !j.success) throw new Error(j.error || "usage probe failed");
			setProviderUsages((prev) => ({ ...prev, [providerId]: j.data.usage ?? null }));
			setUsageFailedIds((prev) => (prev[providerId] ? { ...prev, [providerId]: false } : prev));
		} catch {
			if (!silent) setUsageFailedIds((prev) => ({ ...prev, [providerId]: true }));
		} finally {
			if (!silent) setUsageBusyId((current) => (current === providerId ? null : current));
		}
	}, []);

	// 这些端点都是只读探测、不消耗额度：进页面先各取一次；之后每 60 秒自动刷新一次，切回页面时也补一次。
	// 自动刷新必须带 force：不跳过服务端 5 分钟缓存的话，拿到的永远是同一份旧数据，看起来就像没自动刷新。
	// 连续切标签页/开关弹窗时 45 秒内不重复探测。xAI 那条会发一次可能计费的请求，仍然只手动触发。
	const USAGE_AUTO_REFRESH_MS = 60_000;
	const USAGE_AUTO_REFRESH_MIN_GAP_MS = 45_000;
	const requestedUsage = useRef(new Set<string>());
	useEffect(() => {
		const eligible = providers.filter((p) => p.authReady && !p.authCommand && supportsUsageProbe(p.id) && p.id !== "xai");
		if (!eligible.length) return;
		for (const p of eligible) {
			if (requestedUsage.current.has(p.id)) continue;
			requestedUsage.current.add(p.id);
			void fetchProviderUsage(p.id, false);
		}
		const refresh = () => {
			const now = Date.now();
			for (const p of eligible) {
				if (now - (usageFetchAt.current.get(p.id) ?? 0) < USAGE_AUTO_REFRESH_MIN_GAP_MS) continue;
				void fetchProviderUsage(p.id, true, true);
			}
		};
		const timer = setInterval(refresh, USAGE_AUTO_REFRESH_MS);
		const onVisible = () => { if (document.visibilityState === "visible") refresh(); };
		document.addEventListener("visibilitychange", onVisible);
		return () => {
			clearInterval(timer);
			document.removeEventListener("visibilitychange", onVisible);
		};
	}, [providers, fetchProviderUsage]);

	// 倒计时与「几分钟前更新」需要一个会走的时钟：60 秒一跳，够准也不会让设置页频繁重绘
	const [nowTick, setNowTick] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNowTick(Date.now()), 60_000);
		return () => clearInterval(timer);
	}, []);

	// 窗口时长 → 标签：7 天叫「周限」、30 天叫「月限」，更短的按小时/天如实标注
	const quotaWindowLabel = (seconds: number): string => {
		const kind = quotaWindowKind(seconds);
		if (kind === "weekly") return t.usageWindowWeekly;
		if (kind === "monthly") return t.usageWindowMonthly;
		return (kind === "hours" ? t.usageWindowHours : t.usageWindowDays).replace("{n}", String(Math.round(seconds / (kind === "hours" ? 3600 : 86400))));
	};
	// 服务端不给周期时（Copilot 的额度类别、OpenCode 的 rolling、Codex 的代码审查、智谱的 MCP 工具）按名字标注
	const quotaWindowName = (name: string): string => {
		if (name === "premium") return t.usageWindowPremium;
		if (name === "chat") return t.usageWindowChat;
		if (name === "completions") return t.usageWindowCompletions;
		if (name === "rolling") return t.usageWindowRolling;
		if (name === "mcp") return t.usageWindowMcp;
		if (name === "codeReview") return t.usageWindowCodeReview;
		return titleCase(name);
	};
	const quotaVariantLabel = (variant: string): string => {
		if (variant === "opus") return t.usageVariantOpus;
		if (variant === "code") return t.usageVariantCode;
		return titleCase(variant);
	};
	// 标题三种来源可以并存：周期（周限/5 小时）、服务端给的用途名（代码审查/MCP 工具）、同类周期里的变体（Sonnet/Opus）。
	// 例：Codex 的代码审查窗口既是 5 小时窗又有用途名，只显示周期会和普通 5 小时窗混在一起。
	const quotaWindowHeading = (w: QuotaWindow): string => {
		const parts: string[] = [];
		if (w.limitWindowSeconds !== undefined) parts.push(quotaWindowLabel(w.limitWindowSeconds));
		if (w.name) parts.push(quotaWindowName(w.name));
		return `${parts.join(" · ")}${w.variant ? ` (${quotaVariantLabel(w.variant)})` : ""}`;
	};

	// 余额明细项的标签由界面翻译，服务端只给语义 key
	const balanceDetailLabel = (key: BalanceDetailKey): string => {
		if (key === "granted") return t.usageBalanceGranted;
		if (key === "toppedUp") return t.usageBalanceToppedUp;
		if (key === "voucher") return t.usageBalanceVoucher;
		if (key === "cash") return t.usageBalanceCash;
		if (key === "used") return t.usageBalanceUsed;
		return t.usageBalanceLimit;
	};
	// 结构条的色块只表达语义，标签照旧由界面翻译
	const balanceDetailColor = (key: BalanceDetailKey): string => {
		if (key === "granted") return "var(--dsw-accent)";
		if (key === "toppedUp") return "var(--dsw-success)";
		if (key === "voucher") return "var(--dsw-warn)";
		if (key === "limit") return "var(--dsw-border-l3)";
		return "var(--dsw-label-tertiary)";
	};
	const fmtAmount = (value: BalanceAmount): string => `${value.currency === "USD" ? "$" : value.currency === "CNY" ? "¥" : ""}${value.amount}${value.currency && value.currency !== "USD" && value.currency !== "CNY" ? ` ${value.currency}` : ""}`;
	/** 只用来算比例；拿不到数字就当 0，不猜。 */
	const amountValue = (value: BalanceAmount | undefined): number => {
		if (!value) return 0;
		const parsed = Number(value.amount);
		return Number.isFinite(parsed) ? parsed : 0;
	};

	// 重置倒计时：分钟 → 小时 → 天，粗一档；悬停给精确时刻。上游没给重置时间就整行不显示
	const resetCountdown = (value: string | undefined): { text?: string; title?: string } => {
		if (!value) return {};
		const at = new Date(value);
		if (Number.isNaN(at.getTime())) return {};
		const title = fmtQuotaReset(value, lang);
		const diff = at.getTime() - nowTick;
		if (diff <= 0) return { text: t.usageResetDueNow, title };
		const minutes = Math.max(1, Math.round(diff / 60000));
		if (minutes < 60) return { text: t.usageResetsInMinutes.replace("{n}", String(minutes)), title };
		const hours = Math.round(minutes / 60);
		if (hours < 48) return { text: t.usageResetsInHours.replace("{n}", String(hours)), title };
		return { text: t.usageResetsInDays.replace("{n}", String(Math.round(hours / 24))), title };
	};

	// 探测时刻 → 「3 分钟前更新」
	const stampLabel = (probedAt: number): string => {
		const minutes = Math.max(0, Math.round((nowTick - probedAt) / 60000));
		if (minutes < 1) return t.usageUpdatedJustNow;
		if (minutes < 60) return t.usageUpdatedMinutesAgo.replace("{n}", String(minutes));
		const hours = Math.round(minutes / 60);
		if (hours < 24) return t.usageUpdatedHoursAgo.replace("{n}", String(hours));
		return t.usageUpdatedDaysAgo.replace("{n}", String(Math.round(hours / 24)));
	};

	const usageBadge = (label: string, tone: "muted" | "danger" = "muted") => (
		<span
			className="flex-none rounded-md px-1.5 py-0.5"
			style={{
				fontSize: "var(--dsh-ui-font-2xs)",
				border: `0.5px solid ${tone === "danger" ? "var(--dsw-danger)" : "var(--dsw-border-l3)"}`,
				color: tone === "danger" ? "var(--dsw-danger)" : "var(--dsw-label-secondary)",
			}}
		>
			{label}
		</span>
	);

	/** 条形容器：占比由调用方给，颜色已经带语义 */
	const meterBar = (percent: number, tone: string, height = 6) => (
		<div className="w-full overflow-hidden rounded-full" style={{ height, background: "var(--dsw-selector)" }}>
			<div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, percent))}%`, background: tone }} />
		</div>
	);

	// 一个配额窗口 = 一张小卡：名字 + 剩余% + 进度条 + 倒计时（有精确次数就并排给出）
	const renderQuotaCard = (w: QuotaWindow, index: number) => {
		const tone = quotaToneColor(w.remainingPercent);
		const countdown = resetCountdown(w.resetAt);
		const exact = w.remaining !== undefined && w.limit !== undefined
			? t.usageWindowExact.replace("{remaining}", String(w.remaining)).replace("{limit}", String(w.limit))
			: undefined;
		return (
			<div key={`${w.limitWindowSeconds ?? w.name ?? "window"}-${w.variant ?? ""}-${index}`} className="flex min-w-0 flex-col gap-1.5 rounded-lg px-2.5 py-2" style={{ border: "0.5px solid var(--dsw-border-l2)" }}>
				<div className="flex items-baseline justify-between gap-2">
					<span className="truncate" style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-label-secondary)" }}>{quotaWindowHeading(w)}</span>
					<span style={{ fontSize: 15, lineHeight: 1, fontWeight: 600, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", color: tone }}>{w.remainingPercent}%</span>
				</div>
				{meterBar(w.remainingPercent, tone)}
				{(countdown.text || exact) && (
					<div className="flex items-baseline justify-between gap-2" style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-label-caption)" }}>
						{countdown.text ? <span className="truncate" title={countdown.title}>{countdown.text}</span> : <span />}
						{exact && <span className="flex-none" style={{ fontVariantNumeric: "tabular-nums", color: "var(--dsw-label-secondary)" }}>{exact}</span>}
					</div>
				)}
			</div>
		);
	};

	// 订阅附带的按量池：Claude 的 extra_usage、Codex 的 credits
	const renderExtraPool = (extra: QuotaExtraUsage) => {
		const label = extra.kind === "credits" ? t.usageCredits : t.usageExtraUsage;
		const parts: string[] = [];
		if (extra.used) parts.push(`${t.usageBalanceUsed} ${fmtAmount(extra.used)}`);
		if (extra.limit) parts.push(`${t.usageBalanceLimit} ${fmtAmount(extra.limit)}`);
		if (extra.balance) parts.push(`${t.usageQuotaRemaining} ${fmtAmount(extra.balance)}`);
		const tone = extra.remainingPercent === undefined ? "var(--dsw-label-tertiary)" : quotaToneColor(extra.remainingPercent);
		return (
			<div className="flex min-w-0 flex-col gap-1.5 rounded-lg px-2.5 py-2" style={{ border: "0.5px solid var(--dsw-border-l2)" }}>
				<div className="flex items-baseline justify-between gap-2">
					<span style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-label-secondary)" }}>{label}</span>
					{extra.limitReached ? (
						<span style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-danger)" }}>{t.usageLimitReached}</span>
					) : extra.unlimited ? (
						<span style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-label-caption)" }}>{t.usageCreditsUnlimited}</span>
					) : extra.remainingPercent !== undefined ? (
						<span style={{ fontSize: 15, lineHeight: 1, fontWeight: 600, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", color: tone }}>{extra.remainingPercent}%</span>
					) : null}
				</div>
				{extra.remainingPercent !== undefined && !extra.unlimited && meterBar(extra.remainingPercent, tone)}
				{parts.length > 0 && <span style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-label-caption)", fontVariantNumeric: "tabular-nums" }}>{parts.join(" · ")}</span>}
			</div>
		);
	};

	// 余额制：大号金额与语义标签 + 结构条（赠金/充值…）或消耗条（已用/上限）+ 日周月消耗
	const renderBalance = (usage: BalanceUsage) => {
		const stack = usage.details.filter((detail) => detail.key === "granted" || detail.key === "toppedUp" || detail.key === "voucher" || detail.key === "cash");
		const stackTotal = stack.reduce((sum, detail) => sum + amountValue(detail), 0);
		const limit = usage.details.find((detail) => detail.key === "limit");
		const used = usage.details.find((detail) => detail.key === "used");
		const limitValue = amountValue(limit);
		const usedValue = amountValue(used);
		const usedShare = limitValue > 0 ? Math.min(100, Math.max(0, (usedValue / limitValue) * 100)) : undefined;
		const periods = usage.periodSpend ?? [];
		return (
			<div className="flex flex-col gap-1.5">
				<div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
					<span style={{ fontSize: 20, lineHeight: 1.1, fontWeight: 600, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", color: "var(--dsw-label-primary)" }}>{usage.primary ? fmtAmount(usage.primary) : "—"}</span>
					<span style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-label-caption)" }}>{usage.primaryKey === "used" ? t.usageBalanceUsed : t.usageQuotaRemaining}</span>
				</div>
				{stackTotal > 0 && (
					<div className="flex w-full overflow-hidden rounded-full" style={{ height: 6, background: "var(--dsw-selector)" }}>
						{stack.map((detail) => (
							<span key={detail.key} className="h-full flex-none" title={`${balanceDetailLabel(detail.key)} ${fmtAmount(detail)}`} style={{ width: `${(amountValue(detail) / stackTotal) * 100}%`, background: balanceDetailColor(detail.key) }} />
						))}
					</div>
				)}
				{usedShare !== undefined && meterBar(usedShare, quotaToneColor(100 - usedShare))}
				{(stack.length > 0 || used) && (
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1" style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-label-tertiary)" }}>
						{stack.map((detail) => (
							<span key={detail.key} className="flex items-center gap-1">
								<i className="inline-block h-1.5 w-1.5 flex-none rounded-full" style={{ background: balanceDetailColor(detail.key) }} />
								{balanceDetailLabel(detail.key)}
								<span style={{ color: "var(--dsw-label-secondary)", fontVariantNumeric: "tabular-nums" }}>{fmtAmount(detail)}</span>
							</span>
						))}
						{usedShare !== undefined && limit && used && (
							<span style={{ fontVariantNumeric: "tabular-nums" }}>{t.usageSpendOfLimit.replace("{used}", fmtAmount(used)).replace("{limit}", fmtAmount(limit))}</span>
						)}
						{usedShare === undefined && used && (
							<span style={{ fontVariantNumeric: "tabular-nums" }}>{t.usageBalanceUsed} {fmtAmount(used)}</span>
						)}
					</div>
				)}
				{periods.length > 0 && (
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1" style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-label-caption)" }}>
						{periods.map((period) => (
							<span key={period.period} className="flex items-center gap-1">
								{period.period === "daily" ? t.usageSpendDaily : period.period === "weekly" ? t.usageSpendWeekly : t.usageSpendMonthly}
								<span style={{ color: "var(--dsw-label-secondary)", fontVariantNumeric: "tabular-nums" }}>{fmtAmount(period)}</span>
							</span>
						))}
					</div>
				)}
			</div>
		);
	};

	// xAI 的 x-ratelimit 余量：请求数与 Token 各一张卡，口径与窗口卡一致
	const renderXaiMeter = (label: string, remaining: number, limit: number, format: (value: number) => string) => {
		const percent = limit > 0 ? Math.min(100, Math.max(0, Math.round((remaining / limit) * 100))) : 0;
		const tone = quotaToneColor(percent);
		return (
			<div className="flex min-w-0 flex-col gap-1.5 rounded-lg px-2.5 py-2" style={{ border: "0.5px solid var(--dsw-border-l2)" }}>
				<div className="flex items-baseline justify-between gap-2">
					<span style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-label-secondary)" }}>{label}</span>
					<span style={{ fontSize: 15, lineHeight: 1, fontWeight: 600, fontFamily: "var(--font-mono)", fontVariantNumeric: "tabular-nums", color: tone }}>{percent}%</span>
				</div>
				{meterBar(percent, tone)}
				<span style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-label-caption)", fontVariantNumeric: "tabular-nums" }}>{format(remaining)} / {format(limit)}</span>
			</div>
		);
	};

	// 一个提供商的配额区：套餐/状态徽章 + 更新时间 + 刷新，下面是窗口卡或余额条
	const renderProviderUsage = (providerId: string) => {
		const usage = providerUsages[providerId];
		const busy = usageBusyId === providerId;
		const failed = usageFailedIds[providerId];
		const quota = usage?.kind === "quota" ? usage : undefined;
		const balance = usage?.kind === "balance" ? usage : undefined;
		return (
			<div className="flex flex-col gap-2">
				<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
					{!usage && <span style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-label-tertiary)" }}>{failed ? t.usageProbeFailed : busy ? t.queryingQuota : t.usageReadOnlyDisclosure}</span>}
					{quota?.planType && usageBadge(`${t.usagePlan} ${titleCase(quota.planType)}`)}
					{quota?.limitReached && usageBadge(t.usageLimitReached, "danger")}
					{balance?.isFreeTier && usageBadge(t.usageFreeTier)}
					{balance?.available === false && usageBadge(t.usageUnavailable, "danger")}
					<div className="ml-auto flex flex-none items-center gap-2">
						{usage && <span style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-label-caption)" }}>{stampLabel(usage.probedAt)}</span>}
						<button type="button" className="pw-chip" disabled={busy} title={t.usageReadOnlyDisclosure} onClick={() => void fetchProviderUsage(providerId, true)}>
							{busy ? t.usageProbing : usage ? t.usageRefresh : t.usageProbe}
						</button>
					</div>
				</div>
				{quota && quota.windows.length === 0 && <span style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-label-tertiary)" }}>{t.usageNoWindows}</span>}
				{quota && quota.windows.length > 0 && (
					<div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(148px, 1fr))" }}>
						{quota.windows.map((w, index) => renderQuotaCard(w, index))}
					</div>
				)}
				{quota?.extra && renderExtraPool(quota.extra)}
				{balance && renderBalance(balance)}
			</div>
		);
	};

	const notify = (ok: boolean, msg?: string) => {
		setToast({ ok, msg: msg ?? (ok ? t.toastSaved : t.toastError) });
		setTimeout(() => setToast(null), 2400);
	};

	const request = async (body: Record<string, unknown>) => {
		try {
			const r = await fetch("/api/models", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			const result = await r.json();
			if (r.ok) return result;
			return { ...result, success: false, status: r.status, error: localizeApiError(lang, result?.errorCode, result.error || `request failed (${r.status})`) };
		} catch (error) {
			return { success: false, error: error instanceof Error ? error.message : t.toastError };
		}
	};

	// 体检：直接从已载入的配置算（不另发请求），每次保存后 load() 重新载入就自动刷新
	const gaps = useMemo(() => customModelGaps(custom.providers ?? {}), [custom]);
	const [auditBusy, setAuditBusy] = useState(false);


	const call = async (body: Record<string, unknown>) => {
		const j = await request(body);
		notify(j.success, j.error);
		if (j.success) await Promise.all([load(), ["setKey", "removeKey"].includes(String(body.action)) ? changed() : Promise.resolve()]);
		return j;
	};

	const beginLogin = async (providerId: string, apiKey?: string) => {
		const result = await request(apiKey === undefined ? { action: "loginStart", providerId } : { action: "setKey", providerId, apiKey });
		if (!result.success || result.data?.error) {
			const failure = { success: false, error: result.error || result.data?.error || t.toastError };
			notify(false, failure.error);
			return failure;
		}
		// Poll only after the server acknowledges creating the job. The request
		// returns before subsequent user prompts, so a 30s client timeout is safe.
		setOauthPrompt(result.data?.prompt ?? null);
		setOauthLog(result.data?.notifyLog ?? []);
		setOauthDone(null);
		setOauthProvider(providerId);
		return result;
	};

	const answerOAuth = async (value: string): Promise<boolean> => {
		if (!oauthProvider) return false;
		try {
			const response = await request({ action: "loginAnswer", providerId: oauthProvider, text: value });
			if (!response.success || response.data?.delivered !== true) throw new Error(response.error || t.toastError);
			return true;
		} catch (error) {
			notify(false, error instanceof Error ? error.message : t.toastError);
			return false;
		}
	};

	const cancelOAuth = async () => {
		if (!oauthProvider) return;
		try {
			const response = await request({ action: "loginCancel", providerId: oauthProvider });
			if (!response.success) throw new Error(response.error || t.toastError);
			setOauthProvider(null);
		} catch (error) {
			notify(false, error instanceof Error ? error.message : t.toastError);
		}
	};

	const customIds = new Set(Object.keys(custom.providers ?? {}));
	// 显示为卡片的 provider：已配置认证 或 自定义
	const shown = providers.filter((p) => p.authReady || p.authConfigured || p.keyManaged || customIds.has(p.id));
	// 添加提供方下拉：内置目录里未显示的
	const addable = providers.filter((p) => p.builtIn && !shown.some((s) => s.id === p.id));

	const saveCustom = async (content: Record<string, any>) => {
		if (customRevision === null) {
			const result = { success: false, error: "Reload model configuration before saving." };
			notify(false, result.error);
			return result;
		}
		const next = { ...custom, providers: content };
		const result = await request({ action: "saveCustomProviders", revision: customRevision, content: JSON.stringify(next, null, 2) });
		notify(result.success, result.error);
		if (result.success) {
			// 写入已确认，列表刷新失败也不能重新显示旧缺口、把已保存的容量变回空格。
			setCustom(next);
			setCustomRevision(null);
			await Promise.all([load(), changed()]);
		} else if (result.status === 409 || result.errorCode === "CONFIG_CHANGED") {
			await load();
			notify(false, result.error);
		}
		return result;
	};

	/** 体检卡片的保存：只补空字段，走与编辑 provider 同一条写入（revision 乐观锁、密钥由服务端从原文件恢复） */
	const saveAuditFills = async (fills: ModelFieldFill[]): Promise<boolean> => {
		const { providers: next, filled } = fillModelFields(custom.providers ?? {}, fills);
		if (!filled) return true;
		setAuditBusy(true);
		try {
			const result = await saveCustom(next);
			// 失败（典型是 revision 冲突：写入期间 pi 自己动过 models.json）也必须刷新本地副本与 revision。
			// 否则本地一直拿着旧 revision，之后每次保存都撞同一个 409——用户看到的就是「反复填、永远不成」。
			// call() 只在成功时 load()，这里把失败那一半补上。
			if (!result.success) await load();
			return Boolean(result.success);
		} finally {
			setAuditBusy(false);
		}
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
		editBaseRevision.current = customRevision;
		setEditing(editing === id ? null : id);
		setEditBusy(false);
	};

	const catalogIdsOf = (providerId: string): ReadonlySet<string> => new Set(catalogModelIds[providerId] ?? []);

	/**
	 * 内置 provider 的条目写回：什么都没覆盖时删掉条目（SDK 不认空条目，会让整份 models.json 存不进去）。
	 * 前端拿到的配置不含 apiKey，存了密钥的条目不能当成空的删掉。
	 * 返回 null = models.json 不用动（原本就没有条目、这次也没覆盖任何东西，比如只填了密钥）。
	 */
	const withBuiltinEntry = (providerId: string, config: Record<string, unknown>): Record<string, any> | null => {
		const next = { ...custom.providers };
		if (isInertProviderConfig(config) && !secretProviderIds.has(providerId)) {
			if (!Object.prototype.hasOwnProperty.call(next, providerId)) return null;
			delete next[providerId];
		} else {
			next[providerId] = config;
		}
		return next;
	};

	const saveCustomEdit = async (id: string, draft: CustomProviderEditDraft) => {
		if (editBusy) return;
		if (editBaseRevision.current !== customRevision) { notify(false, t.modelEditStale); return; }
		const invalid = validateModelDrafts(draft.models);
		if (invalid || !draft.baseUrl.trim()) return;
		const headerEntries = draft.headers.map(({ name, value, storedSecret }) => [name.trim(), storedSecret && !value.trim() ? "" : value.trim(), Boolean(storedSecret)] as [string, string, boolean]);
		const headerError = validateHeaderEntries(
			headerEntries
				.filter(([name, value, storedSecret]) => name || value || storedSecret)
				.map(([name, value]) => [name, value] as [string, string]),
		);
		if (headerError) {
			notify(false, headerError);
			return;
		}
		const targetId = id.trim();
		if ((editing !== null && targetId !== editing) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(targetId) || ["constructor", "prototype"].includes(targetId)
			|| (targetId !== editing && providers.some((provider) => provider.id === targetId))) {
			notify(false, "Provider ID 格式无效或已存在，请使用另一个 ID。");
			return;
		}
		setEditBusy(true);
		try {
			const next = { ...custom.providers };
			const previousId = editing ?? targetId;
			const previous = next[previousId] ?? {};
			if (previousId !== targetId) delete next[previousId];
			const configuredHeaders: Record<string, string | null> = headerEntriesToConfig(draft.headers);
			const keptSecrets = new Set(
				draft.headers
					.filter((row) => row.storedSecret && !row.value.trim() && row.name.trim())
					.map((row) => row.name.trim()),
			);
			for (const secretName of secretHeaderKeys[previousId] ?? []) {
				if (!Object.prototype.hasOwnProperty.call(configuredHeaders, secretName) && !keptSecrets.has(secretName)) {
					Object.defineProperty(configuredHeaders, secretName, { value: null, enumerable: true, configurable: true, writable: true });
				}
			}
			next[targetId] = serializeProviderDraft(previous, {
				name: draft.name,
				baseUrl: draft.baseUrl,
				api: draft.api,
				apiKey: draft.apiKey,
				models: draft.models,
				headers: configuredHeaders,
				keepStoredSecretHeaders: keptSecrets.size > 0,
			});
			const j = await saveCustom(next);
			if (j.success) setEditing(null);
		} finally {
			setEditBusy(false);
		}
	};

	/** 内置 provider 的编辑保存：写 models.json 覆盖层 + 可选 setKey（多步认证走登录弹窗） */
	const saveBuiltinEdit = async (provider: { id: string; apis: string[] }, draft: BuiltinProviderEditDraft) => {
		if (editBusy) return;
		if (editBaseRevision.current !== customRevision) { notify(false, t.modelEditStale); return; }
		const invalid = validateModelDrafts(draft.models);
		if (invalid) return;
		setEditBusy(true);
		try {
			const config = serializeProviderDraft(custom.providers[provider.id] ?? {}, {
				baseUrl: draft.baseUrl,
				models: draft.models,
			}, provider.apis[0] ?? "openai-completions", catalogIdsOf(provider.id));
			const next = withBuiltinEntry(provider.id, config);
			const j = next ? await saveCustom(next) : { success: true };
			if (j.success && draft.apiKey.trim()) {
				const login = await beginLogin(provider.id, draft.apiKey.trim());
				if (!login.success) return;
			}
			if (j.success) setEditing(null);
		} finally {
			setEditBusy(false);
		}
	};

	const deleteCustom = async (id: string) => {
		if (editBusy) return;
		if (!(await confirm({ title: t.confirmDeleteAction, message: t.confirmRemoveProvider.replace("{name}", providerName(id)), confirmLabel: t.delete }))) return;
		setEditBusy(true);
		try {
			const next = { ...custom.providers };
			delete next[id];
			const target = providers.find((provider) => provider.id === id);
			// Confirm the revisioned configuration write before removing credentials.
			// A conflict must retain the user's existing key and provider together.
			const j = await saveCustom(next);
			if (!j.success) return;
			if (target?.builtIn) {
				const removed = await request({ action: "removeKey", providerId: id });
				await load();
				if (!removed.success) { notify(false, t.modelCredentialRemovalFailed.replace("{error}", removed.error || t.toastError)); return; }
				await changed();
			}
			setEditing(null);
		} finally { setEditBusy(false); }
	};

	const saveBuiltinSetup = async ({ providerId, apiKey, config }: BuiltinProviderSetup) => {
		const next = withBuiltinEntry(providerId, { ...custom.providers[providerId], ...config });
		// 只填了密钥：models.json 不需要条目，直接去存密钥
		const result = next ? await saveCustom(next) : { success: true };
		if (result.success && apiKey) {
			return beginLogin(providerId, apiKey);
		}
		return result;
	};

	const saveCustomSetup = async ({ providerId, config }: CustomProviderSetup) => {
		const next = { ...custom.providers, [providerId]: config };
		return saveCustom(next);
	};

	/** 添加弹窗里的 OAuth 订阅登录：启动后由下方已有的 OAuth 轮询弹窗接管交互 */
	const oauthSetupLogin = async (providerId: string) => {
		return beginLogin(providerId);
	};

	return (
		<div className="flex flex-col gap-5">
			<div>
				<div style={{ fontSize: "var(--dsh-ui-font-md)", fontWeight: 400 }}>{t.modelsTitle}</div>
				<div className="mt-0.5" style={{ fontSize: "var(--dsh-ui-font-125)", color: "var(--dsw-label-caption)" }}>
					{t.modelsDesc}
				</div>
				<div className="mt-1" style={{ fontSize: "var(--dsh-ui-font-xs)", color: "var(--dsw-label-caption)" }}>
					{t.customModelIdentityNotice}
				</div>
			</div>

			{toast && (
				<div
					className="rounded-xl px-3 py-2"
					style={{
						fontSize: "var(--dsh-ui-font-125)",
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
							{/* 卡片：身份/操作行在上，额度显示放在同一个框内的第二段（分隔线区分） */}
							<div className="flex min-w-0 flex-col overflow-hidden rounded-2xl px-4 py-3" style={{ border: "0.5px solid var(--dsw-border-l2)" }}>
								{/* 空间不够时整行换行,而不是把按钮压窄——中文按钮被压窄会一个字一行 */}
								<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
									<ProviderBrand id={p.id} name={providerName(p.id)} size={34} />
									{/* 名称列给最小宽度:窄屏时宁可换行,也不要把名字压成几个像素 */}
									<div className="min-w-[132px] flex-1">
										<div className="truncate" style={{ fontSize: "var(--dsh-ui-font-md)", fontWeight: 500 }}>{providerName(p.id)}</div>
										<div className="truncate" style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-label-caption)" }}>
											{p.id}{p.baseUrl ? ` · ${p.baseUrl}` : ""}
										</div>
									</div>
									{isCustom && (
										<span
											className="flex-none rounded-md px-1.5 py-0.5"
											style={{ fontSize: "var(--dsh-ui-font-2xs)", border: "0.5px solid var(--dsw-border-l3)", color: "var(--dsw-label-tertiary)" }}
										>
											{t.customBadge}
										</span>
									)}
									<span
										className="inline-block h-2 w-2 flex-none rounded-full"
										style={{ background: p.authReady ? "var(--dsw-success)" : "var(--dsw-danger)" }}
										title={p.authError || (p.authReady ? t.providerReady : t.authUnavailable)}
									/>
									<span
										className="flex-none rounded-md px-1.5 py-0.5"
										style={{ fontSize: "var(--dsh-ui-font-2xs)", border: "0.5px solid var(--dsw-border-l3)", color: "var(--dsw-label-tertiary)" }}
									>
										{t.credentialSource.replace("{source}", credentialSource(p))}
									</span>
									{/* 操作组整体不压缩:按钮加 whitespace-nowrap,中文标签永不竖排 */}
									<button className="btn-outline flex-none whitespace-nowrap" style={{ height: 28, padding: "0 12px", fontSize: "var(--dsh-ui-font-xs)" }} onClick={() => startEdit(p.id)}>
										{t.edit}
									</button>
									{p.storedAuthType === "oauth" && (
										<button
											className="flex-none whitespace-nowrap"
											style={{ height: 28, padding: "0 12px", fontSize: "var(--dsh-ui-font-xs)", color: "var(--dsw-danger)" }}
											onClick={async () => {
												if (!(await confirm({ title: t.removeOAuth, message: t.confirmRemoveOAuth.replace("{name}", providerName(p.id)), confirmLabel: t.removeOAuth }))) return;
												await call({ action: "removeKey", providerId: p.id });
											}}
										>
											{t.removeOAuth}
										</button>
									)}
									{p.authTypes?.includes("oauth") && (
										<button
											className="btn-outline flex-none whitespace-nowrap"
											style={{ height: 28, padding: "0 12px", fontSize: 12 }}
											onClick={() => void beginLogin(p.id)}
										>
											{t.oauthLogin}
										</button>
									)}
									{customIds.has(p.id) && (
										<button className="flex-none whitespace-nowrap" disabled={editBusy} style={{ fontSize: 12.5, color: "var(--dsw-danger)" }} onClick={() => deleteCustom(p.id)}>
											{t.delete}
										</button>
									)}
							</div>

							{p.id === "xai" && p.authReady && (
								<div className="mt-3 flex flex-col gap-2 pt-3" style={{ borderTop: "0.5px solid var(--dsw-border-l2)" }}>
									<div className="flex flex-wrap items-center gap-x-2 gap-y-1">
										{xaiUsage ? (
											<>
												{usageBadge(t.usageQuotaLabel)}
												{usageBadge(xaiUsage.model)}
											</>
										) : <span style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-label-tertiary)" }}>{usageError ? t.usageProbeFailed : t.usageProbeDisclosure}</span>}
										<div className="ml-auto flex flex-none items-center gap-2">
											<button type="button" className="pw-chip" disabled={usageBusy} title={t.usageProbeDisclosure} onClick={() => void fetchUsage(true)}>
												{usageBusy ? t.usageProbing : xaiUsage ? t.usageRefresh : t.usageProbe}
											</button>
										</div>
									</div>
									{xaiUsage && (
										<div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(148px, 1fr))" }}>
											{renderXaiMeter(t.usageRequests, xaiUsage.requestRemaining, xaiUsage.requestLimit, (value) => value.toLocaleString())}
											{renderXaiMeter("Tokens", xaiUsage.tokenRemaining, xaiUsage.tokenLimit, fmtQuotaTokens)}
										</div>
									)}
								</div>
							)}

							{supportsUsageProbe(p.id) && p.id !== "xai" && p.authReady && (
								<div className="mt-3 pt-3" style={{ borderTop: "0.5px solid var(--dsw-border-l2)" }}>
									{renderProviderUsage(p.id)}
								</div>
							)}
							</div>

							{editingThis && (
								<InlineProviderEditor
									key={p.id}
									provider={p}
									isCustom={isCustom}
									override={custom.providers[p.id]}
									hasStoredSecret={secretProviderIds.has(p.id)}
									storedSecretHeaderKeys={secretHeaderKeys[p.id]}
									catalogIds={catalogIdsOf(p.id)}
									editBusy={editBusy}
									canSaveBuiltin={customRevision !== null}
									onCancel={() => setEditing(null)}
									onSaveCustom={(draft) => void saveCustomEdit(p.id, draft)}
									onSaveBuiltin={(draft) => void saveBuiltinEdit({ id: p.id, apis: p.apis }, draft)}
									onRemoveKey={async () => {
										const isOAuth = p.storedAuthType === "oauth";
										const ok = await confirm({
											title: isOAuth ? t.removeOAuth : t.removeKey,
											message: (isOAuth ? t.confirmRemoveOAuth : t.confirmRemoveKey).replace("{name}", p.name),
											confirmLabel: isOAuth ? t.removeOAuth : t.removeKey,
										});
										if (!ok) return;
										const j = await call({ action: "removeKey", providerId: p.id });
										if (j.success) setEditing(null);
									}}
								/>
							)}
						</div>
					);
				})}
			</div>

			{/* 模型配置体检：没写的字段 pi 会按缺省处理；由用户填，不替他猜 */}
			{gaps.length > 0 ? (
				<ModelFieldAudit gaps={gaps} providerLabel={providerName} busy={auditBusy || customRevision === null} onSave={saveAuditFills} />
			) : null}

			{/* Server-side matching/probing does not block this page or require per-model buttons. */}
			{Object.keys(custom.providers).length > 0 && <section className="flex flex-col gap-2 rounded-2xl p-4" style={{ border: "0.5px solid var(--dsw-border-l3)" }} data-testid="thinking-probe">
				<div style={{ fontWeight: 600, fontSize: "var(--dsh-ui-font-135)" }}>{t.thinkingProbeTitle}</div>
				<p style={{ margin: 0, color: "var(--dsw-label-caption)", fontSize: "var(--dsh-ui-font-xs)", lineHeight: 1.6 }}>{t.thinkingProbeDesc}</p>
				{thinkingPending && <span role="status">{t.thinkingProbeProbing}</span>}
			</section>}

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
					catalogModelIds={catalogModelIds}
					existingIds={providers.map((provider) => provider.id)}
					onClose={() => setAdding(null)}
					onSaveBuiltin={saveBuiltinSetup}
					onSaveCustom={saveCustomSetup}
					onOAuthLogin={oauthSetupLogin}
				/>
			) : null}


	{/* OAuth 登录弹窗 */}
	{oauthProvider && (
		<div className="modal-mask fixed inset-0 z-[120] flex items-center justify-center" onMouseDown={(e) => { if (e.target === e.currentTarget) void cancelOAuth(); }}>
			<div className="glass-modal flex flex-col gap-4 p-6" style={{ width: 460, maxWidth: "92vw", borderRadius: 24, boxShadow: "var(--dsw-elevation-prominent)" }}>
				<div style={{ fontSize: 15, fontWeight: 600 }}>{t.oauthLogin} · {oauthProvider}</div>
				{oauthDeviceCode && !oauthDone ? (
					<div className="flex flex-col gap-2">
						<div style={{ fontSize: 13, color: "var(--dsw-label-primary)" }}>{t.oauthDevicePrompt}</div>
						{oauthDeviceCode.instructions ? (
							<div style={{ fontSize: 12, color: "var(--dsw-label-tertiary)" }}>{oauthDeviceCode.instructions}</div>
						) : null}
						<div className="flex flex-wrap items-center gap-2">
							<a
								href={oauthDeviceCode.verificationUri}
								target="_blank"
								rel="noreferrer"
								className="btn-primary-white"
								style={{ fontSize: 12.5, textDecoration: "none" }}
							>
								{t.oauthOpenAuth}
							</a>
							{oauthDeviceCode.userCode ? (
								<button className="btn-outline" style={{ height: 32 }} onClick={copyDeviceCode}>
									{oauthCodeCopied ? t.oauthCodeCopied : `${t.oauthDeviceCode}: ${oauthDeviceCode.userCode}`}
								</button>
							) : null}
						</div>
					</div>
				) : oauthLog.length > 0 ? (
					<div className="flex flex-col gap-0.5" style={{ fontSize: 12, color: "var(--dsw-label-tertiary)" }}>
						{oauthLog.slice(-3).map((l, i) => (
							<div key={i} className="truncate">{l}</div>
						))}
					</div>
				) : null}
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
						{oauthPrompt.options?.length ? (
							// select 型提示：点选项即作答（回传 SDK 的原始 value）
							<>
								<div className="flex flex-col gap-1.5">
									{oauthPrompt.options.map((opt) => (
										<button
											key={opt.value}
											className="btn-outline"
											style={{ height: 34, justifyContent: "flex-start", textAlign: "left" }}
											onClick={() => { void answerOAuth(opt.value); }}
										>
											{opt.label}
										</button>
									))}
								</div>
								<div className="flex items-center justify-between gap-2">
									<span style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>{t.oauthWait}</span>
									<div className="flex gap-2">
										<button
											className="btn-outline"
											style={{ height: 32 }}
											onClick={() => { void cancelOAuth(); }}
										>
											{t.oauthCancel}
										</button>
									</div>
								</div>
							</>
						) : (
							<OAuthPromptInput
								key={`${oauthProvider}:${oauthPrompt.type}:${oauthPrompt.message}`}
								type={oauthPrompt.type === "secret" ? "password" : "text"}
								placeholder={oauthPrompt.placeholder ?? ""}
								onSubmit={answerOAuth}
								onCancel={() => { void cancelOAuth(); }}
							/>
						)}
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

		{confirmDialog}
		</div>
	);
}

type CustomProviderEditDraft = {
	apiKey: string;
	name: string;
	baseUrl: string;
	api: string;
	headers: Array<{ name: string; value: string; storedSecret?: boolean }>;
	models: ModelDraft[];
};

type BuiltinProviderEditDraft = {
	apiKey: string;
	baseUrl: string;
	models: ModelDraft[];
};

/** 单个提供方的内联编辑表单：草稿状态留在子组件内部，打字不触发整页提供方列表与配额卡重渲染 */
function InlineProviderEditor({
	provider: p,
	isCustom,
	override,
	hasStoredSecret,
	storedSecretHeaderKeys,
	catalogIds,
	editBusy,
	canSaveBuiltin,
	onCancel,
	onSaveCustom,
	onSaveBuiltin,
	onRemoveKey,
}: {
	provider: ProviderView;
	isCustom: boolean;
	override: Record<string, any> | undefined;
	hasStoredSecret: boolean;
	storedSecretHeaderKeys: string[] | undefined;
	catalogIds: ReadonlySet<string>;
	editBusy: boolean;
	canSaveBuiltin: boolean;
	onCancel: () => void;
	onSaveCustom: (draft: CustomProviderEditDraft) => void;
	onSaveBuiltin: (draft: BuiltinProviderEditDraft) => void;
	onRemoveKey: () => Promise<void>;
}) {
	const { t } = useI18n();
	const [cKey, setCKey] = useState("");
	const [cName, setCName] = useState(() => (typeof override?.name === "string" ? override.name : ""));
	const [cBaseUrl, setCBaseUrl] = useState(() => (typeof override?.baseUrl === "string" ? override.baseUrl : ""));
	const [cApi, setCApi] = useState(() => (typeof override?.api === "string" ? override.api : "openai-completions"));
	const [cModels, setCModels] = useState<ModelDraft[]>(() => (isCustom ? (override?.models ?? []).map(modelDraftFromConfig) : []));
	const [cHeaders, setCHeaders] = useState<Array<{ name: string; value: string; storedSecret?: boolean }>>(() => {
		if (!isCustom) return [];
		const plainHeaders = headerEntriesFromConfig(override?.headers);
		const seenHeaderNames = new Set(plainHeaders.map((entry) => entry.name));
		const secretRows = (storedSecretHeaderKeys ?? [])
			.filter((name) => !seenHeaderNames.has(name))
			.map((name) => ({ name, value: "", storedSecret: true }));
		return [...plainHeaders, ...secretRows];
	});
	const [keyDraft, setKeyDraft] = useState("");
	const [bBaseUrl, setBBaseUrl] = useState(() => (!isCustom && typeof override?.baseUrl === "string" ? override.baseUrl : ""));
	const [bModels, setBModels] = useState<ModelDraft[]>(() => (!isCustom ? modelDraftsFromProviderConfig(override) : []));
	const [editAdvanced, setEditAdvanced] = useState(false);

	return (
		<div className="mt-2 rounded-2xl p-4" style={{ border: "0.5px solid var(--dsw-border-l2)" }}>
			{isCustom ? (
				<div className="flex flex-col gap-3">
					<Field label={t.apiKey}>
						<input
							type="password"
							value={cKey}
							onChange={(e) => setCKey(e.target.value)}
							className={fieldCls}
							placeholder={hasStoredSecret ? t.apiKeyStored : t.apiKeyOptional}
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
							options={customApiOptions([cApi, ...p.apis]).map((api) => ({ value: api, label: api }))}
							onChange={setCApi}
						/>
					</Field>
					<Field label={t.customHeaders}>
						<div className="flex flex-col gap-2">
							{cHeaders.map((entry, index) => (
								<div key={index} className="flex items-center gap-2">
									<input
										value={entry.name}
										onChange={(e) => setCHeaders((current) => current.map((item, at) => (at === index ? { name: e.target.value, value: item.value } : item)))}
										className={fieldCls}
										placeholder="User-Agent"
										style={{ flex: "0 0 38%" }}
									/>
									<input
										type="password"
										autoComplete="off"
										value={entry.value}
										onChange={(e) => setCHeaders((current) => current.map((item, at) => (at === index ? { ...item, value: e.target.value } : item)))}
										className={fieldCls}
										placeholder={entry.storedSecret ? t.apiKeyStored : "opencode/1.0.0"}
									/>
									<button
										type="button"
										className="btn-outline flex-none"
										style={{ height: 32, padding: "0 10px" }}
										aria-label={`${t.delete} ${entry.name || index + 1}`}
										onClick={() => setCHeaders((current) => current.filter((_, at) => at !== index))}
									>
										×
									</button>
								</div>
							))}
							<div className="flex items-center gap-2">
								<button
									type="button"
									className="btn-outline"
									style={{ height: 30, padding: "0 10px", fontSize: 12 }}
									onClick={() => setCHeaders((current) => [...current, { name: "", value: "" }])}
								>
									{t.customHeaderAdd}
								</button>
							</div>
							<div style={{ fontSize: 11.5, color: "var(--dsw-label-caption)" }}>{t.customHeadersHint}</div>
						</div>
					</Field>
					<ModelCatalog
						models={cModels}
						setModels={setCModels}
						updateModel={(index, patch) => setCModels((current) => current.map((model, at) => (at === index ? { ...model, ...patch } : model)))}
						discover={async (allowPrivate) => {
							const activeHeaderPairs = cHeaders
								.filter((row) => !(row.storedSecret && !row.value.trim()))
								.map(({ name, value }) => [name.trim(), value.trim()] as [string, string])
								.filter(([name, value]) => name || value);
							const headerError = validateHeaderEntries(activeHeaderPairs);
							if (headerError) throw new Error(headerError);
							const discoverHeaders = headerEntriesToConfig(cHeaders);
							const response = await fetch("/api/models", {
								method: "POST",
								headers: { "Content-Type": "application/json" },
								// providerId：key 留空（保持不变）时后端回退到已存密钥与请求头
								body: JSON.stringify({
									action: "discoverModels",
									providerId: p.id,
									baseUrl: cBaseUrl.trim(),
									api: cApi,
									apiKey: cKey.trim(),
									allowPrivate,
									...(Object.keys(discoverHeaders).length ? { headers: discoverHeaders } : {}),
								}),
							});
							const result = await response.json();
							if (!result.success) throw new Error(result.error || t.toastError);
							return (result.data.models ?? []).map(modelDraftFromCatalog);
						}}
						discoverDisabled={!cBaseUrl.trim()}
					/>
					<div className="flex justify-end gap-2">
						<button className="btn-outline" style={{ height: 32 }} disabled={editBusy} onClick={onCancel}>{t.cancel}</button>
						<button
							className="btn-primary-white"
							disabled={editBusy || !cBaseUrl.trim() || !!validateModelDrafts(cModels) || !cModels.some((m) => m.id.trim())}
							onClick={() => onSaveCustom({ apiKey: cKey, name: cName, baseUrl: cBaseUrl, api: cApi, headers: cHeaders, models: cModels })}
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
									catalogIds={catalogIds}
									discover={async (allowPrivate) => {
										const response = await fetch("/api/models", {
											method: "POST",
											headers: { "Content-Type": "application/json" },
											// providerId：key 留空（保持不变）时后端回退到已存密钥
											body: JSON.stringify({ action: "discoverModels", providerId: p.id, baseUrl: (bBaseUrl.trim() || p.baseUrl || ""), api: p.apis[0], apiKey: keyDraft.trim(), allowPrivate }),
										});
										const result = await response.json();
										if (!result.success) throw new Error(result.error || t.toastError);
										return (result.data.models ?? []).map(modelDraftFromCatalog);
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
								onClick={() => void onRemoveKey()}
							>
								{p.storedAuthType === "oauth" ? t.removeOAuth : t.removeKey}
							</button>
						)}
						<button className="btn-outline" style={{ height: 32 }} disabled={editBusy} onClick={onCancel}>{t.cancel}</button>
						<button
							className="btn-primary-white"
							disabled={editBusy || !canSaveBuiltin || !!validateModelDrafts(bModels)}
							onClick={() => onSaveBuiltin({ apiKey: keyDraft, baseUrl: bBaseUrl, models: bModels })}
						>
							{editBusy ? t.saving : t.save}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

/** OAuth 文本输入行：输入状态留在子组件内部，打字不重渲染模型设置页 */
function OAuthPromptInput({
	type,
	placeholder,
	onSubmit,
	onCancel,
}: {
	type: "password" | "text";
	placeholder: string;
	onSubmit: (value: string) => Promise<boolean>;
	onCancel: () => void;
}) {
	const { t } = useI18n();
	const [value, setValue] = useState("");
	const submit = () => {
		const trimmed = value.trim();
		if (!trimmed) return;
		void onSubmit(trimmed).then((delivered) => {
			if (delivered) setValue("");
		});
	};
	return (
		<>
			<input
				autoFocus
				type={type}
				value={value}
				onChange={(e) => setValue(e.target.value)}
				placeholder={placeholder}
				className="w-full rounded-xl px-3 py-2"
				style={{ fontSize: 13, background: "var(--dsw-hover)" }}
				onKeyDown={(e) => {
					if (e.key === "Enter" && !e.nativeEvent.isComposing && e.keyCode !== 229) {
						submit();
					}
				}}
			/>
			<div className="flex items-center justify-between gap-2">
				<span style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>{t.oauthWait}</span>
				<div className="flex gap-2">
					<button className="btn-outline" style={{ height: 32 }} onClick={onCancel}>
						{t.oauthCancel}
					</button>
					<button
						className="btn-primary-white"
						disabled={!value.trim()}
						style={{ opacity: value.trim() ? 1 : 0.5 }}
						onClick={submit}
					>
						{t.confirm}
					</button>
				</div>
			</div>
		</>
	);
}

/** 配额展示：token 数转换单位（53,000,000 → 53.00M），与统计条 / 上下文弹窗口径一致 */
function fmtQuotaTokens(value: number): string {
	return fmtTokens(value);
}

/** 套餐值来自服务端声明（如 "pro"/"plus"），首字母大写后直接跟在标签后显示。 */
function titleCase(value: string): string {
	return value.length === 0 ? value : value[0].toUpperCase() + value.slice(1);
}

/** 界面语言对应的日期区域设置；显式传入，避免跟随操作系统语言。 */
const DATE_LOCALES: Record<Lang, string> = { zh: "zh-CN", "zh-Hant": "zh-Hant", en: "en-US", ja: "ja-JP", ru: "ru-RU" };

function fmtQuotaReset(value: string | undefined, lang?: Lang): string {
	if (!value) return "—";
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return "—";
	// 无界面语言时保留旧的跟随系统行为（调用方总能传入当前语言）。
	return lang ? date.toLocaleString(DATE_LOCALES[lang]) : date.toLocaleString();
}

/** 剩余越少越警示：<30% 红、≤60% 黄、其余常规。 */
function quotaToneColor(percent: number): string {
	if (percent < 30) return "var(--dsw-danger)";
	if (percent <= 60) return "var(--dsw-warn)";
	return "var(--dsw-success)";
}
