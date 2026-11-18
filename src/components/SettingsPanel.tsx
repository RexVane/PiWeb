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
import { ModelsSection } from "./settings/ModelsSection";

export { SelectOption } from "./settings/SharedControls";

type Section = "general" | "models" | "remote";

export function SettingsPanel({
	open,
	onClose,
	onModelsChanged,
}: {
	open: boolean;
	onClose: () => void;
	onModelsChanged?: () => void | Promise<void>;
}) {
	const { t, lang, setLang } = useI18n();
	const [section, setSection] = useState<Section>("general");
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const modelChangeGeneration = useRef(0);
	const modelsChanged = useCallback(async () => {
		const generation = ++modelChangeGeneration.current;
		setCatalogError(null);
		try {
			await onModelsChanged?.();
		} catch (error) {
			if (modelChangeGeneration.current === generation) {
				setCatalogError(error instanceof Error ? error.message : String(error));
			}
		}
	}, [onModelsChanged]);
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
					<div id={titleId} className="settings-title px-2 pb-3" style={{ fontSize: "calc(16px + var(--dsh-content-font-delta))", fontWeight: 500 }}>
						{t.settings}
					</div>
					{navItems.map((n) => (
						<button
							key={n.id}
							data-active={section === n.id ? "true" : undefined}
							className="isx-menu-item flex min-h-[42px] items-center gap-2.5 rounded-lg px-3 text-left"
							style={{
								paddingLeft: 10,
								paddingRight: 14,
								fontSize: "var(--dsh-content-font-size)",
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
						<button className="btn-outline" style={{ height: "max(32px, calc(32px + var(--dsh-content-font-delta)))", fontSize: "var(--dsh-ui-font-sm)" }} onClick={() => window.open("/api/config", "_blank")}>
							<IconDownloadOutline16 size={14} /> {t.openConfigFile}
						</button>
						<button type="button" className="icon-btn" aria-label={t.close} onClick={onClose}>
							<IconCloseOutline14 size={15} />
						</button>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
						{catalogError && (
							<p role="alert" className="mb-4 rounded-xl px-3 py-2" style={{ fontSize: "var(--dsh-ui-font-125)", background: "rgba(236,19,19,.1)", color: "var(--dsw-danger)" }}>
								{lang === "en" ? "The configuration is saved, but the model catalog could not refresh: " : "配置已保存，但模型目录刷新失败："}
								{catalogError}
							</p>
						)}
						{section === "general" && <GeneralSection lang={lang} setLang={setLang} />}
						{section === "models" && <ModelsSection onChanged={modelsChanged} />}
						{section === "remote" && <RemoteSection />}
					</div>
				</div>
			</div>
		</div>
	);
}
