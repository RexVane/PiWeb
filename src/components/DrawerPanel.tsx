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
import { ProjectPanel } from "@/components/ProjectPanel";
import { SessionImportSection } from "@/components/SessionImportSection";
import { IconCloseOutline14, IconDownloadOutline16, IconAgentPresetOutline16, IconGitOutline16, IconFolderOpenOutline16 } from "@/components/icons";
import type { GrowthApi } from "@/hooks/useGrowth";
import { useI18n } from "@/i18n";
import type { TreeNode } from "@/lib/growth-tree";

/** 抽屉入口：项目 → 提示词 → Git 详情 → 会话导入（旁聊已独立成右侧面板，不再共用这一列）。 */
export type DrawerSection = "project" | "prompts" | "git" | "import";

export function DrawerPanel({
	cwd,
	section,
	onSectionChange,
	onClose,
	sessionId,
	promptRefreshKey,
	gitRefreshKey,
	growth,
	workspaceName,
	hasSession,
	running,
	onOpenFileNode,
	onReference,
	onOpenEditor,
	onJumpToChat,
	onError,
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
	/** 项目入口用的生长视图状态(AppShell 里 useGrowth 不随抽屉卸载) */
	growth: GrowthApi;
	workspaceName: string;
	hasSession: boolean;
	/** 本会话正在运行:时间轴末尾显示「本轮进行中」 */
	running?: boolean;
	/** 项目树打开文件(打开居中查看器) */
	onOpenFileNode: (node: TreeNode) => void;
	/** 项目树的「引用到输入框」 */
	onReference?: (path: string) => void;
	/** 项目树的「在本机编辑器打开」(相对仓库根的路径) */
	onOpenEditor?: (path: string) => void;
	/** 跳到对话里这一轮的提问(用户消息 entryId) */
	onJumpToChat?: (messageId: string) => void;
	onError: (message: string) => void;
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
		{ id: "project", label: t.projectPanel, icon: <IconFolderOpenOutline16 size={15} /> },
		{ id: "prompts", label: t.drawerPrompts, icon: <IconAgentPresetOutline16 size={15} /> },
		{ id: "git", label: t.gitDetails, icon: <IconGitOutline16 size={15} /> },
		// 「导入会话」的设置栏已移除,文案复用在这里
		{ id: "import", label: t.importSessions, icon: <IconDownloadOutline16 size={15} /> },
	];

	return (
		<div className="flex h-full min-h-0 flex-col" data-testid="drawer-panel">
			{/* 入口列表：横向一排图标，不显示文字（名字放 title / aria-label）。
			    激活态复用设置页那套下划线（.settings-tab-underline），不自创样式。
			    悬停底色交给 CSS（.drawer-tab:hover）：以前用 onMouseEnter/Leave 直接改 style，
			    悬停时点下去这一项变成选中，移开时「选中就不复原」，底色就永远留在上面。 */}
			<div className="hairline-b flex items-stretch gap-1 px-2" role="tablist" aria-label={t.drawerSections}>
				{entries.map((entry) => (
					<button
						key={entry.id}
						type="button"
						role="tab"
						aria-selected={section === entry.id}
						className="settings-tab-underline drawer-tab flex flex-1 items-center justify-center rounded-t-lg"
						data-active={section === entry.id}
						title={entry.label}
						aria-label={entry.label}
						onClick={() => onSectionChange(entry.id)}
						data-testid={`drawer-entry-${entry.id}`}
					>
						{entry.icon}
					</button>
				))}
			</div>

			{/* 所选入口的内容:项目 / 提示词 / Git 三个面板自带标题行与滚动。
			    「导入会话」段落没有标题行,这里补一行,排布照抄 PromptPanel(同样在入口列表下面、关掉整个抽屉) */}
			<div className="flex min-h-0 flex-1 flex-col">
				{section === "import" ? (
					<>
						<div className="hairline-b flex items-center gap-2 px-4 py-2.5">
							<span className="min-w-0 flex-1 truncate" style={{ fontSize: 13.5, fontWeight: 600 }}>
								{t.importSessions}
							</span>
							<button type="button" className="icon-btn" style={{ width: 26, height: 26 }} title={t.close} aria-label={t.close} onClick={onClose}>
								<IconCloseOutline14 size={14} />
							</button>
						</div>
						<div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
							<SessionImportSection cwd={cwd} />
						</div>
					</>
				) : section === "project" ? (
					<ProjectPanel
						growth={growth}
						workspaceName={workspaceName}
						cwd={cwd}
						hasSession={hasSession}
						running={running}
						onOpenFile={onOpenFileNode}
						onReference={onReference}
						onOpenEditor={onOpenEditor}
						onJumpToChat={onJumpToChat}
						gitRefreshKey={gitRefreshKey}
						onAskCommit={onAskCommit}
						// 「Git 详情」按钮切到抽屉的 git 入口(项目栏不再自己开一个面板)
						onOpenGit={() => onSectionChange("git")}
						onClose={onClose}
						onError={onError}
					/>
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