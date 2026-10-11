"use client";

/**
 * 右侧抽屉:顶部一列入口(可点选),下面渲染所选入口的内容。
 *
 * 抽屉是网格里的一列(不是浮层):打开时对话区变窄,和项目栏占用一列的方式一样;
 * 窄屏时由 AppShell 摆成贴右边的 fixed 覆盖层。
 * 这一列与「轨迹详情」(TrajInspector)互斥:点对话里的工具行时整列切成轨迹详情,
 * 关掉后回到抽屉,并回到抽屉原本选中的那个入口——所以选中项由 AppShell 持有,
 * 不能放在本组件的局部 state 里,否则轨迹详情来回切换会丢掉入口。
 */
import { PromptPanel } from "@/components/PromptPanel";
import { GitPanel } from "@/components/GitPanel";
import { SessionImportSection } from "@/components/SessionImportSection";
import { IconCloseOutline14, IconDownloadOutline16, IconAgentPresetOutline16, IconGitOutline16 } from "@/components/icons";
import { useI18n } from "@/i18n";

/** 抽屉里的入口,顺序即顶部入口列表的显示顺序 */
export type DrawerSection = "prompts" | "git" | "import";

export function DrawerPanel({
	cwd,
	section,
	onSectionChange,
	onClose,
	sessionId,
	promptRefreshKey,
	gitRefreshKey,
	onOpenContent,
	onAskCommit,
	onOpenFile,
}: {
	cwd: string;
	/** 当前入口(由 AppShell 持有:轨迹详情关掉后要回到这个入口) */
	section: DrawerSection;
	onSectionChange: (section: DrawerSection) => void;
	onClose: () => void;
	sessionId: string | null;
	/** 提示词面板重新拉取的键(切换会话) */
	promptRefreshKey?: string | number | null;
	/** Git 面板重新拉取的键(回合结束 / pi 改了文件) */
	gitRefreshKey?: number;
	/** 提示词正文交给居中查看器 */
	onOpenContent?: (path: string, content: string) => void;
	/** 把「请提交当前变更」填进输入框 */
	onAskCommit?: () => void;
	/** 在本机编辑器打开(Git 文件) */
	onOpenFile?: (absPath: string) => void;
}) {
	const { t } = useI18n();

	const entries: { id: DrawerSection; label: string; icon: React.ReactNode }[] = [
		// 入口只用现有的 i18n 键;「提示词」是入口短名,和面板标题「提示词来源」区分开
		{ id: "prompts", label: t.drawerPrompts, icon: <IconAgentPresetOutline16 size={15} /> },
		{ id: "git", label: t.gitDetails, icon: <IconGitOutline16 size={15} /> },
		// 「导入会话」的设置栏已移除,文案复用在这里
		{ id: "import", label: t.importSessions, icon: <IconDownloadOutline16 size={15} /> },
	];

	return (
		<div className="flex h-full min-h-0 flex-col" data-testid="drawer-panel">
			{/* 头部:与 PromptPanel / ProjectPanel 同一套排布。
			    提示词 / Git 两个面板自带同款标题行(含关闭),这里就不再叠一层;
			    「导入会话」段落没有标题行,抽屉自己出这行,并关掉整个抽屉。 */}
			{section === "import" && (
				<div className="hairline-b flex items-center gap-1.5 px-3 pb-2 pt-3">
					<span className="min-w-0 flex-1 truncate" style={{ fontSize: 13, fontWeight: 600 }}>
						{t.drawerPanel}
					</span>
					<button className="icon-btn" style={{ width: 22, height: 22 }} title={t.close} aria-label={t.close} onClick={onClose}>
						<IconCloseOutline14 size={13} />
					</button>
				</div>
			)}

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
						onClick={() => onSectionChange(entry.id)}
						data-testid={`drawer-entry-${entry.id}`}
					>
						{section === entry.id ? <span style={{ display: "inline-flex", color: "var(--dsw-accent)" }}>{entry.icon}</span> : entry.icon}
						<span className="min-w-0 flex-1 truncate">{entry.label}</span>
					</button>
				))}
			</div>

			{/* 所选入口的内容:提示词 / Git 自己管滚动与内边距,导入段落沿用抽屉的留白 */}
			<div className="flex min-h-0 flex-1 flex-col">
				{section === "import" ? (
					<div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
						<SessionImportSection cwd={cwd} />
					</div>
				) : section === "prompts" ? (
					// 三个面板的关闭按钮都收起整个抽屉(它们自己不再有"关闭"以外的语义)
					<PromptPanel cwd={cwd} sessionId={sessionId} refreshKey={promptRefreshKey} onOpenContent={onOpenContent} onClose={onClose} />
				) : (
					<GitPanel cwd={cwd} refreshKey={gitRefreshKey} onClose={onClose} onAskCommit={onAskCommit} onOpenFile={onOpenFile} />
				)}
			</div>
		</div>
	);
}