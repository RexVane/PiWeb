"use client";

import { useEffect, useMemo, useState } from "react";
import { IconPluginOutline16, IconRefreshOutline14, IconSkillOutline16 } from "@/components/icons";
import { PluginsSection } from "@/components/settings/PluginsSection";
import { SkillsSection } from "@/components/settings/SkillsSection";
import { useI18n } from "@/i18n";
import { WorkspaceViewShell } from "./WorkspaceViewShell";

function useScopedWorkspace(knownCwds: string[], defaultCwd: string, getWorkspaceName: (cwd: string) => string) {
	const [selectedCwd, setSelectedCwd] = useState(defaultCwd || knownCwds[0] || "");

	useEffect(() => {
		if (!selectedCwd && (defaultCwd || knownCwds[0])) {
			setSelectedCwd(defaultCwd || knownCwds[0] || "");
		}
	}, [selectedCwd, defaultCwd, knownCwds]);

	const workspaceOptions = useMemo(
		() => knownCwds.map((c) => ({ value: c, label: getWorkspaceName(c) || c })),
		[knownCwds, getWorkspaceName],
	);

	const activeCwd = selectedCwd || defaultCwd || knownCwds[0] || "";
	return { activeCwd, setSelectedCwd, workspaceOptions };
}

export function SkillsWorkspaceView({
	knownCwds,
	defaultCwd,
	getWorkspaceName,
	onOpenFileContent,
}: {
	knownCwds: string[];
	defaultCwd: string;
	getWorkspaceName: (cwd: string) => string;
	onOpenFileContent?: (path: string, content: string) => void;
}) {
	const { t } = useI18n();
	const { activeCwd, setSelectedCwd, workspaceOptions } = useScopedWorkspace(knownCwds, defaultCwd, getWorkspaceName);
	const [reloadSeq, setReloadSeq] = useState(0);

	return (
		<WorkspaceViewShell
			title={t.navSkills}
			description={t.skillsDesc}
			icon={<IconSkillOutline16 size={16} />}
			actions={
				<button
					type="button"
					className="btn-outline"
					style={{ height: 32, padding: "0 12px", fontSize: 13 }}
					onClick={() => setReloadSeq((n) => n + 1)}
				>
					<IconRefreshOutline14 size={13} /> {t.panelRefresh}
				</button>
			}
		>
			<SkillsSection
				cwd={activeCwd}
				onOpenFileContent={onOpenFileContent}
				hideDesc
				reloadSeq={reloadSeq}
				workspaceOptions={workspaceOptions}
				onCwdChange={setSelectedCwd}
			/>
		</WorkspaceViewShell>
	);
}

export function PluginsWorkspaceView({
	knownCwds,
	defaultCwd,
	getWorkspaceName,
}: {
	knownCwds: string[];
	defaultCwd: string;
	getWorkspaceName: (cwd: string) => string;
}) {
	const { t } = useI18n();
	const { activeCwd, setSelectedCwd, workspaceOptions } = useScopedWorkspace(knownCwds, defaultCwd, getWorkspaceName);
	const [reloadSeq, setReloadSeq] = useState(0);
	const [reloadBusy, setReloadBusy] = useState(false);

	return (
		<WorkspaceViewShell
			title={t.navPlugins}
			description={t.pluginPageDesc}
			icon={<IconPluginOutline16 size={16} />}
			actions={
				<button
					type="button"
					className="btn-outline"
					style={{ height: 32, padding: "0 12px", fontSize: 13 }}
					disabled={reloadBusy}
					onClick={() => setReloadSeq((n) => n + 1)}
				>
					<IconRefreshOutline14 size={13} /> {t.panelRefresh}
				</button>
			}
		>
			<PluginsSection
				cwd={activeCwd}
				hideHeader
				reloadSeq={reloadSeq}
				onReloadBusyChange={setReloadBusy}
				workspaceOptions={workspaceOptions}
				onCwdChange={setSelectedCwd}
			/>
		</WorkspaceViewShell>
	);
}
