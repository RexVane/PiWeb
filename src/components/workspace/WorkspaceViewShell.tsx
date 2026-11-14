"use client";

import type { ReactNode } from "react";
import { SelectOption } from "@/components/settings/SharedControls";
import { useI18n } from "@/i18n";

export interface WorkspaceOption {
	value: string;
	label: string;
}

/**
 * Shared layout shell for main-pane workspace pages (Skills, Plugins, Automations).
 * Keeps header hierarchy, optional workspace selector, and scrollable body uniform.
 */
export function WorkspaceViewShell({
	title,
	description,
	icon,
	cwd,
	onCwdChange,
	workspaceOptions,
	actions,
	children,
}: {
	title: string;
	description: string;
	icon: ReactNode;
	cwd?: string;
	onCwdChange?: (cwd: string) => void;
	workspaceOptions?: WorkspaceOption[];
	actions?: ReactNode;
	children: ReactNode;
}) {
	const { t } = useI18n();

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="hairline-b shrink-0 px-6 py-5">
				<div className="mx-auto flex w-full max-w-4xl flex-wrap items-start justify-between gap-4">
					<div className="min-w-0 flex-1">
						<div className="flex items-center gap-2.5">
							<span
								className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg"
								style={{
									background: "var(--dsw-hover)",
									border: "0.5px solid var(--dsw-border-l2)",
									color: "var(--dsw-label-primary)",
								}}
							>
								{icon}
							</span>
							<h1 style={{ fontSize: 20, fontWeight: 600, color: "var(--dsw-label-primary)" }}>{title}</h1>
						</div>
						<p className="mt-1.5" style={{ fontSize: 13, color: "var(--dsw-label-tertiary)" }}>
							{description}
						</p>
					</div>

					<div className="flex flex-wrap items-center gap-2.5">
						{workspaceOptions && workspaceOptions.length > 0 && cwd !== undefined && onCwdChange && (
							<div className="flex items-center gap-2">
								<span style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>{t.workspaceScope}</span>
								<SelectOption
									value={cwd}
									label={t.workspaceScope}
									options={workspaceOptions}
									onChange={onCwdChange}
									width={180}
								/>
							</div>
						)}
						{actions}
					</div>
				</div>
			</header>

			<div className="min-h-0 flex-1 overflow-y-auto px-6 py-6">
				<div className="mx-auto w-full max-w-4xl">{children}</div>
			</div>
		</div>
	);
}
