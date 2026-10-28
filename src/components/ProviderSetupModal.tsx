"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
	IconCheckOutline14,
	IconChevronDown14,
	IconCloseOutline14,
	IconPlusOutline16,
	IconSearchOutline16,
	IconTrashOutline16,
} from "@/components/icons";
import { ProviderBrand } from "@/components/ProviderBrand";
import { CustomSelect } from "@/components/CustomSelect";
import { useI18n } from "@/i18n";
import { looksPrivateEndpoint } from "@/lib/model-endpoint";
import { CUSTOM_PROVIDER_ID_PATTERN, customApiOptions } from "@/lib/provider-display";
import { formatCapacity, modelDraftFromCatalog, parseCapacity, serializeModelDraft, serializeProviderDraft, validateHeaderEntries, validateModelDrafts, type ModelDraft } from "@/lib/model-draft";
import type { ProviderView } from "@/lib/models-service";
import styles from "./ProviderSetupModal.module.css";
import { useDialog } from "@/hooks/useDialog";

export { formatCapacity, parseCapacity, serializeModelDraft, validateModelDrafts, type ModelDraft } from "@/lib/model-draft";

export interface BuiltinProviderSetup {
	providerId: string;
	apiKey: string;
	config: Record<string, unknown>;
}

export interface CustomProviderSetup {
	providerId: string;
	config: Record<string, unknown>;
}

type SubmitResult = { success: boolean; error?: string };

export function ProviderSetupModal({
	mode,
	providers,
	catalogModelIds,
	existingIds,
	onClose,
	onSaveBuiltin,
	onSaveCustom,
	onOAuthLogin,
}: {
	mode: "builtin" | "custom";
	providers: ProviderView[];
	/** 内置 provider → 目录里的模型 ID：同 ID 的行写 modelOverrides，「获取可用模型」里不再可选 */
	catalogModelIds?: Readonly<Record<string, readonly string[]>>;
	existingIds: string[];
	onClose: () => void;
	onSaveBuiltin: (value: BuiltinProviderSetup) => Promise<SubmitResult>;
	onSaveCustom: (value: CustomProviderSetup) => Promise<SubmitResult>;
	/** 内置提供商支持 OAuth 时的订阅登录路径；未传则不显示认证方式选择 */
	onOAuthLogin?: (providerId: string) => Promise<SubmitResult>;
}) {
	const { t } = useI18n();
	const [selectedId, setSelectedId] = useState(providers[0]?.id ?? "");
	const [pickerOpen, setPickerOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [authMethod, setAuthMethod] = useState<"api_key" | "oauth">("api_key");
	const [apiKey, setApiKey] = useState("");
	const [advanced, setAdvanced] = useState(false);
	const [baseUrl, setBaseUrl] = useState("");
	const [providerId, setProviderId] = useState("");
	const [displayName, setDisplayName] = useState("");
	const allApis = customApiOptions(providers.flatMap((provider) => provider.apis));
	const [api, setApi] = useState(allApis.includes("openai-completions") ? "openai-completions" : (allApis[0] ?? "openai-completions"));
	const [models, setModels] = useState<ModelDraft[]>([]);
	// 自定义请求头（models.json 的 headers）：只对自定义 provider 开放。
	// null = 尚未载入（不表态，保存时不碰原文件里的 headers）；对象 = 用户编辑中。
	// 载入时把源里的头读进表单，保存时整体替换。
	const [headers, setHeaders] = useState<Array<{ name: string; value: string }> | null>(null);
	// 自定义 provider 的自动识别只在地址 / 密钥输入完（失焦）或换协议时触发：
	// 还没有任何模型行，且 URL（+ 密钥，本机网关可省）都填了，这次失焦才算数
	const autoReady = models.length === 0 && Boolean(baseUrl.trim()) && Boolean(apiKey.trim() || looksPrivateEndpoint(baseUrl));
	const [autoTrigger, setAutoTrigger] = useState(0);
	const requestAutoDiscover = () => {
		if (autoReady) setAutoTrigger((count) => count + 1);
	};
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const pickerRef = useRef<HTMLDivElement>(null);
	const dialogRef = useRef<HTMLElement>(null);
	useDialog({ open: true, onClose: () => pickerOpen ? setPickerOpen(false) : onClose(), ref: dialogRef });
	const selected = providers.find((provider) => provider.id === selectedId);
	const catalogIds = useMemo(() => new Set(catalogModelIds?.[selectedId] ?? []), [catalogModelIds, selectedId]);
	const filtered = providers.filter((provider) => {
		const needle = search.trim().toLocaleLowerCase();
		return !needle || provider.name.toLocaleLowerCase().includes(needle) || provider.id.toLocaleLowerCase().includes(needle);
	});

	useEffect(() => {
		if (!pickerOpen) return;
		const handlePointer = (event: MouseEvent) => {
			if (!pickerRef.current?.contains(event.target as Node)) setPickerOpen(false);
		};
		document.addEventListener("mousedown", handlePointer);
		return () => document.removeEventListener("mousedown", handlePointer);
	}, [pickerOpen]);

	const updateModel = (index: number, patch: Partial<ModelDraft>) => {
		setModels((current) => current.map((model, modelIndex) => (modelIndex === index ? { ...model, ...patch } : model)));
	};

	const invalidModels = validateModelDrafts(models);
	const normalizedId = providerId.trim();
	const customIdValid = CUSTOM_PROVIDER_ID_PATTERN.test(normalizedId);
	const customCanSave = customIdValid && !existingIds.includes(normalizedId) && Boolean(baseUrl.trim()) && models.length > 0 && !invalidModels;
	const builtinCanSave = Boolean(selected) && (authMethod === "oauth" || !invalidModels);
	const savingRef = useRef(false);

	const submit = async () => {
		if (savingRef.current || (mode === "builtin" ? !builtinCanSave : !customCanSave)) return;
		savingRef.current = true;
		setSaving(true);
		setError("");
		try {
			let result: SubmitResult;
			if (mode === "builtin" && selected) {
				if (authMethod === "oauth" && onOAuthLogin) {
					result = await onOAuthLogin(selected.id);
				} else {
					// 与目录同 ID 的行进 modelOverrides，新 ID 才进 models[]（并带上协议）
					const config = serializeProviderDraft({}, { baseUrl, models }, selected.apis[0] ?? "openai-completions", catalogIds);
					result = await onSaveBuiltin({ providerId: selected.id, apiKey: apiKey.trim(), config });
				}
			} else {
				// 表单里非空的头才写下去；一条都没有就不带这个键，免得留个空对象在文件里
				const headerEntries = (headers ?? []).map(({ name, value }) => [name.trim(), value.trim()] as [string, string]).filter(([name, value]) => name && value);
				result = await onSaveCustom({
					providerId: normalizedId,
					config: {
						name: displayName.trim() || normalizedId,
						baseUrl: baseUrl.trim(),
						api,
						...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
						...(headerEntries.length ? { headers: Object.fromEntries(headerEntries) } : {}),
						models: models.map((model) => serializeModelDraft(model)),
					},
				});
			}
			if (result.success) onClose();
			else setError(result.error || t.toastError);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : t.toastError);
		} finally {
			savingRef.current = false;
			setSaving(false);
		}
	};

	/** 供 ModelCatalog 的候选对话框调用：用表单当前值（含未保存的 key）探测远端目录 */
	const discoverAvailableModels = async (allowPrivate: boolean): Promise<ModelDraft[]> => {
		if (!baseUrl.trim()) throw new Error(t.apiAddress);
		// 自定义头要跟着发现请求一起发：网关要求自定义头时，不带就永远拿不到模型目录
		const headerEntries = (headers ?? []).map(({ name, value }) => [name.trim(), value.trim()] as [string, string]).filter(([name, value]) => name && value);
		const headerError = validateHeaderEntries(headerEntries);
		if (headerError) throw new Error(headerError);
		const response = await fetch("/api/models", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			// builtin 模式带 providerId：表单 key 为空时后端回退到已存密钥 / OAuth 令牌
			body: JSON.stringify({
				action: "discoverModels",
				baseUrl: baseUrl.trim(),
				api: mode === "builtin" ? selected?.apis[0] : api,
				apiKey: apiKey.trim(),
				providerId: mode === "builtin" ? selected?.id : undefined,
				allowPrivate,
				...(headerEntries.length && mode !== "builtin" ? { headers: Object.fromEntries(headerEntries) } : {}),
			}),
		});
		const result = await response.json();
		if (!response.ok || !result.success) throw new Error(result.error || t.toastError);
		return (result.data.models ?? []).map(modelDraftFromCatalog);
	};

	return (
		<div
			className={styles.mask}
			data-provider-modal="true"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<section ref={dialogRef} className={`${styles.dialog} ${mode === "builtin" ? styles.builtinDialog : ""}`} role="dialog" aria-modal="true" aria-labelledby="provider-setup-title">
				<header className={styles.header}>
					<h2 id="provider-setup-title" className={styles.title}>
						{mode === "builtin" ? t.addProvider : t.customProviderTitle}
					</h2>
					<button className="icon-btn" title={t.close} aria-label={t.close} onClick={onClose}>
						<IconCloseOutline14 size={17} />
					</button>
				</header>

				<div className={`${styles.body} ${mode === "builtin" ? styles.builtinBody : ""}`}>
					{mode === "builtin" ? (
						<>
							<div className={styles.field}>
								<label className={styles.label}>{t.providerLabel}</label>
								<div className={styles.picker} ref={pickerRef}>
									<button className={styles.providerTrigger} data-open={pickerOpen} onClick={() => setPickerOpen((open) => !open)}>
										{selected ? <ProviderBrand id={selected.id} name={selected.name} size={34} /> : null}
										<span className={styles.providerText}>
											<span className={styles.providerName}>{selected?.name ?? t.selectProvider}</span>
											{selected ? <span className={styles.providerMeta}>{selected.id}</span> : null}
										</span>
										<IconChevronDown14 size={15} />
									</button>
									{pickerOpen ? (
										<div className={styles.menu}>
											<div className={styles.searchWrap}>
												<span className={styles.searchIcon}><IconSearchOutline16 size={15} /></span>
												<input autoFocus className={styles.search} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t.searchProviders} />
											</div>
											<div className={styles.providerList}>
												{filtered.map((provider) => (
													<button
														key={provider.id}
														className={styles.providerRow}
														data-selected={provider.id === selectedId}
														onClick={() => {
															setSelectedId(provider.id);
															setAuthMethod("api_key");
															setApiKey("");
															setApi(provider.apis[0] ?? "openai-completions");
															setBaseUrl("");
															setModels([]);
															setPickerOpen(false);
														}}
													>
														<ProviderBrand id={provider.id} name={provider.name} size={38} />
														<span className={styles.providerText}>
															<span className={styles.providerName}>{provider.name}</span>
															<span className={styles.providerMeta}>{provider.id} · {t.modelCount.replace("{count}", String(provider.modelCount))}</span>
														</span>
														{provider.id === selectedId ? <span className={styles.selectedMark}><IconCheckOutline14 size={16} /></span> : null}
													</button>
												))}
												{filtered.length === 0 ? <div className={styles.empty}>{t.noProviderMatches}</div> : null}
											</div>
										</div>
									) : null}
								</div>
							</div>

							{selected?.authTypes.includes("oauth") && onOAuthLogin ? (
								<div className={styles.field}>
									<label className={styles.label}>{t.authMethod}</label>
									<CustomSelect
										value={authMethod}
										onChange={(val) => setAuthMethod(val as "api_key" | "oauth")}
										options={[
											{ value: "api_key", label: t.authMethodApiKey },
											{ value: "oauth", label: t.oauthLogin },
										]}
										aria-label={t.authMethod}
									/>
								</div>
							) : null}

							{authMethod === "api_key" ? (
								<div className={styles.field}>
									<label className={styles.label}>{selected?.apiKeyLabel ?? t.apiKey}</label>
									<input className={styles.input} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={t.apiKeyOptional} />
								</div>
							) : null}

							<div className={styles.advanced}>
								<button className={styles.advancedButton} data-open={advanced} onClick={() => setAdvanced((open) => !open)}>
									<IconChevronDown14 size={15} />
									{t.customSettings}
								</button>
								{advanced ? (
									<div>
										<div className={styles.field}>
											<label className={styles.label}>{t.apiAddress}</label>
											<input className={styles.input} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={selected?.baseUrl || t.providerDefault} />
										</div>
											<ModelCatalog models={models} setModels={setModels} updateModel={updateModel} inheritedCount={selected?.modelCount ?? 0} catalogIds={catalogIds} discover={discoverAvailableModels} discoverDisabled={!baseUrl.trim()} />
									</div>
								) : null}
							</div>
						</>
					) : (
						<>
							<div className={styles.field}>
								<label className={styles.label}>{t.providerId}</label>
								<input className={styles.input} autoFocus value={providerId} onChange={(event) => setProviderId(event.target.value.toLocaleLowerCase())} placeholder="acme-gateway" />
								<div className={styles.hint}>{t.providerIdHint}</div>
								{normalizedId && !customIdValid ? <div className={styles.hint} style={{ color: "var(--dsw-danger)" }}>{t.providerIdInvalid}</div> : null}
								{normalizedId && existingIds.includes(normalizedId) ? <div className={styles.hint} style={{ color: "var(--dsw-danger)" }}>{t.providerIdTaken}</div> : null}
							</div>
							<div className={styles.field}>
								<label className={styles.label}>{t.displayName}</label>
								<input className={styles.input} value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder={t.displayName} />
							</div>
							<div className={styles.field}>
								<label className={styles.label}>{t.apiAddress}</label>
								<input className={styles.input} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} onBlur={requestAutoDiscover} placeholder="https://gateway.example/v1" />
							</div>
							<div className={styles.field}>
								<label className={styles.label}>{t.apiProtocol}</label>
								<CustomSelect
									value={api}
									onChange={(val) => { setApi(val); requestAutoDiscover(); }}
									options={allApis.map((value) => ({ value, label: value }))}
									aria-label={t.apiProtocol}
								/>
							</div>
							<div className={styles.field}>
								<label className={styles.label}>{t.apiKey}</label>
								<input className={styles.input} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} onBlur={requestAutoDiscover} placeholder={t.apiKeyOptional} />
								<div className={styles.hint}>{t.customApiKeyHint}</div>
							</div>
							{/* 自定义请求头：网关常要求额外认证头，探测模型目录与发消息都会带上 */}
							<div className={styles.field}>
								<label className={styles.label}>{t.customHeaders}</label>
								{(headers ?? []).map((entry, index) => (
									<div key={index} className={styles.headerRow}>
										<input
											className={styles.input}
											value={entry.name}
											placeholder={t.customHeaderName}
											onChange={(event) => setHeaders((current) => (current ?? []).map((item, i) => (i === index ? { ...item, name: event.target.value } : item)))}
										/>
										<input
											className={styles.input}
											value={entry.value}
											placeholder={t.customHeaderValue}
											onChange={(event) => setHeaders((current) => (current ?? []).map((item, i) => (i === index ? { ...item, value: event.target.value } : item)))}
										/>
										<button
											type="button"
											className={styles.removeModel}
											title={t.delete}
											aria-label={`${t.delete} ${entry.name || index + 1}`}
											onClick={() => setHeaders((current) => (current ?? []).filter((_, i) => i !== index))}
										>
											<IconTrashOutline16 size={15} />
										</button>
									</div>
								))}
								<button type="button" className={styles.addModel} onClick={() => setHeaders((current) => [...(current ?? []), { name: "", value: "" }])}>
									<IconPlusOutline16 size={14} /> {t.customHeaderAdd}
								</button>
								<div className={styles.hint}>{t.customHeadersHint}</div>
							</div>
							<ModelCatalog
								models={models}
								setModels={setModels}
								updateModel={updateModel}
								discover={discoverAvailableModels}
								discoverDisabled={!baseUrl.trim()}
								autoDiscover={autoReady ? { signature: `${baseUrl.trim()}|${api}|${apiKey.trim()}`, trigger: autoTrigger } : undefined}
							/>
						</>
					)}
					{error ? <div className={styles.error}>{error}</div> : null}
				</div>

				<footer className={styles.footer}>
					<button className={styles.footerButton} onClick={onClose}>{t.cancel}</button>
					<button
						className={`${styles.footerButton} ${styles.primary}`}
						disabled={saving || (mode === "builtin" ? !builtinCanSave : !customCanSave)}
						onClick={submit}
					>
						{saving ? t.saving : mode === "builtin" ? t.save : t.createProvider}
					</button>
				</footer>
			</section>
		</div>
	);
}

/**
 * 行式模型目录（对齐 dsh ModelListEditor）：
 * 每行 = ID + 名称，折叠展开两个容量字段（K/M 写法）；
 * 「从提供商获取」产出候选勾选对话框，采纳不覆盖已配置行。
 */
export function ModelCatalog({
	models,
	setModels,
	updateModel,
	inheritedCount,
	catalogIds,
	discover,
	discoverDisabled,
	autoDiscover,
}: {
	models: ModelDraft[];
	setModels: React.Dispatch<React.SetStateAction<ModelDraft[]>>;
	updateModel: (index: number, patch: Partial<ModelDraft>) => void;
	inheritedCount?: number;
	/** 内置 provider 的目录模型 ID：候选里已在目录中的不能勾选（本来就能选），同 ID 的行只覆盖填写的字段 */
	catalogIds?: ReadonlySet<string>;
	/** 用表单当前值探测远端目录；本机 / 私网地址一律放行（服务端仍会自己再判一次）；抛错时错误显示在目录内 */
	discover?: (allowPrivate: boolean) => Promise<ModelDraft[]>;
	discoverDisabled?: boolean;
	/**
	 * 自动识别：trigger 变了（地址 / 密钥失焦、换协议）就按当前签名（URL + 协议 + 密钥）拉一次模型目录。
	 * 只在「还没有任何模型行」时给出；同一签名只跑一次，清空模型行后不会自己又加回来。
	 */
	autoDiscover?: { signature: string; trigger: number };
}) {
	const { t } = useI18n();
	const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
	const [discovering, setDiscovering] = useState(false);
	const [discoverError, setDiscoverError] = useState("");
	// 候选对话框：null = 关闭
	const [candidates, setCandidates] = useState<ModelDraft[] | null>(null);
	const candidateRef = useRef<HTMLDivElement>(null);
	const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
	// 容量逐字段文本缓冲，避免输入中被 K/M 格式化打断
	const [capacityText, setCapacityText] = useState<Record<string, string>>({});

	const toggleExpanded = (index: number) =>
		setExpanded((current) => {
			const next = new Set(current);
			if (!next.delete(index)) next.add(index);
			return next;
		});

	const capacityValue = (model: ModelDraft, index: number, field: "contextWindow" | "maxTokens") =>
		capacityText[`${index}:${field}`] ?? formatCapacity(model[field]);

	const editCapacity = (index: number, field: "contextWindow" | "maxTokens", text: string) => {
		setCapacityText((current) => ({ ...current, [`${index}:${field}`]: text }));
		updateModel(index, { [field]: parseCapacity(text) } as Partial<ModelDraft>);
	};

	const removeModel = (index: number) => {
		setModels((current) => current.filter((_, modelIndex) => modelIndex !== index));
		setExpanded((current) => {
			const next = new Set<number>();
			for (const at of current) if (at !== index) next.add(at > index ? at - 1 : at);
			return next;
		});
		setCapacityText((current) => {
			const next: Record<string, string> = {};
			for (const [key, value] of Object.entries(current)) {
				const at = Number(key.slice(0, key.indexOf(":")));
				if (at === index) continue;
				next[at > index ? `${at - 1}${key.slice(key.indexOf(":"))}` : key] = value;
			}
			return next;
		});
	};

	const inCatalog = (id: string) => catalogIds?.has(id.trim()) ?? false;

	// 自动识别：地址 / 密钥输入框失焦时（父组件递增 trigger）自己去拉一次目录，不用再点按钮。
	// 不按「停手」计时：那样会拿半截地址和半截密钥去发请求。同一签名只跑一次；
	// 表单一改（签名变了）就作废还在路上的那次，迟到的结果不会把别的地址的模型塞进来。
	const auto = autoDiscover;
	const autoDone = useRef("");
	const autoSeq = useRef(0);
	const autoPending = useRef(false);
	// 处理过的最后一次 trigger：条目从无到有（如清空模型行）时 trigger 没变，不算一次新的失焦
	const autoTriggerSeen = useRef(0);
	const [autoStatus, setAutoStatus] = useState<"" | "loading" | "done" | "empty" | "failed">("");
	const [autoFound, setAutoFound] = useState(0);
	useEffect(() => {
		if (!autoPending.current) return;
		autoPending.current = false;
		autoSeq.current += 1;
		// 作废的那次不算跑过：改回原值再失焦还能重试
		autoDone.current = "";
		setAutoStatus("");
	}, [auto?.signature]);
	useEffect(() => {
		if (!auto || auto.trigger === autoTriggerSeen.current) return;
		autoTriggerSeen.current = auto.trigger;
		if (!discover || autoDone.current === auto.signature) return;
		autoDone.current = auto.signature;
		autoPending.current = true;
		const seq = ++autoSeq.current;
		setAutoStatus("loading");
		const settle = (status: "done" | "empty" | "failed") => {
			if (seq !== autoSeq.current) return false;
			autoPending.current = false;
			setAutoStatus(status);
			return true;
		};
		// 本机/私网地址一并放行：探测模型目录本来就是本机使用，服务端仍会自己再判一次
		discover(true).then(
			(found) => {
				if (!settle(found.length ? "done" : "empty")) return;
				setAutoFound(found.length);
				setModels((current) => (current.length ? current : found));
			},
			// 自动跑失败不弹错：按钮还在，手动点能看到具体原因
			() => void settle("failed"),
		);
		// 只由失焦触发；discover 每次渲染都是新函数，放进依赖会让任何重渲染都重跑
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [auto?.trigger]);

	const startDiscover = async () => {
		if (!discover || discovering) return;
		// 手动点了就以候选对话框为准：点按钮时输入框失焦触发的那次自动识别作废
		if (autoPending.current) {
			autoPending.current = false;
			autoSeq.current += 1;
			autoDone.current = "";
			setAutoStatus("");
		}
		setDiscovering(true);
		setDiscoverError("");
		try {
			const found = await discover(true);
			if (!found.length) {
				setDiscoverError(t.discoverEmpty);
				return;
			}
			// 已配置的行默认不勾选：采纳永远不覆盖用户改过的内容。
			// 内置目录里已有的模型本来就能选，加成行只会变成一条空覆盖：排到后面、不可勾选
			const known = new Set(models.map((model) => model.id.trim()).filter(Boolean));
			const ordered = [...found.filter((model) => !inCatalog(model.id)), ...found.filter((model) => inCatalog(model.id))];
			setCandidates(ordered);
			setPicked(new Set(ordered.filter((model) => !known.has(model.id.trim()) && !inCatalog(model.id)).map((model) => model.id)));
		} catch (reason) {
			setDiscoverError(reason instanceof Error ? reason.message : t.toastError);
		} finally {
			setDiscovering(false);
		}
	};

	const closeCandidates = () => {
		setCandidates(null);
		setPicked(new Set());
	};
	useDialog({ open: candidates !== null, onClose: closeCandidates, ref: candidateRef });

	const adoptPicked = () => {
		if (!candidates) return;
		setModels((current) => {
			const byId = new Map(current.map((model) => [model.id.trim(), model]));
			for (const candidate of candidates) {
				const id = candidate.id.trim();
				if (!id || !picked.has(id) || byId.has(id) || inCatalog(id)) continue;
				byId.set(id, candidate);
			}
			return [...byId.values()];
		});
		closeCandidates();
	};

	const visibleCandidates = candidates ?? [];
	// 「全选」只管能勾的那些
	const selectableCandidates = visibleCandidates.filter((model) => !inCatalog(model.id));
	const allVisiblePicked = selectableCandidates.length > 0 && selectableCandidates.every((model) => picked.has(model.id));

	const togglePick = (id: string) =>
		setPicked((current) => {
			const next = new Set(current);
			if (!next.delete(id)) next.add(id);
			return next;
		});

	const firstInvalid = validateModelDrafts(models);
	const overridesBuiltin = models.some((model) => inCatalog(model.id));

	return (
		<div className={styles.catalog}>
			<div className={styles.catalogHeader}>
				<div>
					<div className={styles.label}>{t.modelCatalog}</div>
					<div className={styles.catalogStatus}>
						{inheritedCount ? t.usingDefaultModels.replace("{count}", String(inheritedCount)) : t.customModelsRequired}
						{autoStatus === "loading" ? ` · ${t.autoDiscovering}` : null}
						{autoStatus === "done" ? ` · ${t.autoDiscovered.replace("{n}", String(autoFound))}` : null}
						{autoStatus === "empty" ? ` · ${t.discoverEmpty}` : null}
						{autoStatus === "failed" ? ` · ${t.autoDiscoverFailed}` : null}
					</div>
				</div>
				{discover ? (
					<div className={styles.discoverControls}>
						<button className={styles.discoverButton} disabled={discoverDisabled || discovering} onClick={() => void startDiscover()}>
							{discovering ? t.discoveringModels : t.discoverModels}
						</button>
					</div>
				) : null}
			</div>
			{discoverError ? <div className={styles.catalogError}>{discoverError}</div> : null}
			{models.length ? (
				<div className={styles.modelList}>
					{models.map((model, index) => {
						const open = expanded.has(index);
						const badCapacity = Number.isNaN(model.contextWindow) || Number.isNaN(model.maxTokens);
						return (
							<div className={styles.modelEntry} key={index}>
								<div className={styles.modelRow}>
									<button
										type="button"
										className={styles.rowToggle}
										title={t.capacityFields}
										onClick={() => toggleExpanded(index)}
									>
										<IconChevronDown14 size={13} style={{ transform: open ? "rotate(0deg)" : "rotate(-90deg)", transition: "transform 120ms ease" }} />
									</button>
									<input
										className={styles.input}
										style={{ borderColor: !model.id.trim() && firstInvalid?.index === index ? "var(--dsw-danger)" : undefined }}
										value={model.id}
										onChange={(event) => updateModel(index, { id: event.target.value })}
										placeholder={t.modelId}
									/>
									<input className={styles.input} value={model.name} onChange={(event) => updateModel(index, { name: event.target.value })} placeholder={t.displayNameOptional} />
									<button className={styles.removeModel} title={t.delete} onClick={() => removeModel(index)}>
										<IconTrashOutline16 size={15} />
									</button>
								</div>
								{open ? (
									<div className={styles.capacityRow}>
										<label className={styles.capacityField}>
											<span>{t.contextWindowLabel}</span>
											<input
												className={styles.input}
												style={{ borderColor: Number.isNaN(model.contextWindow) ? "var(--dsw-danger)" : undefined }}
												value={capacityValue(model, index, "contextWindow")}
												onChange={(event) => editCapacity(index, "contextWindow", event.target.value)}
												placeholder="128K"
											/>
										</label>
										<label className={styles.capacityField}>
											<span>{t.maxTokensLabel}</span>
											<input
												className={styles.input}
												style={{ borderColor: Number.isNaN(model.maxTokens) ? "var(--dsw-danger)" : undefined }}
												value={capacityValue(model, index, "maxTokens")}
												onChange={(event) => editCapacity(index, "maxTokens", event.target.value)}
												placeholder="16K"
											/>
										</label>
										<div className={styles.capacityField} title={t.visionHint}>
											<span>{t.visionLabel}</span>
											<CustomSelect
												size="sm"
												style={{ width: 104 }}
												value={model.vision === undefined ? "unset" : model.vision ? "image" : "text"}
												onChange={(choice) => {
													// 未声明 = 不写 input：pi 按纯文本处理，体检卡片会列出来提醒
													updateModel(index, { vision: choice === "unset" ? undefined : choice === "image" });
												}}
												options={[
													{ value: "unset", label: t.visionUnset },
													{ value: "image", label: t.visionOn },
													{ value: "text", label: t.visionOff },
												]}
												aria-label={t.visionLabel}
											/>
										</div>
										<div className={styles.capacityField} title={t.reasoningHint}>
											<span>{t.reasoningLabel}</span>
											<CustomSelect
												size="sm"
												style={{ width: 104 }}
												value={model.reasoning === undefined ? "unset" : model.reasoning ? "on" : "off"}
												onChange={(choice) => {
													// 未声明 = 不写 reasoning：pi 按 false 处理，思考档位会消失，体检卡片会提醒
													updateModel(index, { reasoning: choice === "unset" ? undefined : choice === "on" });
												}}
												options={[
													{ value: "unset", label: t.reasoningUnset },
													{ value: "on", label: t.reasoningOn },
													{ value: "off", label: t.reasoningOff },
												]}
												aria-label={t.reasoningLabel}
											/>
										</div>
										<span className={styles.capacityHint}>{t.capacityHint}</span>
									</div>
								) : null}
								{badCapacity ? <div className={styles.rowError}>{t.capacityInvalid.replace("{n}", String(index + 1))}</div> : null}
							</div>
						);
					})}
				</div>
			) : (
				<div className={styles.modelEmpty}>{inheritedCount ? t.modelCatalogEmptyBuiltin : t.modelCatalogEmptyCustom}</div>
			)}
			{overridesBuiltin ? <div className={styles.catalogHint}>{t.catalogOverrideHint}</div> : null}
			<button className={styles.addModel} onClick={() => setModels((current) => [...current, { id: "", name: "" }])}>
				<IconPlusOutline16 size={14} />
				{t.addModel}
			</button>

			{candidates ? (
				<div className={styles.candidateMask}>
					<div ref={candidateRef} className={styles.candidateDialog} role="dialog" aria-modal="true" aria-label={t.discoverModels}>
						<div className={styles.candidateHeader}>
							<span>{t.candidateTitle.replace("{count}", String(candidates.length))}</span>
						</div>
						<div className={styles.candidateList}>
							{visibleCandidates.map((model) => {
								const listed = inCatalog(model.id);
								return (
									<label className={styles.candidateRow} data-disabled={listed || undefined} key={model.id}>
										<input type="checkbox" checked={!listed && picked.has(model.id)} disabled={listed} onChange={() => togglePick(model.id)} />
										<span className={styles.candidateId}>{model.id}</span>
										{model.name ? <span className={styles.candidateName}>{model.name}</span> : null}
										{listed ? <span className={styles.candidateTag}>{t.candidateInCatalog}</span> : null}
									</label>
								);
							})}
							{visibleCandidates.length === 0 ? <div className={styles.modelEmpty}>—</div> : null}
						</div>
						<div className={styles.candidateActions}>
							<label className={styles.candidateAll}>
								<input
									type="checkbox"
									checked={allVisiblePicked}
									disabled={selectableCandidates.length === 0}
									onChange={() =>
										setPicked((current) => {
											const next = new Set(current);
											if (selectableCandidates.every((model) => next.has(model.id))) selectableCandidates.forEach((model) => next.delete(model.id));
											else selectableCandidates.forEach((model) => next.add(model.id));
											return next;
										})
									}
								/>
								{t.candidateAll}
							</label>
							<span className={styles.candidatePicked}>{t.candidatePicked.replace("{n}", String(picked.size))}</span>
							<button className={styles.footerButton} onClick={closeCandidates}>{t.cancel}</button>
							<button className={`${styles.footerButton} ${styles.primary}`} disabled={picked.size === 0} onClick={adoptPicked}>
								{t.candidateAdopt.replace("{n}", String(picked.size))}
							</button>
						</div>
					</div>
				</div>
			) : null}
		</div>
	);
}
