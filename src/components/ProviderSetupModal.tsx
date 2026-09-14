"use client";

import { useEffect, useRef, useState } from "react";
import {
	IconCheckOutline14,
	IconChevronDown14,
	IconCloseOutline14,
	IconPlusOutline16,
	IconSearchOutline16,
	IconTrashOutline16,
} from "@/components/icons";
import { ProviderBrand } from "@/components/ProviderBrand";
import { useI18n } from "@/i18n";
import { CUSTOM_PROVIDER_ID_PATTERN, customApiOptions } from "@/lib/provider-display";
import { formatCapacity, parseCapacity, serializeModelDraft, validateModelDrafts, type ModelDraft } from "@/lib/model-draft";
import type { ProviderView } from "@/lib/models-service";
import styles from "./ProviderSetupModal.module.css";

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
	existingIds,
	onClose,
	onSaveBuiltin,
	onSaveCustom,
	onOAuthLogin,
}: {
	mode: "builtin" | "custom";
	providers: ProviderView[];
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
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const pickerRef = useRef<HTMLDivElement>(null);
	const selected = providers.find((provider) => provider.id === selectedId);
	const filtered = providers.filter((provider) => {
		const needle = search.trim().toLocaleLowerCase();
		return !needle || provider.name.toLocaleLowerCase().includes(needle) || provider.id.toLocaleLowerCase().includes(needle);
	});

	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			if (pickerOpen) setPickerOpen(false);
			else onClose();
		};
		document.addEventListener("keydown", handleKeyDown, true);
		return () => document.removeEventListener("keydown", handleKeyDown, true);
	}, [onClose, pickerOpen]);

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
					const config: Record<string, unknown> = {};
					if (baseUrl.trim()) config.baseUrl = baseUrl.trim();
					if (models.length) {
						config.api = selected.apis[0] ?? "openai-completions";
						config.models = models.map(serializeModelDraft);
					}
					result = await onSaveBuiltin({ providerId: selected.id, apiKey: apiKey.trim(), config });
				}
			} else {
				result = await onSaveCustom({
					providerId: normalizedId,
					config: {
						name: displayName.trim() || normalizedId,
						baseUrl: baseUrl.trim(),
						api,
						...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
						models: models.map(serializeModelDraft),
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
	const discoverAvailableModels = async (): Promise<ModelDraft[]> => {
		if (!baseUrl.trim()) throw new Error(t.apiAddress);
		const response = await fetch("/api/models", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			// builtin 模式带 providerId：表单 key 为空时后端回退到已存密钥 / OAuth 令牌
			body: JSON.stringify({ action: "discoverModels", baseUrl: baseUrl.trim(), api: mode === "builtin" ? selected?.apis[0] : api, apiKey: apiKey.trim(), providerId: mode === "builtin" ? selected?.id : undefined }),
		});
		const result = await response.json();
		if (!response.ok || !result.success) throw new Error(result.error || t.toastError);
		return (result.data.models ?? []).map((model: { id: string; name?: string }) => ({ id: model.id, name: model.name ?? "" }));
	};

	return (
		<div
			className={styles.mask}
			data-provider-modal="true"
			onMouseDown={(event) => {
				if (event.target === event.currentTarget) onClose();
			}}
		>
			<section className={`${styles.dialog} ${mode === "builtin" ? styles.builtinDialog : ""}`} role="dialog" aria-modal="true" aria-labelledby="provider-setup-title">
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
									<select className={styles.select} value={authMethod} onChange={(event) => setAuthMethod(event.target.value as "api_key" | "oauth")}>
										<option value="api_key">{t.authMethodApiKey}</option>
										<option value="oauth">{t.oauthLogin}</option>
									</select>
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
											<ModelCatalog models={models} setModels={setModels} updateModel={updateModel} inheritedCount={selected?.modelCount ?? 0} discover={discoverAvailableModels} discoverDisabled={!baseUrl.trim()} />
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
								<input className={styles.input} value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://gateway.example/v1" />
							</div>
							<div className={styles.field}>
								<label className={styles.label}>{t.apiProtocol}</label>
								<select className={styles.select} value={api} onChange={(event) => setApi(event.target.value)}>
									{allApis.map((value) => <option key={value} value={value}>{value}</option>)}
								</select>
							</div>
							<div className={styles.field}>
								<label className={styles.label}>{t.apiKey}</label>
								<input className={styles.input} type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={t.apiKeyOptional} />
								<div className={styles.hint}>{t.customApiKeyHint}</div>
							</div>
							<ModelCatalog
								models={models}
								setModels={setModels}
								updateModel={updateModel}
								discover={discoverAvailableModels}
								discoverDisabled={!baseUrl.trim()}
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
	discover,
	discoverDisabled,
}: {
	models: ModelDraft[];
	setModels: React.Dispatch<React.SetStateAction<ModelDraft[]>>;
	updateModel: (index: number, patch: Partial<ModelDraft>) => void;
	inheritedCount?: number;
	/** 用表单当前值探测远端目录；抛错时错误显示在目录内 */
	discover?: () => Promise<ModelDraft[]>;
	discoverDisabled?: boolean;
}) {
	const { t } = useI18n();
	const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
	const [discovering, setDiscovering] = useState(false);
	const [discoverError, setDiscoverError] = useState("");
	// 候选对话框：null = 关闭
	const [candidates, setCandidates] = useState<ModelDraft[] | null>(null);
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

	const startDiscover = async () => {
		if (!discover || discovering) return;
		setDiscovering(true);
		setDiscoverError("");
		try {
			const found = await discover();
			if (!found.length) {
				setDiscoverError(t.discoverEmpty);
				return;
			}
			// 已配置的行默认不勾选：采纳永远不覆盖用户改过的内容
			const known = new Set(models.map((model) => model.id.trim()).filter(Boolean));
			setCandidates(found);
			setPicked(new Set(found.filter((model) => !known.has(model.id.trim())).map((model) => model.id)));
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

	const adoptPicked = () => {
		if (!candidates) return;
		setModels((current) => {
			const byId = new Map(current.map((model) => [model.id.trim(), model]));
			for (const candidate of candidates) {
				const id = candidate.id.trim();
				if (!id || !picked.has(id) || byId.has(id)) continue;
				byId.set(id, { id, name: candidate.name ?? "" });
			}
			return [...byId.values()];
		});
		closeCandidates();
	};

	const visibleCandidates = candidates ?? [];
	const allVisiblePicked = visibleCandidates.length > 0 && visibleCandidates.every((model) => picked.has(model.id));

	const togglePick = (id: string) =>
		setPicked((current) => {
			const next = new Set(current);
			if (!next.delete(id)) next.add(id);
			return next;
		});

	const firstInvalid = validateModelDrafts(models);

	return (
		<div className={styles.catalog}>
			<div className={styles.catalogHeader}>
				<div>
					<div className={styles.label}>{t.modelCatalog}</div>
					<div className={styles.catalogStatus}>
						{inheritedCount ? t.usingDefaultModels.replace("{count}", String(inheritedCount)) : t.customModelsRequired}
					</div>
				</div>
				{discover ? (
					<button className={styles.discoverButton} disabled={discoverDisabled || discovering} onClick={() => void startDiscover()}>
						{discovering ? t.discoveringModels : t.discoverModels}
					</button>
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
			<button className={styles.addModel} onClick={() => setModels((current) => [...current, { id: "", name: "" }])}>
				<IconPlusOutline16 size={14} />
				{t.addModel}
			</button>

			{candidates ? (
				<div className={styles.candidateMask}>
					<div className={styles.candidateDialog} role="dialog" aria-modal="true" aria-label={t.discoverModels}>
						<div className={styles.candidateHeader}>
							<span>{t.candidateTitle.replace("{count}", String(candidates.length))}</span>
						</div>
						<div className={styles.candidateList}>
							{visibleCandidates.map((model) => (
								<label className={styles.candidateRow} key={model.id}>
									<input type="checkbox" checked={picked.has(model.id)} onChange={() => togglePick(model.id)} />
									<span className={styles.candidateId}>{model.id}</span>
									{model.name ? <span className={styles.candidateName}>{model.name}</span> : null}
								</label>
							))}
							{visibleCandidates.length === 0 ? <div className={styles.modelEmpty}>—</div> : null}
						</div>
						<div className={styles.candidateActions}>
							<label className={styles.candidateAll}>
								<input
									type="checkbox"
									checked={allVisiblePicked}
									onChange={() =>
										setPicked((current) => {
											const next = new Set(current);
											if (visibleCandidates.every((model) => next.has(model.id))) visibleCandidates.forEach((model) => next.delete(model.id));
											else visibleCandidates.forEach((model) => next.add(model.id));
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
