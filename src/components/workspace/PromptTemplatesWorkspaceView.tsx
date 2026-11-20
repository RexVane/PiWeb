"use client";

import { useMemo, useState } from "react";
import { useI18n } from "@/i18n";
import { IconFileOutline16, IconRefreshOutline14 } from "@/components/icons";
import { PromptTemplatesSection } from "@/components/settings/PromptTemplatesSection";
import { WorkspaceViewShell } from "./WorkspaceViewShell";

export function PromptTemplatesWorkspaceView({ knownCwds, defaultCwd, getWorkspaceName, onOpenFileContent }: {
	knownCwds: string[];
	defaultCwd: string;
	getWorkspaceName: (cwd: string) => string;
	onOpenFileContent?: (path: string, content: string, sourceCwd: string) => void;
}) {
	const { t } = useI18n();
	const [selectedCwd, setSelectedCwd] = useState("");
	const [reloadSeq, setReloadSeq] = useState(0);
	const cwd = selectedCwd || defaultCwd || knownCwds[0] || "";
	const workspaceOptions = useMemo(() => knownCwds.map((value) => ({ value, label: getWorkspaceName(value) || value })), [knownCwds, getWorkspaceName]);
	return <WorkspaceViewShell title={t.navPromptTemplates} description={t.promptTemplatesDesc} icon={<IconFileOutline16 size={16} />}
		actions={<button type="button" className="btn-outline" style={{ height: 32, padding: "0 12px", fontSize: 13 }} onClick={() => setReloadSeq((value) => value + 1)}><IconRefreshOutline14 size={13} />{t.panelRefresh}</button>}>
		<PromptTemplatesSection cwd={cwd} workspaceOptions={workspaceOptions} onCwdChange={setSelectedCwd} reloadSeq={reloadSeq} onOpenFileContent={onOpenFileContent} />
	</WorkspaceViewShell>;
}
