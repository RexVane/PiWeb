"use client";
import { clientFetch as fetch } from "@/lib/client-fetch";


import { useEffect, useId, useMemo, useRef, useState } from "react";
import { IconCloseOutline14 } from "@/components/icons";
import { SelectOption } from "@/components/settings/SharedControls";
import { useDialog } from "@/hooks/useDialog";
import { useI18n } from "@/i18n";
import type { Lang } from "@/lib/lang";
import { validateSchedule } from "@/lib/automations/schedule";
import type { AutomationModelRef, AutomationSchedule, AutomationSchedulePreview, AutomationTask } from "@/lib/automations/types";

export interface ModelChoiceItem {
	provider: string;
	id: string;
	name: string;
}

const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAY_SHORT: Record<Lang, string[]> = {
	zh: ["日", "一", "二", "三", "四", "五", "六"],
	"zh-Hant": ["日", "一", "二", "三", "四", "五", "六"],
	en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
	ja: ["日", "月", "火", "水", "木", "金", "土"],
	ru: ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"],
};
const DEFAULT_MODEL_VALUE = "__default__";

export function AutomationModal({
	open,
	initialTask,
	knownCwds,
	defaultCwd,
	getWorkspaceName,
	onClose,
	onSaved,
}: {
	open: boolean;
	initialTask: AutomationTask | null;
	knownCwds: string[];
	defaultCwd: string;
	getWorkspaceName: (cwd: string) => string;
	models: ModelChoiceItem[];
	onClose: () => void;
	onSaved: () => void;
}) {
	const { t, lang } = useI18n();
	const dialogRef = useRef<HTMLDivElement>(null);
	const titleId = useId();

	const [name, setName] = useState("");
	const [prompt, setPrompt] = useState("");
	const [cwd, setCwd] = useState("");
	const [kind, setKind] = useState<AutomationSchedule["kind"]>("daily");
	const [every, setEvery] = useState(30);
	const [unit, setUnit] = useState<"minutes" | "hours">("minutes");
	const [time, setTime] = useState("09:00");
	const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
	const [cronExpr, setCronExpr] = useState("0 9 * * 1-5");
	const [modelKey, setModelKey] = useState<string>(DEFAULT_MODEL_VALUE);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [workspaceModels, setWorkspaceModels] = useState<{ cwd: string; items: ModelChoiceItem[] } | null>(null);
	const [modelsLoading, setModelsLoading] = useState(false);
	const [modelsError, setModelsError] = useState<string | null>(null);
	const [serverPreview, setServerPreview] = useState<(AutomationSchedulePreview & { scheduleKey: string }) | null>(null);
	const [previewError, setPreviewError] = useState<string | null>(null);
	const initializedTaskRef = useRef<string | null | undefined>(undefined);
	useDialog({ open, onClose: () => { if (!saving) onClose(); }, ref: dialogRef });

	useEffect(() => {
		if (!open) {
			initializedTaskRef.current = undefined;
			return;
		}
		const taskId = initialTask?.id ?? null;
		if (initializedTaskRef.current === taskId) {
			if (!initialTask && !cwd) setCwd(defaultCwd || knownCwds[0] || "");
			return;
		}
		initializedTaskRef.current = taskId;
		setError(null);
		if (initialTask) {
			setName(initialTask.name);
			setPrompt(initialTask.prompt);
			setCwd(initialTask.cwd);
			setModelKey(initialTask.model ? `${initialTask.model.provider}\0${initialTask.model.id}` : DEFAULT_MODEL_VALUE);
			setKind(initialTask.schedule.kind);
			if (initialTask.schedule.kind === "interval") {
				setEvery(initialTask.schedule.every);
				setUnit(initialTask.schedule.unit);
			} else if (initialTask.schedule.kind === "daily") {
				setTime(initialTask.schedule.time);
			} else if (initialTask.schedule.kind === "weekly") {
				setDays([...initialTask.schedule.days]);
				setTime(initialTask.schedule.time);
			} else if (initialTask.schedule.kind === "cron") {
				setCronExpr(initialTask.schedule.expr);
			}
			return;
		}
		setName("");
		setPrompt("");
		setCwd(defaultCwd || knownCwds[0] || "");
		setKind("daily");
		setEvery(30);
		setUnit("minutes");
		setTime("09:00");
		setDays([1, 2, 3, 4, 5]);
		setCronExpr("0 9 * * 1-5");
		setModelKey(DEFAULT_MODEL_VALUE);
	}, [open, initialTask, defaultCwd, knownCwds, cwd]);

	useEffect(() => {
		if (!open || !cwd) return;
		const controller = new AbortController();
		setWorkspaceModels(null);
		setModelsLoading(true);
		setModelsError(null);
		void (async () => {
			try {
				const response = await fetch(`/api/models?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal });
				const json = await response.json();
				if (controller.signal.aborted) return;
				if (!json.success || !Array.isArray(json.data?.models)) throw new Error(json.error || t.toastError);
				setWorkspaceModels({ cwd, items: json.data.models });
			} catch (error: unknown) {
				if (!controller.signal.aborted) setModelsError(error instanceof Error ? error.message : t.toastError);
			} finally {
				if (!controller.signal.aborted) setModelsLoading(false);
			}
		})();
		return () => controller.abort();
	}, [open, cwd, t.toastError]);

	const candidateSchedule = useMemo<AutomationSchedule>(() => {
		switch (kind) {
			case "interval":
				return { kind: "interval", every: Number(every), unit };
			case "daily":
				return { kind: "daily", time };
			case "weekly":
				return { kind: "weekly", days, time };
			case "cron":
				return { kind: "cron", expr: cronExpr };
		}
	}, [kind, every, unit, time, days, cronExpr]);

	const validSchedule = useMemo(() => {
		try {
			return { ok: true as const, value: validateSchedule(candidateSchedule) };
		} catch (err: unknown) {
			return { ok: false as const, error: err instanceof Error ? err.message : t.autoInvalidSchedule };
		}
	}, [candidateSchedule, t.autoInvalidSchedule]);
	const previewKey = validSchedule.ok ? JSON.stringify(validSchedule.value) : null;

	useEffect(() => {
		if (!open || !validSchedule.ok || !previewKey) return;
		const controller = new AbortController();
		setServerPreview(null);
		setPreviewError(null);
		void (async () => {
			try {
				const response = await fetch("/api/automations/preview", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ schedule: validSchedule.value }),
					signal: controller.signal,
				});
				const json = await response.json();
				if (controller.signal.aborted) return;
				if (!json.success || typeof json.data?.timeZone !== "string" || (json.data.nextRunAt !== null && !Number.isFinite(json.data.nextRunAt))) {
					throw new Error(json.error || t.autoPreviewError);
				}
				new Intl.DateTimeFormat("en-US", { timeZone: json.data.timeZone });
				setServerPreview({ ...json.data, scheduleKey: previewKey });
			} catch (err: unknown) {
				if (!controller.signal.aborted) setPreviewError(err instanceof Error ? err.message : t.autoPreviewError);
			}
		})();
		return () => controller.abort();
	}, [open, validSchedule, previewKey, t.autoPreviewError]);

	const schedulePreview = useMemo(() => {
		if (!validSchedule.ok) return validSchedule;
		if (previewError) return { ok: false as const, error: previewError };
		if (serverPreview?.scheduleKey !== previewKey) return { ok: true as const, label: t.autoPreviewLoading };
		const zone = t.autoTimeZone.replace("{timezone}", serverPreview.timeZone);
		if (serverPreview.nextRunAt === null) return { ok: true as const, label: zone };
		const formatted = new Intl.DateTimeFormat(lang === "en" ? "en-US" : "zh-CN", {
				timeZone: serverPreview.timeZone,
				month: "2-digit",
				day: "2-digit",
				hour: "2-digit",
				minute: "2-digit",
				hour12: false,
			}).format(new Date(serverPreview.nextRunAt));
		return { ok: true as const, label: `${t.autoNextPreview.replace("{time}", formatted)} · ${zone}` };
	}, [validSchedule, previewError, serverPreview, previewKey, lang, t]);

	const workspaceOptions = useMemo(() => {
		const ordered: string[] = [];
		const seen = new Set<string>();
		const norm = (p: string) => {
			const clean = p.replace(/\\/g, "/").replace(/\/+$/, "");
			return /^[A-Za-z]:\//.test(clean) || clean.startsWith("//") ? clean.toLowerCase() : clean;
		};
		for (const candidate of [...(defaultCwd ? [defaultCwd] : []), ...knownCwds, ...(cwd ? [cwd] : [])]) {
			if (!candidate) continue;
			const key = norm(candidate);
			if (seen.has(key)) continue;
			seen.add(key);
			ordered.push(candidate);
		}
		return ordered.map((c) => ({ value: c, label: getWorkspaceName(c) || c }));
	}, [defaultCwd, knownCwds, cwd, getWorkspaceName]);

	const modelOptions = useMemo(() => {
		const base: { value: string; label: string; disabled?: boolean }[] = [{ value: DEFAULT_MODEL_VALUE, label: t.autoModelDefault }];
		for (const m of workspaceModels?.cwd === cwd ? workspaceModels.items : []) {
			base.push({ value: `${m.provider}\0${m.id}`, label: `${m.provider} / ${m.name || m.id}` });
		}
		if (modelKey !== DEFAULT_MODEL_VALUE && !base.some((option) => option.value === modelKey)) {
			base.push({ value: modelKey, label: modelKey.replace("\0", " / "), disabled: true });
		}
		return base;
	}, [workspaceModels, cwd, modelKey, t.autoModelDefault]);
	const unavailableModel = !modelsLoading && workspaceModels?.cwd === cwd && modelKey !== DEFAULT_MODEL_VALUE && modelOptions.find((option) => option.value === modelKey)?.disabled === true;
	const modelSelectionBlocked = modelKey !== DEFAULT_MODEL_VALUE && (modelsLoading || workspaceModels?.cwd !== cwd || unavailableModel);

	if (!open) return null;

	const toggleDay = (d: number) => {
		setDays((prev) => {
			if (prev.includes(d)) return prev.length > 1 ? prev.filter((item) => item !== d) : prev;
			return [...prev, d].sort((a, b) => a - b);
		});
	};

	const parseModelSelection = (): AutomationModelRef | null => {
		if (modelKey === DEFAULT_MODEL_VALUE || !modelKey.includes("\0")) return null;
		const sep = modelKey.indexOf("\0");
		return { provider: modelKey.slice(0, sep), id: modelKey.slice(sep + 1) };
	};

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		if (saving) return;
		setError(null);

		let validSchedule: AutomationSchedule;
		try {
			validSchedule = validateSchedule(candidateSchedule);
		} catch (err: any) {
			setError(String(err?.message ?? t.autoInvalidSchedule));
			return;
		}
		if (!cwd.trim()) {
			setError(t.autoNeedWorkspace);
			return;
		}
		if (modelSelectionBlocked) return;

		setSaving(true);
		try {
			const model = parseModelSelection();
			const payload = initialTask
				? {
						action: "update",
						id: initialTask.id,
						name: name.trim(),
						prompt: prompt.trim(),
						cwd,
						schedule: validSchedule,
						model,
				  }
				: {
						action: "create",
						name: name.trim(),
						prompt: prompt.trim(),
						cwd,
						schedule: validSchedule,
						...(model ? { model } : {}),
				  };
			const res = await fetch("/api/automations", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(payload),
			});
			const json = await res.json();
			if (!json.success) {
				setError(json.error || t.toastError);
				return;
			}
			onSaved();
			onClose();
		} catch (err: any) {
			setError(String(err?.message ?? t.toastError));
		} finally {
			setSaving(false);
		}
	};

	const labelStyle: React.CSSProperties = { fontSize: "var(--dsh-ui-font-125)", fontWeight: 500, color: "var(--dsw-label-secondary)" };
	const fieldStyle: React.CSSProperties = {
		fontSize: "var(--dsh-ui-font-sm)",
		background: "var(--dsw-hover)",
		border: "0.5px solid var(--dsw-border-l2)",
		color: "var(--dsw-label-primary)",
	};

	return (
		<div
			className="modal-mask fixed inset-0 z-[100] flex items-center justify-center"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget && !saving) onClose();
			}}
		>
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				className="settings-dialog glass-modal flex flex-col overflow-hidden"
				style={{
					width: 580,
					maxWidth: "calc(100vw - 32px)",
					maxHeight: "min(760px, calc(100vh - 32px))",
					borderRadius: "var(--pw-radius-modal)",
					boxShadow: "var(--pw-shadow-modal)",
				}}
			>
				<div className="hairline-b flex items-center justify-between px-6 py-4">
					<h2 id={titleId} style={{ fontSize: "calc(16px + var(--dsh-content-font-delta))", fontWeight: 600, color: "var(--dsw-label-primary)" }}>
						{initialTask ? t.autoEditTitle : t.autoCreateTitle}
					</h2>
					<button type="button" className="icon-btn" aria-label={t.close} onClick={onClose} disabled={saving}>
						<IconCloseOutline14 size={15} />
					</button>
				</div>

				<form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
					<div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
						{error && (
							<div
								role="alert"
								className="rounded-xl px-3.5 py-2.5"
								style={{
									fontSize: "var(--dsh-ui-font-125)",
									background: "color-mix(in srgb, var(--dsw-danger) 12%, transparent)",
									border: "0.5px solid color-mix(in srgb, var(--dsw-danger) 35%, transparent)",
									color: "var(--dsw-danger)",
								}}
							>
								{error}
							</div>
						)}

						<div className="space-y-1.5">
							<label style={labelStyle}>{t.autoName}</label>
							<input
								required
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder={t.autoNamePlaceholder}
								className="w-full rounded-xl px-3 py-2"
								style={fieldStyle}
							/>
						</div>

						<div className="space-y-1.5">
							<label style={labelStyle}>{t.autoPrompt}</label>
							<textarea
								required
								rows={4}
								value={prompt}
								onChange={(e) => setPrompt(e.target.value)}
								placeholder={t.autoPromptPlaceholder}
								className="w-full resize-y rounded-xl px-3 py-2"
								style={fieldStyle}
							/>
						</div>

						<div className="space-y-1.5">
							<div style={labelStyle}>{t.autoWorkspace}</div>
							{workspaceOptions.length > 0 ? (
								<SelectOption
									value={cwd}
									label={t.autoWorkspace}
									options={workspaceOptions}
									onChange={setCwd}
									width={240}
								/>
							) : (
								<div style={{ fontSize: "var(--dsh-ui-font-xs)", color: "var(--dsw-danger)" }}>{t.autoNeedWorkspace}</div>
							)}
						</div>

						<div className="space-y-1.5">
							<div style={labelStyle}>{t.autoModel}</div>
							<SelectOption
								value={modelKey}
								label={t.autoModel}
								options={modelOptions}
								onChange={setModelKey}
								width={320}
								disabled={saving || modelsLoading}
							/>
							{(modelsError || unavailableModel) && <div role="alert" style={{ fontSize: 12, color: "var(--dsw-danger)" }}>{modelsError || t.autoModelUnavailable}</div>}
						</div>

						<div
							className="space-y-3 rounded-2xl p-4"
							style={{
								border: "0.5px solid var(--dsw-border-l2)",
								background: "color-mix(in srgb, var(--dsw-hover) 40%, transparent)",
							}}
						>
							<div style={labelStyle}>{t.autoSchedule}</div>
							<div
								role="group"
								aria-label={t.autoSchedule}
								className="inline-flex flex-wrap gap-1 rounded-xl p-1"
								style={{
									background: "var(--dsw-hover)",
									border: "0.5px solid var(--dsw-border-l2)",
								}}
							>
								{(
									[
										{ id: "interval", label: t.autoKindInterval },
										{ id: "daily", label: t.autoKindDaily },
										{ id: "weekly", label: t.autoKindWeekly },
										{ id: "cron", label: t.autoKindCron },
									] as const
								).map((opt) => {
									const active = kind === opt.id;
									return (
										<button
											key={opt.id}
											type="button"
											aria-pressed={active}
											onClick={() => setKind(opt.id)}
											className="rounded-lg px-3 py-1.5 transition-all"
											style={{
												fontSize: "var(--dsh-ui-font-125)",
												fontWeight: active ? 500 : 400,
												backgroundColor: active ? "var(--dsw-bg-elevated)" : "transparent",
												color: active ? "var(--dsw-label-primary)" : "var(--dsw-label-secondary)",
												boxShadow: active ? "0 1px 3px rgba(0, 0, 0, 0.14)" : "none",
												border: active ? "0.5px solid var(--dsw-border-l2)" : "0.5px solid transparent",
											}}
										>
											{opt.label}
										</button>
									);
								})}
							</div>

							{kind === "interval" && (
								<div className="flex flex-wrap items-center gap-2.5 pt-0.5">
									<span style={{ fontSize: "var(--dsh-ui-font-sm)", color: "var(--dsw-label-secondary)" }}>{t.autoEvery}</span>
									<input
										type="number"
										min={1}
										max={unit === "minutes" ? 525600 : 8760}
										value={every}
										onChange={(e) => setEvery(Math.max(1, Number(e.target.value) || 1))}
										className="h-8 w-20 rounded-xl px-2.5 text-center tabular-nums"
										style={{ ...fieldStyle, minHeight: "max(32px, calc(32px + var(--dsh-content-font-delta)))", fontWeight: 500 }}
									/>
									<SelectOption
										value={unit}
										label={t.autoSchedule}
										options={[
											{ value: "minutes", label: t.autoUnitMinutes },
											{ value: "hours", label: t.autoUnitHours },
										]}
										onChange={(v) => setUnit(v as "minutes" | "hours")}
										width={120}
									/>
								</div>
							)}

							{(kind === "daily" || kind === "weekly") && (
								<div className="flex flex-col gap-3 pt-0.5">
									{kind === "weekly" && (
										<div className="flex flex-wrap items-center gap-1.5">
											<span className="mr-1" style={{ fontSize: "var(--dsh-ui-font-125)", color: "var(--dsw-label-secondary)" }}>
												{t.autoDays}
											</span>
											{WEEKDAY_ORDER.map((dayIndex) => {
												const active = days.includes(dayIndex);
												return (
													<button
														key={dayIndex}
														type="button"
														aria-label={lang === "zh" ? `周${WEEKDAY_SHORT.zh[dayIndex]}` : lang === "zh-Hant" ? `週${WEEKDAY_SHORT["zh-Hant"][dayIndex]}` : lang === "ja" ? `${WEEKDAY_SHORT.ja[dayIndex]}曜日` : WEEKDAY_SHORT[lang][dayIndex]}
														aria-pressed={active}
														onClick={() => toggleDay(dayIndex)}
														className="min-w-8 rounded-lg px-2.5 py-1.5 text-center transition-colors"
														style={{
															fontSize: "var(--dsh-ui-font-xs)",
															fontWeight: active ? 500 : 400,
															backgroundColor: active ? "var(--dsw-label-primary)" : "var(--dsw-bg-elevated)",
															color: active ? "var(--dsw-bg-base)" : "var(--dsw-label-secondary)",
															border: "0.5px solid var(--dsw-border-l2)",
														}}
													>
														{WEEKDAY_SHORT[lang][dayIndex]}
													</button>
												);
											})}
										</div>
									)}
									<div className="flex items-center gap-2.5">
										<span style={{ fontSize: "var(--dsh-ui-font-125)", color: "var(--dsw-label-secondary)" }}>{t.autoTime}</span>
										<input
											type="time"
											value={time}
											onChange={(e) => setTime(e.target.value)}
											className="h-8 rounded-xl px-3"
											style={{ ...fieldStyle, minHeight: "max(32px, calc(32px + var(--dsh-content-font-delta)))" }}
										/>
									</div>
								</div>
							)}

							{kind === "cron" && (
								<div className="space-y-1.5 pt-0.5">
									<input
										value={cronExpr}
										onChange={(e) => setCronExpr(e.target.value)}
										placeholder={t.autoCronPlaceholder}
										className="h-9 w-full rounded-xl px-3"
										style={{ ...fieldStyle, fontFamily: "var(--font-mono)" }}
									/>
									<div style={{ fontSize: "var(--dsh-ui-font-2xs)", color: "var(--dsw-label-caption)" }}>{t.autoCronHint}</div>
								</div>
							)}

							<div
								className="pt-2.5"
								style={{
									borderTop: "0.5px solid var(--dsw-border-l1)",
									fontSize: "var(--dsh-ui-font-xs)",
									color: schedulePreview.ok ? "var(--dsw-label-tertiary)" : "var(--dsw-danger)",
								}}
							>
								{schedulePreview.ok ? schedulePreview.label : schedulePreview.error}
							</div>
						</div>
					</div>

					<div className="hairline-t flex items-center justify-end gap-2 px-6 py-3.5">
						<button type="button" className="btn-outline" style={{ height: "max(34px, calc(34px + var(--dsh-content-font-delta)))" }} onClick={onClose} disabled={saving}>
							{t.cancel}
						</button>
						<button
							type="submit"
							className="btn-primary-white"
							style={{ height: "max(34px, calc(34px + var(--dsh-content-font-delta)))", padding: "0 16px" }}
							disabled={saving || modelSelectionBlocked || !name.trim() || !prompt.trim() || !cwd.trim() || !validSchedule.ok}
						>
							{t.confirm}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
