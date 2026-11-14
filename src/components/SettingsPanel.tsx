"use client";

/**
 * 设置弹窗（对齐 dsh SettingsRoot）：居中模态、左导航 + 右侧行式内容。
 * 三节：General / Models / 远程连接。
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { IconCloseOutline14, IconDownloadOutline16, IconModelOutline16, IconSettingsOutline16, IconShieldOutline16 } from "@/components/icons";
import { RemoteSection } from "@/components/RemoteSection";
import { useI18n } from "@/i18n";
import { useDialog } from "@/hooks/useDialog";
import { GeneralSection } from "./settings/GeneralSection";
import { ModelsSection, type ModelConfigurationChange } from "./settings/ModelsSection";

export { SelectOption } from "./settings/SharedControls";

type Section = "general" | "models" | "remote";

export function SettingsPanel({
	open,
	onClose,
	cwd,
	onModelsChanged,
	onApplyCurrentSession,
	currentSessionBusy = false,
	currentSessionKey,
}: {
	open: boolean;
	onClose: () => void;
	onModelsChanged?: () => void | Promise<void>;
	onApplyCurrentSession?: () => Promise<{ success: boolean; error?: string }>;
	currentSessionBusy?: boolean;
	currentSessionKey?: string;
	/** @deprecated Retained only for legacy callers; Skills & Plugins live in top-level views. */
	cwd?: string;
	/** @deprecated */
	onOpenFileContent?: (path: string, content: string) => void;
}) {
	const { t, lang, setLang } = useI18n();
	const [section, setSection] = useState<Section>("general");
	const [modelNotice, setModelNotice] = useState<(ModelConfigurationChange & { error?: string; errorAction?: "catalog" | "apply"; applied?: boolean }) | null>(null);
	const [applyingModels, setApplyingModels] = useState(false);
	const modelChangeGeneration = useRef(0);
	const applyModelsInFlight = useRef(false);
	useEffect(() => {
		modelChangeGeneration.current += 1;
		setModelNotice((previous) => previous && (previous.applied || previous.errorAction === "apply")
			? { ...previous, applied: false, error: previous.errorAction === "apply" ? undefined : previous.error }
			: previous);
	}, [currentSessionKey]);
	const modelsChanged = useCallback(async (change: ModelConfigurationChange) => {
		const generation = ++modelChangeGeneration.current;
		setModelNotice(change);
		try { await onModelsChanged?.(); }
		catch (error) {
			if (modelChangeGeneration.current === generation) setModelNotice({ ...change, errorAction: "catalog", error: error instanceof Error ? error.message : String(error) });
		}
	}, [onModelsChanged]);
	const applyModels = async () => {
		if (!onApplyCurrentSession || currentSessionBusy || applyModelsInFlight.current) return;
		applyModelsInFlight.current = true;
		setApplyingModels(true);
		const generation = ++modelChangeGeneration.current;
		let applied = false;
		try {
			const result = await onApplyCurrentSession();
			if (!result.success) throw new Error(result.error || t.toastError);
			applied = true;
			await onModelsChanged?.();
			if (modelChangeGeneration.current === generation) setModelNotice((previous) => ({ requiresSessionReopen: previous?.requiresSessionReopen ?? false, applied: true }));
		} catch (error) {
			if (modelChangeGeneration.current === generation) setModelNotice((previous) => ({ requiresSessionReopen: previous?.requiresSessionReopen ?? !applied, applied, errorAction: applied ? "catalog" : "apply", error: error instanceof Error ? error.message : String(error) }));
		} finally { applyModelsInFlight.current = false; setApplyingModels(false); }
	};
	const dialogRef = useRef<HTMLDivElement>(null);
	const titleId = useId();
	useDialog({ open, onClose, ref: dialogRef });

	if (!open) return null;

	const navItems: { id: Section; label: string; icon: React.ReactNode }[] = [
		{ id: "general", label: t.setGeneral, icon: <IconSettingsOutline16 size={15} /> },
		{ id: "models", label: t.setModels, icon: <IconModelOutline16 size={15} /> },
		{ id: "remote", label: t.setRemote, icon: <IconShieldOutline16 size={15} /> },
	];

	return (
		<div
			className="modal-mask fixed inset-0 z-[100] flex items-center justify-center"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onClose();
			}}
		>
			<div
				ref={dialogRef}
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				className="settings-dialog glass-modal flex overflow-hidden"
				style={{
					width: 800,
					maxWidth: "calc(100vw - 48px)",
					height: "min(800px, calc(100vh - 48px))",
					borderRadius: "var(--pw-radius-modal)",
					boxShadow: "var(--pw-shadow-modal)",
				}}
			>
				{/* 左导航（Iconsax .isx-menu-item：h42 r8，悬停/激活高对比反转 + 文字右移 + 右侧短竖条） */}
				<div className="settings-nav flex w-52 flex-none flex-col gap-1 py-4 pl-4 pr-3">
					<div id={titleId} className="settings-title px-2 pb-3" style={{ fontSize: 16, fontWeight: 500 }}>
						{t.settings}
					</div>
					{navItems.map((n) => (
						<button
							key={n.id}
							data-active={section === n.id ? "true" : undefined}
							className="isx-menu-item flex h-[42px] items-center gap-2.5 rounded-lg px-3 text-left"
							style={{
								paddingLeft: 10,
								paddingRight: 14,
								fontSize: 14,
								color: section === n.id ? "var(--dsw-bg-base)" : "var(--dsw-label-secondary)",
							}}
							onClick={() => setSection(n.id)}
						>
							<span className="isx-menu-icon" style={{ display: "inline-flex" }}>{n.icon}</span>
							<span className="isx-menu-shift">{n.label}</span>
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
						<button type="button" className="icon-btn" aria-label={t.close} onClick={onClose}>
							<IconCloseOutline14 size={15} />
						</button>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
						{modelNotice && <div role="status" className="mb-4 rounded-xl px-3 py-2" style={{ fontSize: 12.5, background: "rgba(34,197,94,.1)", color: "var(--dsw-success-text)" }}>
							<p>{modelNotice.applied ? lang === "en" ? "The new model configuration is applied to the current chat." : "新模型配置已应用到当前会话。" : modelNotice.requiresSessionReopen
								? lang === "en" ? "Model configuration saved. Apply it to the current chat or reopen the chat to use it." : "模型配置已保存。请应用到当前会话，或重新打开会话后使用。"
								: t.modelConfigReopen}</p>
							{modelNotice.error && <p role="alert" className="mt-1" style={{ color: "var(--dsw-danger)" }}>{modelNotice.errorAction === "catalog"
								? lang === "en" ? "The configuration is saved, but the model catalog could not refresh: " : "配置已保存，但模型目录刷新失败："
								: lang === "en" ? "The configuration is saved, but applying it to the current chat failed: " : "配置已保存，但应用当前会话失败："}{modelNotice.error}</p>}
							{onApplyCurrentSession && <button type="button" className="btn-outline mt-2" style={{ height: 30 }} disabled={currentSessionBusy || applyingModels} onClick={() => void applyModels()}>
								{applyingModels ? lang === "en" ? "Applying…" : "正在应用…" : lang === "en" ? "Apply to current chat" : "应用到当前会话"}
							</button>}
							{currentSessionBusy && <p className="mt-1">{lang === "en" ? "The current chat is answering. You can retry applying after this turn." : "当前会话正在回答，本轮结束后可以重试应用。"}</p>}
						</div>}
						{section === "general" && <GeneralSection lang={lang} setLang={setLang} cwd={cwd} />}
						{section === "models" && <ModelsSection onChanged={modelsChanged} />}
						{section === "remote" && <RemoteSection />}
					</div>
				</div>
			</div>
		</div>
	);
}
