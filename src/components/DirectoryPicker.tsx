"use client";

/**
 * 应用内目录浏览器：给手机等远程设备用。
 *
 * 本机回环上仍然走系统原生对话框（/api/workspaces 的 pick 动作），只有远程请求才落到这里
 * —— 原生对话框会弹在运行 PiWeb 的那台机器的屏幕上，手机这边等于没反应。
 * 只列目录；选出的路径仍由服务端的 resolveWorkspacePath 校验后才写进工作区。
 */
import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { folderIconSrc } from "@/lib/file-icons";
import { IconChevronLeft14 } from "@/components/icons";
import { useI18n } from "@/i18n";

interface FsEntry {
	name: string;
	path: string;
}

interface Listing {
	path: string;
	parent: string | null;
	entries: FsEntry[];
	truncated: boolean;
}

async function post(action: "roots" | "list", target?: string): Promise<Record<string, unknown>> {
	const r = await fetch("/api/fs", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(target === undefined ? { action } : { action, path: target }),
	});
	const j = (await r.json()) as { success?: boolean; data?: Record<string, unknown>; error?: string };
	if (!r.ok || !j.success) throw new Error(j.error || `request failed (${r.status})`);
	return j.data ?? {};
}

export function DirectoryPicker({
	open,
	onConfirm,
	onCancel,
}: {
	open: boolean;
	onConfirm: (path: string) => void;
	onCancel: () => void;
}) {
	const { t } = useI18n();
	const [roots, setRoots] = useState<FsEntry[]>([]);
	const [listing, setListing] = useState<Listing | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const load = useCallback(async (target?: string) => {
		setBusy(true);
		setError(null);
		try {
			setListing((await post("list", target)) as unknown as Listing);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(false);
		}
	}, []);

	useEffect(() => {
		if (!open) return;
		setListing(null);
		setError(null);
		setRoots([]);
		void (async () => {
			try {
				const data = await post("roots");
				setRoots((data.roots as FsEntry[]) ?? []);
			} catch {
				// 拿不到起点不影响从主目录开始
			}
			await load();
		})();
	}, [open, load]);

	if (!open) return null;

	const rowStyle: CSSProperties = { fontSize: 13, color: "var(--dsw-label-secondary)" };
	return (
		<div
			className="modal-mask fixed inset-0 z-[100] flex items-center justify-center"
			onMouseDown={(e) => {
				if (e.target === e.currentTarget) onCancel();
			}}
		>
			<div
				className="glass-modal flex flex-col overflow-hidden"
				style={{
					width: 560,
					maxWidth: "calc(100vw - 32px)",
					height: "min(620px, calc(100vh - 32px))",
					borderRadius: 24,
					boxShadow: "var(--dsw-elevation-prominent)",
				}}
			>
				<div className="px-5 pb-2 pt-4" style={{ fontSize: 15, fontWeight: 500 }}>
					{t.pickFolderTitle}
				</div>

				{roots.length > 0 && (
					<div className="flex flex-wrap gap-1.5 px-5 pb-2">
						{roots.map((root) => (
							<button key={root.path} type="button" className="pw-chip" title={root.path} onClick={() => void load(root.path)}>
								{root.name}
							</button>
						))}
					</div>
				)}

				<div className="flex items-center gap-1.5 px-5 pb-2">
					<button
						type="button"
						className="icon-btn"
						style={{ width: 24, height: 24, flex: "none" }}
						disabled={!listing?.parent || busy}
						title={t.pickFolderUp}
						aria-label={t.pickFolderUp}
						onClick={() => listing?.parent && void load(listing.parent)}
					>
						<IconChevronLeft14 size={13} />
					</button>
					<span
						className="truncate"
						style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--dsw-label-caption)" }}
						title={listing?.path}
					>
						{listing?.path ?? t.pickFolderLoading}
					</span>
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto px-3">
					{error && <p className="px-2 py-2" style={{ fontSize: 13, color: "var(--dsw-danger)" }}>{error}</p>}
					{listing?.entries.map((entry) => (
						<button
							key={entry.path}
							type="button"
							className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors"
							style={rowStyle}
							onMouseEnter={(e) => { e.currentTarget.style.background = "var(--dsw-hover)"; }}
							onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; }}
							onClick={() => void load(entry.path)}
						>
							<img src={folderIconSrc(entry.name, false)} alt="" width={15} height={15} style={{ flex: "none" }} draggable={false} />
							<span className="truncate">{entry.name}</span>
						</button>
					))}
					{!error && listing && listing.entries.length === 0 && (
						<p className="px-2 py-2" style={{ fontSize: 13, color: "var(--dsw-label-caption)" }}>{t.pickFolderEmpty}</p>
					)}
					{listing?.truncated && (
						<p className="px-2 py-2" style={{ fontSize: 12, color: "var(--dsw-label-caption)" }}>
							{t.pickFolderTruncated.replace("{n}", String(listing.entries.length))}
						</p>
					)}
				</div>

				<div className="flex items-center justify-end gap-2 px-5 py-3.5">
					<button
						type="button"
						className="rounded-xl px-3.5 py-1.5 transition-colors"
						style={{ fontSize: 13, color: "var(--dsw-label-secondary)", background: "var(--dsw-hover)" }}
						onClick={onCancel}
					>
						{t.cancel}
					</button>
					<button
						type="button"
						className="rounded-xl px-3.5 py-1.5 transition-colors"
						style={{
							fontSize: 13,
							color: "white",
							background: "var(--dsw-accent)",
							opacity: !listing || busy ? 0.5 : 1,
						}}
						disabled={!listing || busy}
						onClick={() => listing && onConfirm(listing.path)}
					>
						{t.pickFolderConfirm}
					</button>
				</div>
			</div>
		</div>
	);
}
