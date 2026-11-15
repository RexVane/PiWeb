"use client";
import { clientFetch as fetch } from "@/lib/client-fetch";


import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConfirmDialog } from "@/components/ConfirmDialog";
import { IconChevronDown14, IconPlusOutline16, IconWarningOutline16 } from "@/components/icons";
import { ProviderBrand } from "@/components/ProviderBrand";
import { ModelCatalog, ProviderSetupModal, type BuiltinProviderSetup, type CustomProviderSetup } from "@/components/ProviderSetupModal";
import { localizeApiError, useI18n } from "@/i18n";
import { fmtTokens } from "@/lib/format";
import { customModelGaps, fillModelFields, formatCapacity, isInertProviderConfig, modelDraftFromCatalog, modelDraftFromConfig, modelDraftsFromProviderConfig, parseCapacity, PI_MODEL_FALLBACKS, serializeProviderDraft, validateModelDrafts, type CustomModelGap, type ModelDraft, type ModelFieldFill } from "@/lib/model-draft";
import { customApiOptions } from "@/lib/provider-display";
import { quotaWindowKind, supportsUsageProbe, type BalanceAmount, type BalanceDetailKey, type ProviderUsage, type QuotaWindow, type XaiUsage } from "@/lib/provider-usage";
import type { ProviderView } from "@/lib/models-service";
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
									{t.modelAuditRemaining.replace("{fields}", gap.missing.map((field) => fieldLabels[field]).join(lang === "zh" ? "、" : ", "))}
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
	const [custom, setCustom] = useState<{ providers: Record<string, any>; [key: string]: unknown }>({ providers: {} });
	const [customRevision, setCustomRevision] = useState<string | null>(null);
	const [secretProviderIds, setSecretProviderIds] = useState<Set<string>>(new Set());
	// 内置 provider → 目录里的模型 ID：编辑时同 ID 的行写 modelOverrides，「获取可用模型」里不再可选
	const [catalogModelIds, setCatalogModelIds] = useState<Record<string, string[]>>({});
	const [editing, setEditing] = useState<string | null>(null);
	const editBaseRevision = useRef<string | null>(null);
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
	const [oauthPrompt, setOauthPrompt] = useState<{ type: string; message: string; placeholder?: string; options?: Array<{ label: string; value: string }> } | null>(null);
	const [oauthLog, setOauthLog] = useState<string[]>([]);
	const [oauthInput, setOauthInput] = useState("");
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
			setCatalogModelIds(j.data.catalogModelIds ?? {});
			setSecretProviderIds(new Set(j.data.customProviders?.secretProviderIds ?? []));
			setCustom({ ...parsed, providers: parsed.providers ?? {} });
			setCustomRevision(typeof j.data.customProviders?.revision === "string" ? j.data.customProviders.revision : null);
		} catch (error) {
			setCustomRevision(null);
			const code = (error as { errorCode?: string }).errorCode;
			const message = error instanceof Error ? error.message : "failed to load model configuration";
			setToast({ ok: false, msg: localizeApiError(lang, code, message) });
		}
	}, [lang]);
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

	// 窗口制/余额制配额：各提供商走各自的只读端点（后端 5 分钟缓存，force 跳过）
	const [providerUsages, setProviderUsages] = useState<Record<string, ProviderUsage | null>>({});
	const [usageBusyId, setUsageBusyId] = useState<string | null>(null);
	const [usageFailedIds, setUsageFailedIds] = useState<Record<string, boolean>>({});
	const fetchProviderUsage = useCallback(async (providerId: string, force: boolean) => {
		setUsageBusyId(providerId);
		setUsageFailedIds((prev) => ({ ...prev, [providerId]: false }));
		try {
			const r = await fetch("/api/models", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "providerUsage", providerId, force }) });
			const j = await r.json();
			if (!r.ok || !j.success) throw new Error(j.error || "usage probe failed");
			setProviderUsages((prev) => ({ ...prev, [providerId]: j.data.usage ?? null }));
		} catch {
			setUsageFailedIds((prev) => ({ ...prev, [providerId]: true }));
		} finally {
			setUsageBusyId((current) => (current === providerId ? null : current));
		}
	}, []);

	// 这些端点都是只读探测、不消耗额度，登录后自动取一次；xAI 那条会发一次可能计费的请求，仍然只手动触发
	const requestedUsage = useRef(new Set<string>());
	useEffect(() => {
		for (const p of providers) {
			if (!p.authReady || p.authCommand || !supportsUsageProbe(p.id) || p.id === "xai" || requestedUsage.current.has(p.id)) continue;
			requestedUsage.current.add(p.id);
			void fetchProviderUsage(p.id, false);
		}
	}, [providers, fetchProviderUsage]);

	// 窗口时长 → 标签：7 天叫「周限」、30 天叫「月限」，更短的按小时/天如实标注
	const quotaWindowLabel = (seconds: number): string => {
		const kind = quotaWindowKind(seconds);
		if (kind === "weekly") return t.usageWindowWeekly;
		if (kind === "monthly") return t.usageWindowMonthly;
		return (kind === "hours" ? t.usageWindowHours : t.usageWindowDays).replace("{n}", String(Math.round(seconds / (kind === "hours" ? 3600 : 86400))));
	};
	// 服务端不给周期时（Copilot 的额度类别、OpenCode 的 rolling）按名字标注
	const quotaWindowName = (name: string): string => {
		if (name === "premium") return t.usageWindowPremium;
		if (name === "chat") return t.usageWindowChat;
		if (name === "completions") return t.usageWindowCompletions;
		if (name === "rolling") return t.usageWindowRolling;
		return titleCase(name);
	};
	const quotaVariantLabel = (variant: string): string => {
		if (variant === "opus") return t.usageVariantOpus;
		if (variant === "code") return t.usageVariantCode;
		return titleCase(variant);
	};
	const quotaWindowHeading = (w: QuotaWindow): string => {
		if (w.limitWindowSeconds !== undefined) return `${quotaWindowLabel(w.limitWindowSeconds)}${w.variant ? ` (${quotaVariantLabel(w.variant)})` : ""}`;
		return w.name ? quotaWindowName(w.name) : "";
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
	const fmtAmount = (value: BalanceAmount): string => `${value.currency === "USD" ? "$" : value.currency === "CNY" ? "¥" : ""}${value.amount}${value.currency && value.currency !== "USD" && value.currency !== "CNY" ? ` ${value.currency}` : ""}`;

	// 一个提供商的配额行：窗口制显示每个窗口的剩余与重置，余额制显示主余额与明细
	const renderProviderUsage = (providerId: string) => {
		const usage = providerUsages[providerId];
		const busy = usageBusyId === providerId;
		const failed = usageFailedIds[providerId];
		return (
			<>
				<div className="flex items-center gap-2">
					{!usage && <span>{failed ? t.usageProbeFailed : busy ? t.queryingQuota : t.usageReadOnlyDisclosure}</span>}
					{usage?.kind === "quota" && usage.planType && <span>{t.usagePlan} {titleCase(usage.planType)}</span>}
					{usage?.kind === "balance" && usage.primary && (
						<span>{usage.primaryKey === "used" ? t.usageBalanceUsed : t.usageQuotaRemaining} <span style={{ color: "var(--dsw-label-secondary)" }}>{fmtAmount(usage.primary)}</span></span>
					)}
					<button type="button" className="pw-chip" disabled={busy} title={t.usageReadOnlyDisclosure} onClick={() => void fetchProviderUsage(providerId, true)}>
						{busy ? t.usageProbing : usage ? t.usageRefresh : t.usageProbe}
					</button>
				</div>
				{usage?.kind === "balance" && usage.details.length > 0 && (
					<span>{usage.details.map((detail) => `${balanceDetailLabel(detail.key)} ${fmtAmount(detail)}`).join(" · ")}</span>
				)}
				{usage?.kind === "quota" && usage.windows.length === 0 && <span>{t.usageQuotaRemaining} —</span>}
				{usage?.kind === "quota" && usage.windows.map((w, index) => (
					<div key={`${w.limitWindowSeconds ?? w.name ?? "window"}-${w.variant ?? ""}-${index}`} className="flex items-center gap-2">
						<span style={{ width: 84, flex: "none" }}>{quotaWindowHeading(w)}</span>
						<span style={{ width: 92, flex: "none" }}>{t.usageQuotaRemaining} {w.remainingPercent}%</span>
						<span>{t.usageReset} {fmtQuotaReset(w.resetAt, lang)}</span>
						<div className="h-1 overflow-hidden rounded-full" style={{ width: 120, flex: "none", background: "var(--dsw-border-l2)" }}>
							<div className="h-full rounded-full" style={{ width: `${w.remainingPercent}%`, background: quotaToneColor(w.remainingPercent) }} />
						</div>
					</div>
				))}
			</>
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

	const answerOAuth = async (value: string) => {
		if (!oauthProvider) return;
		try {
			const response = await request({ action: "loginAnswer", providerId: oauthProvider, text: value });
			if (!response.success || response.data?.delivered !== true) throw new Error(response.error || t.toastError);
			setOauthInput("");
		} catch (error) {
			notify(false, error instanceof Error ? error.message : t.toastError);
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
		setKeyDraft("");
		setEditBusy(false);
		setEditAdvanced(false);
		const override = custom.providers[id];
		// 与卡片渲染的 isCustom 同口径：内置 provider 即使有 models.json 覆盖层也走内置编辑分支，
		// 否则 OAuth 后添加的内置提供商会填错状态、编辑时模型列表显示为空
		const isCustomEntry = customIds.has(id) && !providers.find((p) => p.id === id)?.builtIn;
		if (isCustomEntry) {
			setCId(id);
			setCBaseUrl(override?.baseUrl ?? "");
			setCApi(override?.api ?? "openai-completions");
			setCKey("");
			setCName(typeof override?.name === "string" ? override.name : "");
			setCModels((override?.models ?? []).map(modelDraftFromConfig));
		} else {
			// 内置 provider：从 models.json 覆盖层初始化（若有），models[] 定义和 modelOverrides 覆盖都作为行
			setBBaseUrl(typeof override?.baseUrl === "string" ? override.baseUrl : "");
			setBModels(modelDraftsFromProviderConfig(override));
		}
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

	const saveCustomEdit = async () => {
		if (editBusy) return;
		if (editBaseRevision.current !== customRevision) { notify(false, t.modelEditStale); return; }
		const invalid = validateModelDrafts(cModels);
		if (invalid || !cBaseUrl.trim()) return;
		const targetId = cId.trim();
		if ((editing !== null && targetId !== editing) || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(targetId) || ["constructor", "prototype"].includes(targetId)
			|| (targetId !== editing && providers.some((provider) => provider.id === targetId))) {
			notify(false, "Provider ID 格式无效或已存在，请使用另一个 ID。");
			return;
		}
		setEditBusy(true);
		try {
			const next = { ...custom.providers };
			const previousId = editing ?? cId.trim();
			const previous = next[previousId] ?? {};
			if (previousId !== cId.trim()) delete next[previousId];
			next[cId.trim()] = serializeProviderDraft(previous, {
				name: cName,
				baseUrl: cBaseUrl,
				api: cApi,
				apiKey: cKey,
				models: cModels,
			});
			const j = await saveCustom(next);
			if (j.success) setEditing(null);
		} finally {
			setEditBusy(false);
		}
	};

	/** 内置 provider 的编辑保存：写 models.json 覆盖层 + 可选 setKey（多步认证走登录弹窗） */
	const saveBuiltinEdit = async (provider: { id: string; apis: string[] }) => {
		if (editBusy) return;
		if (editBaseRevision.current !== customRevision) { notify(false, t.modelEditStale); return; }
		const invalid = validateModelDrafts(bModels);
		if (invalid) return;
		setEditBusy(true);
		try {
			const config = serializeProviderDraft(custom.providers[provider.id] ?? {}, {
				baseUrl: bBaseUrl,
				models: bModels,
			}, provider.apis[0] ?? "openai-completions", catalogIdsOf(provider.id));
			const next = withBuiltinEntry(provider.id, config);
			const j = next ? await saveCustom(next) : { success: true };
			if (j.success && keyDraft.trim()) {
				const login = await beginLogin(provider.id, keyDraft.trim());
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
								<div className="mt-3 flex items-center gap-2 pt-3" style={{ borderTop: "0.5px solid var(--dsw-border-l2)", fontSize: 11.5, color: "var(--dsw-label-tertiary)" }}>
									{xaiUsage ? (
										<span>{t.usageQuotaLabel} · {xaiUsage.model} · {t.usageRequests} {xaiUsage.requestRemaining.toLocaleString()}/{xaiUsage.requestLimit.toLocaleString()} · Tokens {fmtQuotaTokens(xaiUsage.tokenRemaining)}/{fmtQuotaTokens(xaiUsage.tokenLimit)}</span>
									) : <span>{usageError ? t.usageProbeFailed : t.usageProbeDisclosure}</span>}
									<button type="button" className="pw-chip" disabled={usageBusy} title={t.usageProbeDisclosure} onClick={() => void fetchUsage(true)}>
										{usageBusy ? t.usageProbing : xaiUsage ? t.usageRefresh : t.usageProbe}
									</button>
								</div>
							)}

							{supportsUsageProbe(p.id) && p.id !== "xai" && p.authReady && (
								<div className="mt-3 flex flex-col gap-1.5 pt-3" style={{ borderTop: "0.5px solid var(--dsw-border-l2)", fontSize: 11.5, color: "var(--dsw-label-tertiary)" }}>
									{renderProviderUsage(p.id)}
								</div>
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
													options={customApiOptions([cApi, ...p.apis]).map((api) => ({ value: api, label: api }))}
													onChange={setCApi}
												/>
											</Field>
											<ModelCatalog
												models={cModels}
												setModels={setCModels}
												updateModel={(index, patch) => setCModels((current) => current.map((model, at) => (at === index ? { ...model, ...patch } : model)))}
												discover={async (allowPrivate) => {
													const response = await fetch("/api/models", {
														method: "POST",
														headers: { "Content-Type": "application/json" },
														// providerId：key 留空（保持不变）时后端回退到已存密钥
														body: JSON.stringify({ action: "discoverModels", providerId: p.id, baseUrl: cBaseUrl.trim(), api: cApi, apiKey: cKey.trim(), allowPrivate }),
													});
													const result = await response.json();
													if (!result.success) throw new Error(result.error || t.toastError);
													return (result.data.models ?? []).map(modelDraftFromCatalog);
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
															catalogIds={catalogIdsOf(p.id)}
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
													onClick={async () => {
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
													>
														{p.storedAuthType === "oauth" ? t.removeOAuth : t.removeKey}
													</button>
												)}
												<button className="btn-outline" style={{ height: 32 }} disabled={editBusy} onClick={() => setEditing(null)}>{t.cancel}</button>
												<button
													className="btn-primary-white"
													disabled={editBusy || customRevision === null || !!validateModelDrafts(bModels)}
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

			{/* 模型配置体检：没写的字段 pi 会按缺省处理；由用户填，不替他猜 */}
			{gaps.length > 0 ? (
				<ModelFieldAudit gaps={gaps} providerLabel={providerName} busy={auditBusy || customRevision === null} onSave={saveAuditFills} />
			) : null}

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
						) : (
							<input
								autoFocus
								type={oauthPrompt.type === "secret" ? "password" : "text"}
								value={oauthInput}
								onChange={(e) => setOauthInput(e.target.value)}
								placeholder={oauthPrompt.placeholder ?? ""}
								className="w-full rounded-xl px-3 py-2"
								style={{ fontSize: 13, background: "var(--dsw-hover)" }}
								onKeyDown={(e) => {
									if (e.key === "Enter" && !e.nativeEvent.isComposing && oauthInput.trim()) {
										void answerOAuth(oauthInput.trim());
									}
								}}
							/>
						)}
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
								{!oauthPrompt.options?.length && (
									<button
										className="btn-primary-white"
										disabled={!oauthInput.trim()}
										style={{ opacity: oauthInput.trim() ? 1 : 0.5 }}
										onClick={() => { void answerOAuth(oauthInput.trim()); }}
									>
										{t.confirm}
									</button>
								)}
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

		{confirmDialog}
		</div>
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
const DATE_LOCALES: Record<"zh" | "en", string> = { zh: "zh-CN", en: "en-US" };

function fmtQuotaReset(value: string | undefined, lang?: "zh" | "en"): string {
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
