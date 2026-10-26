"use client";

/**
 * 右下角的更新提示条：每次服务启动提醒一次（按启动标识记在 localStorage，刷新、多开标签页不重复）。
 *
 * 只列启动检查时就有新版本的那几项：
 * - 能直接更新的点「更新」，只更新 PiWeb；内置 Pi 随发行版升级；
 * - Windows 上的 npm 安装 PiWeb 不能替换运行中的自己，给命令和复制按钮；
 * - 装好后提示手动重启，进程不自己重启。
 * 状态和设置里的版本行共用（update-store），在哪边点都一样。
 */
import { useEffect, useState } from "react";
import { CopyCommand } from "@/components/update/CopyCommand";
import { loadUpdates, runUpdate, useUpdates, type TargetUpdate, type UpdateTarget } from "@/components/update/update-store";
import { useI18n } from "@/i18n";

/** 已经关掉过的那次启动的标识 */
export const UPDATE_NOTICE_KEY = "piweb.updateNotice";

const LABEL: Record<UpdateTarget, string> = { piweb: "PiWeb", pi: "Pi" };

export function UpdateNotice() {
	const { t } = useI18n();
	const updates = useUpdates();
	/** 读过 localStorage 之后才知道这次启动是否已经关掉过（服务端渲染没有 localStorage） */
	const [dismissed, setDismissed] = useState<string | null | undefined>(undefined);
	/** 启动检查时就有新版本的项：提示条只管这些，之后它们变成更新中 / 已更新 / 失败也留在条里 */
	const [offered, setOffered] = useState<UpdateTarget[] | null>(null);

	useEffect(() => {
		try {
			setDismissed(localStorage.getItem(UPDATE_NOTICE_KEY));
		} catch {
			setDismissed(null);
		}
		void loadUpdates();
	}, []);

	useEffect(() => {
		if (offered === null && updates.loaded) setOffered(updates.targets.piweb.phase === "available" ? ["piweb"] : []);
	}, [offered, updates]);

	if (dismissed === undefined || !offered?.length || !updates.startId || dismissed === updates.startId) return null;
	const startId = updates.startId;
	const items = offered.map((target) => ({ target, ...updates.targets[target] }));
	const updatable = items.filter((item) => !item.command && (item.phase === "available" || item.phase === "error"));
	const updating = items.some((item) => item.phase === "updating");
	const anyUpdated = items.some((item) => item.phase === "updated");
	const dismiss = () => {
		try {
			localStorage.setItem(UPDATE_NOTICE_KEY, startId);
		} catch {
			/* 存不下就只关这一页 */
		}
		setDismissed(startId);
	};
	const updateAll = async () => {
		// 一个一个来：服务端同一时间只允许一个更新；前一个失败（比如有会话在跑）就停下
		for (const item of updatable) {
			if (!(await runUpdate(item.target))) break;
		}
	};
	const title = updating ? t.updateNoticeUpdatingTitle : anyUpdated && !updatable.length ? t.updateNoticeDoneTitle : t.updateNoticeTitle;

	return (
		<div
			role="status"
			className="pointer-events-auto flex flex-col gap-2 rounded-xl px-3 py-2.5"
			style={{ fontSize: 12.5, background: "var(--dsw-glass-popover)", border: "0.5px solid var(--dsw-border-l2)", boxShadow: "var(--dsw-elevation-soft)", borderLeft: "3px solid var(--dsw-accent)" }}
			data-testid="update-notice"
		>
			<span style={{ fontWeight: 600, color: "var(--dsw-label-primary)" }}>{title}</span>
			{items.map((item) => (
				<div key={item.target} className="flex flex-col gap-1">
					<span className="flex items-center gap-1.5" style={{ color: "var(--dsw-label-secondary)" }}>
						<span style={{ color: "var(--dsw-label-primary)" }}>{LABEL[item.target]}</span>
						<ItemStatus item={item} />
					</span>
					{item.command && item.phase === "available" ? (
						<span className="flex flex-col gap-1">
							<span style={{ fontSize: 11.5, color: "var(--dsw-label-tertiary)" }}>{t.updateRunCommandHint}</span>
							<CopyCommand command={item.command} />
						</span>
					) : null}
				</div>
			))}
			{anyUpdated && !updating ? <span style={{ fontSize: 11.5, color: "var(--dsw-label-tertiary)" }}>{t.updateRestartHint}</span> : null}
			{!updating ? (
				<div className="flex justify-end gap-2">
					<button type="button" className="btn-outline" style={{ height: 26, padding: "0 12px", fontSize: 12 }} onClick={dismiss}>
						{anyUpdated || !updatable.length ? t.updateNoticeOk : t.updateNoticeLater}
					</button>
					{updatable.length ? (
						<button type="button" className="btn-primary-white" style={{ height: 26, padding: "0 12px", fontSize: 12 }} onClick={() => void updateAll()}>
							{t.updateNoticeUpdate}
						</button>
					) : null}
				</div>
			) : null}
		</div>
	);
}

function ItemStatus({ item }: { item: TargetUpdate }) {
	const { t } = useI18n();
	if (item.phase === "updating") {
		return (
			<span className="flex items-center gap-1.5" style={{ color: "var(--dsw-label-tertiary)" }}>
				<span className="h-3 w-3 flex-none animate-spin rounded-full border-2 border-current border-t-transparent" />
				{t.updatingNow}
			</span>
		);
	}
	if (item.phase === "updated") return <span style={{ color: "var(--dsw-success)" }}>{t.updateNoticeUpdated.replace("{v}", item.latest)}</span>;
	if (item.phase === "error") {
		// npm / 构建的报错可能很长：只露三行，完整内容放在悬停提示里
		return (
			<span className="line-clamp-3 min-w-0 break-all" style={{ color: "var(--dsw-danger)" }} title={item.error}>
				{item.busy ? t.updateBusy : `${t.updateFailed}: ${item.error}`}
			</span>
		);
	}
	return <span>{versionChange(item, t.updateCommits)}</span>;
}

/** 「0.3.18 → 0.3.20」；Git 检出版本号没变、只有新提交时写提交数 */
export function versionChange(item: Pick<TargetUpdate, "current" | "latest" | "behind">, commitsText: string): string {
	if (item.latest === item.current && item.behind > 0) return commitsText.replace("{n}", String(item.behind));
	return `${item.current} → ${item.latest}`;
}
