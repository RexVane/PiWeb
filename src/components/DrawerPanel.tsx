"use client";

/**
 * 右侧抽屉:顶部一列入口(可点选),下面渲染所选入口的内容。
 *
 * 抽屉是网格里的一列(不是浮层):打开时对话区变窄,和项目栏占用一列的方式一样;
 * 窄屏时由 AppShell 摆成贴右边的 fixed 覆盖层。
 * 本步只有「会话导入」一个入口,后面再补 项目 / 提示词 / Git 详情。
 */
import { useState } from "react";
import { SessionImportSection } from "@/components/SessionImportSection";
import { IconCloseOutline14, IconDownloadOutline16 } from "@/components/icons";
import { useI18n } from "@/i18n";

type DrawerSection = "import";

export function DrawerPanel({ cwd, onClose }: { cwd: string; onClose: () => void }) {
	const { t } = useI18n();
	const [section, setSection] = useState<DrawerSection>("import");

	const entries: { id: DrawerSection; label: string; icon: React.ReactNode }[] = [
		// 入口只用现有的 i18n 键:「导入会话」的设置栏已移除,文案复用在这里
		{ id: "import", label: t.importSessions, icon: <IconDownloadOutline16 size={15} /> },
	];

	return (
		<div className="flex h-full min-h-0 flex-col" data-testid="drawer-panel">
			{/* 头部:与 PromptPanel / ProjectPanel 同一套排布 */}
			<div className="hairline-b flex items-center gap-1.5 px-3 pb-2 pt-3">
				<span className="min-w-0 flex-1 truncate" style={{ fontSize: 13, fontWeight: 600 }}>
					{t.drawerPanel}
				</span>
				<button className="icon-btn" style={{ width: 22, height: 22 }} title={t.close} aria-label={t.close} onClick={onClose}>
					<IconCloseOutline14 size={13} />
				</button>
			</div>

			{/* 入口列表:激活态用 --dsw-active,与设置左导航同一套写法 */}
			<div className="flex flex-col gap-0.5 px-2 pb-1 pt-2" aria-label={t.drawerSections}>
				{entries.map((entry) => (
					<button
						key={entry.id}
						type="button"
						className="flex h-8 items-center gap-2 rounded-lg px-2.5 text-left transition-colors"
						style={{
							fontSize: 13,
							background: section === entry.id ? "var(--dsw-active)" : "transparent",
							color: section === entry.id ? "var(--dsw-label-primary)" : "var(--dsw-label-secondary)",
						}}
						onMouseEnter={(e) => {
							if (section !== entry.id) e.currentTarget.style.background = "var(--dsw-hover)";
						}}
						onMouseLeave={(e) => {
							if (section !== entry.id) e.currentTarget.style.background = "transparent";
						}}
						onClick={() => setSection(entry.id)}
						data-testid={`drawer-entry-${entry.id}`}
					>
						{section === entry.id ? <span style={{ display: "inline-flex", color: "var(--dsw-accent)" }}>{entry.icon}</span> : entry.icon}
						<span className="min-w-0 flex-1 truncate">{entry.label}</span>
					</button>
				))}
			</div>

			{/* 所选入口的内容 */}
			<div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
				{section === "import" && <SessionImportSection cwd={cwd} />}
			</div>
		</div>
	);
}