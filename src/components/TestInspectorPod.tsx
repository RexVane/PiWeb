"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { TestRunResult } from "@/lib/test-run-service";
import { highlightLine, languageForPath, extOf } from "@/lib/highlight";
import {
	IconCheckOutline14,
	IconCloseOutline14,
	IconFolderOpenOutline16,
	IconRefreshOutline14,
} from "@/components/icons";

type Selection = { cwd: string; file: string };
type Catalog = { cwd: string; files: string[] };
type Source = Selection & { content: string };
type RunRecord = Selection & { result: TestRunResult };
type RunFailure = Selection & { message: string };

function duration(ms: number): string {
	return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

export function TestInspectorPod({
	cwd,
	onClose,
	onSwitchToWorkbench,
	onSwitchToDiff,
}: {
	cwd: string;
	onClose?: () => void;
	onSwitchToWorkbench?: () => void;
	onSwitchToDiff?: () => void;
}) {
	const [catalog, setCatalog] = useState<Catalog | null>(null);
	const [selection, setSelection] = useState<Selection | null>(null);
	const [source, setSource] = useState<Source | null>(null);
	const [listError, setListError] = useState("");
	const [sourceError, setSourceError] = useState("");
	const [loadingFiles, setLoadingFiles] = useState(false);
	const [loadingSource, setLoadingSource] = useState(false);
	const [refreshKey, setRefreshKey] = useState(0);
	const [tab, setTab] = useState<"content" | "results">("content");
	const [pendingRun, setPendingRun] = useState<Selection | null>(null);
	const [runRecord, setRunRecord] = useState<RunRecord | null>(null);
	const [runFailure, setRunFailure] = useState<RunFailure | null>(null);
	const runInFlight = useRef(false);

	const files = catalog?.cwd === cwd ? catalog.files : [];
	const file = selection?.cwd === cwd && files.includes(selection.file) ? selection.file : "";
	const visibleSource = source?.cwd === cwd && source.file === file ? source.content : null;
	const visibleRun = runRecord?.cwd === cwd && runRecord.file === file ? runRecord.result : null;
	const visibleRunError = runFailure?.cwd === cwd && runFailure.file === file ? runFailure.message : "";
	const isRunning = pendingRun !== null;

	useEffect(() => {
		const controller = new AbortController();
		setCatalog(null);
		setSource(null);
		setListError("");
		if (!cwd) return () => controller.abort();
		setLoadingFiles(true);
		void (async () => {
			try {
				const response = await fetch(`/api/tests?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal });
				const body = await response.json();
				if (!response.ok || !body.success) throw new Error(body.error || "读取测试文件失败");
				if (controller.signal.aborted) return;
				const nextFiles = body.data.files as string[];
				setCatalog({ cwd, files: nextFiles });
				setSelection((previous) =>
					previous?.cwd === cwd && nextFiles.includes(previous.file)
						? previous
						: nextFiles.length
						? { cwd, file: nextFiles[0] }
						: null,
				);
			} catch (error) {
				if (!controller.signal.aborted) setListError(error instanceof Error ? error.message : "读取测试文件失败");
			} finally {
				if (!controller.signal.aborted) setLoadingFiles(false);
			}
		})();
		return () => controller.abort();
	}, [cwd, refreshKey]);

	useEffect(() => {
		const controller = new AbortController();
		setSource(null);
		setSourceError("");
		if (!cwd || !file) return () => controller.abort();
		setLoadingSource(true);
		void (async () => {
			try {
				const response = await fetch(
					`/api/tests?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(file)}`,
					{ signal: controller.signal },
				);
				const body = await response.json();
				if (!response.ok || !body.success) throw new Error(body.error || "读取测试内容失败");
				if (!controller.signal.aborted) setSource({ cwd, file, content: body.data.content });
			} catch (error) {
				if (!controller.signal.aborted) setSourceError(error instanceof Error ? error.message : "读取测试内容失败");
			} finally {
				if (!controller.signal.aborted) setLoadingSource(false);
			}
		})();
		return () => controller.abort();
	}, [cwd, file]);

	async function runSelectedFile() {
		if (!cwd || !file || runInFlight.current) return;
		runInFlight.current = true;
		const target = { cwd, file };
		setPendingRun(target);
		setRunRecord(null);
		setRunFailure(null);
		setTab("results");
		try {
			const response = await fetch("/api/tests", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(target),
			});
			const body = await response.json();
			if (!response.ok || !body.success) throw new Error(body.error || "测试执行失败");
			setRunRecord({ ...target, result: body.data as TestRunResult });
		} catch (error) {
			setRunFailure({ ...target, message: error instanceof Error ? error.message : "测试执行失败" });
		} finally {
			runInFlight.current = false;
			setPendingRun(null);
		}
	}

	const sourceLines = visibleSource !== null ? visibleSource.split("\n") : [];
	const sourceBytes = visibleSource ? `${(visibleSource.length / 1024).toFixed(1)} KB` : "0 KB";

	const fileLang = languageForPath(file) || "typescript";
	const highlightedLines = useMemo(() => {
		return sourceLines.map((line) => {
			if (!line.trim()) return null;
			return highlightLine(line, fileLang);
		});
	}, [sourceLines, fileLang]);

	return (
		<div className="mx-auto flex w-full max-w-7xl flex-col gap-4 text-slate-800 dark:text-slate-100 antialiased">
			{/* Top Breadcrumb & Live Test Status Bar (Screen 3) */}
			<div className="clay-card flex flex-wrap items-center justify-between gap-3 rounded-2xl p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm">
				<div className="flex min-w-0 flex-wrap items-center gap-2.5">
					<div className="clay-inset flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-bold text-slate-800 dark:text-slate-100">
						<span className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
						<span>测试执行套件</span>
						<span className="rounded-full bg-emerald-100 dark:bg-emerald-950/70 px-2 py-0.5 text-[10px] font-bold text-emerald-800 dark:text-emerald-200 border border-emerald-300 dark:border-emerald-700">
							工作区 Vitest
						</span>
					</div>

					<div className="clay-btn-soft flex items-center gap-1.5 rounded-full px-3 py-1 font-mono text-xs text-slate-800 dark:text-slate-200 max-w-xs truncate" title={file || cwd}>
						<IconFolderOpenOutline16 size={13} className="text-amber-500 flex-none" />
						<span className="text-slate-500 dark:text-slate-400 font-semibold">tests/</span>
						<span className="font-bold text-slate-900 dark:text-slate-100 truncate">{file ? file.replace(/^tests\//, "") : "未选定"}</span>
					</div>

					{visibleRun ? (
						<div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border ${visibleRun.success ? "bg-emerald-50 text-emerald-800 border-emerald-300 dark:bg-emerald-950/50 dark:text-emerald-200 dark:border-emerald-800" : "bg-rose-50 text-rose-800 border-rose-300 dark:bg-rose-950/50 dark:text-rose-200 dark:border-rose-800"}`}>
							<span className={`w-2 h-2 rounded-full ${visibleRun.success ? "bg-emerald-500 animate-pulse" : "bg-rose-500"}`} />
							<span>{visibleRun.success ? `全部用例就绪 (${visibleRun.passed}/${visibleRun.tests.length} 通过)` : `${visibleRun.failed} 项用例未通过`}</span>
						</div>
					) : isRunning ? (
						<div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-50 text-amber-800 border border-amber-300 dark:bg-amber-950/50 dark:text-amber-200 dark:border-amber-800 text-xs font-bold">
							<span className="w-2 h-2 rounded-full bg-amber-500 animate-spin" />
							<span>测试执行中...</span>
						</div>
					) : (
						<div className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-sky-50 text-sky-800 border border-sky-300 dark:bg-sky-950/50 dark:text-sky-200 dark:border-sky-800 text-xs font-bold">
							<span className="w-2 h-2 rounded-full bg-sky-500" />
							<span>用例就绪待跑 ({files.length} 个文件)</span>
						</div>
					)}
				</div>

				{/* Quick Meta Chips & Actions */}
				<div className="flex items-center gap-2">
					{visibleRun && (
						<div className="clay-inset flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-mono text-slate-600 dark:text-slate-300 font-semibold">
							<span>耗时:</span>
							<strong className="text-slate-900 dark:text-slate-100">{duration(visibleRun.durationMs)}</strong>
						</div>
					)}
					<div className="clay-inset flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-mono text-slate-600 dark:text-slate-300 font-semibold">
						<span>堆内存:</span>
						<strong className="text-slate-900 dark:text-slate-100">未采集</strong>
					</div>
					<button
						type="button"
						className="w-8 h-8 rounded-full clay-btn-soft flex items-center justify-center text-slate-600 hover:text-slate-950 dark:text-slate-300 dark:hover:text-white transition-colors"
						title="刷新文件"
						onClick={() => setRefreshKey((key) => key + 1)}
						disabled={!cwd || loadingFiles}
					>
						<IconRefreshOutline14 size={14} className={loadingFiles ? "piweb-spin" : undefined} />
					</button>
					{onClose && (
						<button
							type="button"
							className="w-8 h-8 rounded-full clay-btn-soft flex items-center justify-center text-slate-600 hover:text-rose-600 dark:text-slate-300 transition-colors"
							title="关闭"
							onClick={onClose}
						>
							<IconCloseOutline14 size={14} />
						</button>
					)}
				</div>
			</div>

			{!cwd && (
				<div className="clay-inset rounded-2xl p-6 text-sm text-slate-600 dark:text-slate-300 font-medium text-center">
					请先在工作台选择工作区，再查看或运行测试。
				</div>
			)}

			{listError && (
				<div role="alert" className="rounded-2xl bg-rose-50 p-4 text-sm text-rose-800 dark:bg-rose-950/40 dark:text-rose-300 font-semibold shadow-sm border border-rose-300 dark:border-rose-800">
					{listError}
				</div>
			)}

			{cwd && (
				<div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-12 min-w-0">
					{/* Left Spec Navigation Pod (3 Cols on XL) */}
					<div className="xl:col-span-3 min-w-0 flex flex-col gap-4">
						{/* Test Target Details Card */}
						<div className="clay-card rounded-2xl p-4 flex flex-col gap-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm">
							<div className="flex items-center justify-between pb-2 border-b border-slate-200 dark:border-slate-800">
								<div className="flex items-center gap-2 font-bold text-sm text-slate-900 dark:text-slate-100">
									<span className="w-2.5 h-2.5 rounded-full bg-indigo-500" />
									<span>测试用例组</span>
								</div>
								<span className="px-2 py-0.5 rounded-full bg-sky-100 dark:bg-sky-950/60 text-sky-800 dark:text-sky-300 text-[10px] font-bold border border-sky-300 dark:border-sky-800">
									Vitest Runner
								</span>
							</div>

							{/* Suite List Items */}
							<div className="flex flex-col gap-2 pt-1 max-h-[28vh] overflow-y-auto pr-1">
								{visibleRun?.tests?.length ? (
									visibleRun.tests.map((test, idx) => (
										<div key={`${test.name}:${idx}`} className="p-2.5 rounded-xl clay-card bg-surface flex flex-col gap-1 border border-slate-200 dark:border-slate-800">
											<div className="flex items-center justify-between gap-1">
												<span className="font-bold text-xs text-slate-900 dark:text-slate-100 flex items-center gap-1.5 truncate">
													<IconCheckOutline14 size={13} className={test.status === "passed" ? "text-emerald-500 flex-none" : "text-rose-500 flex-none"} />
												<span className="truncate" title={test.name}>执行单元 #{idx + 1}</span>
												</span>
												<span className="font-mono text-[10px] text-slate-500 dark:text-slate-400 font-semibold flex-none">{duration(test.durationMs)}</span>
											</div>
											<p className="text-[11px] text-slate-600 dark:text-slate-400 font-mono">{test.status.toUpperCase()} · 工作区进程</p>
										</div>
									))
								) : (
									<div className="clay-inset p-3.5 rounded-xl text-center text-xs text-slate-600 dark:text-slate-300 font-medium leading-relaxed">
										点击「运行当前文件」后，此处将按用例粒度展示真实状态与耗时。
									</div>
								)}
							</div>

							<div className="pt-2 flex items-center justify-between text-slate-600 dark:text-slate-300 text-xs font-semibold border-t border-slate-200 dark:border-slate-800">
								<span>覆盖率：未采集</span>
							</div>
						</div>

						{/* Test Files List Card */}
						<div className="clay-card rounded-2xl p-4 flex flex-col gap-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm">
							<div className="flex items-center justify-between pb-2 border-b border-slate-200 dark:border-slate-800 text-sm font-bold text-slate-900 dark:text-slate-100">
								<span>测试文件</span>
								<span className="font-mono text-xs font-semibold text-slate-600 dark:text-slate-400">{files.length} 个文件</span>
							</div>
							{loadingFiles && <p className="text-xs text-slate-500 dark:text-slate-400 font-medium">正在读取测试文件...</p>}
							{!loadingFiles && !listError && files.length === 0 && (
								<p className="text-xs text-slate-500 dark:text-slate-400 font-medium">此工作区没有测试文件。</p>
							)}
							<div className="max-h-[38vh] space-y-1.5 overflow-y-auto pr-1">
								{files.map((item) => (
									<button
										key={item}
										type="button"
										title={item}
										className={`w-full break-all rounded-xl px-3 py-2 text-left font-mono text-xs transition-all ${
											file === item
												? "clay-card bg-emerald-50 dark:bg-emerald-950/60 font-bold text-emerald-800 dark:text-emerald-200 shadow-sm border border-emerald-300 dark:border-emerald-700"
												: "text-slate-700 hover:text-slate-950 dark:text-slate-200 dark:hover:text-white font-medium hover:bg-slate-100 dark:hover:bg-slate-800/80"
										}`}
										onClick={() => setSelection({ cwd, file: item })}
									>
										{item}
									</button>
								))}
							</div>
						</div>
					</div>

					{/* Center & Right: Floating Claymorphism Inspector Window (9 Cols on XL) */}
					<div className="xl:col-span-9 min-w-0 flex flex-col gap-4">
						{/* Clay Extruded Window Shell */}
						<div className="w-full clay-card rounded-2xl p-4 flex flex-col transition-all bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-md">
							{/* Window Ribbon / Soft Tactile Tab Strip */}
							<div className="w-full flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-200 dark:border-slate-800">
								{/* Left Tab Stacks */}
								<div className="flex items-center gap-2 flex-wrap">
									<button
										type="button"
										className="flex items-center gap-1.5 px-3 py-1.5 rounded-full clay-btn-soft text-slate-800 dark:text-slate-100 text-xs font-bold shadow-sm"
										onClick={onSwitchToWorkbench}
									>
										<IconFolderOpenOutline16 size={14} className="text-amber-500" />
										<span>项目</span>
									</button>
									<div className="flex items-center gap-2 px-3.5 py-1.5 rounded-full clay-card bg-white dark:bg-slate-800 text-slate-900 dark:text-slate-50 font-mono text-xs font-bold shadow-sm border border-slate-200 dark:border-slate-700">
										<span className="w-2 h-2 rounded-full bg-emerald-500" />
										<span className="truncate max-w-[200px]">{file ? file.split("/").pop() : "选择文件"}</span>
									</div>
								</div>

								{/* Right Controls Pill Group */}
								<div className="flex items-center gap-2">
									<span className="px-2.5 py-1 rounded-full clay-inset font-mono text-[11px] text-slate-700 dark:text-slate-300 font-semibold">
										{visibleRun ? "当前文件结果" : "尚无运行结果"}
									</span>
									<div className="clay-inset flex items-center p-0.5 rounded-full text-xs">
										<button
											type="button"
											className={`px-3 py-1 rounded-full transition-colors ${tab === "content" ? "clay-card bg-white dark:bg-slate-800 font-bold text-slate-900 dark:text-slate-50 shadow-sm border border-slate-200 dark:border-slate-700" : "text-slate-600 hover:text-slate-950 dark:text-slate-400 dark:hover:text-white font-medium"}`}
											onClick={() => setTab("content")}
										>
											源码
										</button>
										<button
											type="button"
											className={`px-3 py-1 rounded-full transition-colors ${tab === "results" ? "clay-card bg-white dark:bg-slate-800 font-bold text-slate-900 dark:text-slate-50 shadow-sm border border-slate-200 dark:border-slate-700" : "text-slate-600 hover:text-slate-950 dark:text-slate-400 dark:hover:text-white font-medium"}`}
											onClick={() => setTab("results")}
										>
											运行结果
										</button>
									</div>
									{onClose && (
										<button
											type="button"
											className="w-7 h-7 rounded-full clay-btn-soft flex items-center justify-center text-slate-500 hover:text-rose-600 dark:text-slate-400 transition-colors"
											title="关闭"
											onClick={onClose}
										>
											<IconCloseOutline14 size={14} />
										</button>
									)}
								</div>
							</div>

							{/* Spec Full Path Header Bar */}
							<div className="w-full flex flex-wrap items-center justify-between px-4 py-2.5 my-2.5 rounded-xl clay-inset text-xs border border-slate-200 dark:border-slate-800">
								<div className="flex items-center gap-2 font-mono overflow-hidden">
									<h2 className="font-bold text-slate-900 dark:text-slate-100 truncate" title={file}>
										{file || "选择测试文件"}
									</h2>
									<span className="px-2 py-0.5 rounded-full bg-emerald-100 dark:bg-emerald-950/70 text-emerald-800 dark:text-emerald-200 text-[10px] font-bold border border-emerald-300 dark:border-emerald-700">
										{file ? fileLang : "未选择"}
									</span>
								</div>
								<div className="flex items-center gap-3 text-slate-600 dark:text-slate-300 font-mono text-[11px] font-semibold">
									<span className="text-amber-700 dark:text-amber-400 font-bold">无系统沙盒隔离</span>
									<span>|</span>
									<span>{sourceBytes} ({sourceLines.length} 行)</span>
								</div>
							</div>

							{/* Embedded Code Editor / Test Runner Output Surface */}
							{tab === "content" ? (
								<div className="relative w-full rounded-2xl clay-code-window p-4 overflow-x-auto min-h-[380px]">
									{sourceError && <p role="alert" className="text-xs text-rose-300 font-semibold mb-2">{sourceError}</p>}
									{loadingSource && <p className="text-xs text-slate-400 mb-2">正在读取源码...</p>}
									{sourceLines.length > 0 ? (
										<table className="w-full border-collapse font-mono text-xs select-text min-w-[680px]">
											<colgroup>
												<col className="w-14" style={{ width: "3.5rem", minWidth: "3.5rem" }} />
												<col />
											</colgroup>
											<tbody>
												{sourceLines.map((line, idx) => (
													<tr key={idx} className="group hover:bg-slate-800/80 transition-colors leading-relaxed">
														<td className="w-14 select-none text-right pr-4 text-slate-500 font-mono text-xs font-semibold align-top whitespace-nowrap shrink-0">
															{idx + 1}
														</td>
														<td className="whitespace-pre text-slate-100 align-top font-mono text-xs pr-4">
															{line || " "}
														</td>
													</tr>
												))}
											</tbody>
										</table>
									) : (
										<div className="py-12 text-center text-slate-400 font-mono">
											{file ? "此文件为空或正在读取..." : "请从左侧选择测试文件进行审查。"}
										</div>
									)}
									<div className="absolute right-4 top-4 hidden md:flex flex-col gap-1 items-end pointer-events-none opacity-90">
										<span className="px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700 font-mono text-[10px] font-semibold">
											{extOf(file || "test.ts").toUpperCase()} • UTF-8
										</span>
										<span className="px-2 py-0.5 rounded-full bg-sky-950/80 text-sky-300 border border-sky-800/60 font-mono text-[10px] font-semibold">
											Vitest Source
										</span>
									</div>
								</div>
							) : (
								<div className="space-y-3 min-h-[300px]">
									{pendingRun?.cwd === cwd && pendingRun.file === file && (
										<div role="status" className="clay-inset rounded-xl p-4 text-sm font-semibold flex items-center gap-2 text-slate-800 dark:text-slate-100 border border-slate-200 dark:border-slate-800">
											<span className="w-3 h-3 rounded-full bg-emerald-500 animate-spin" />
											<span>正在运行 {file}，最长等待 180 秒...</span>
										</div>
									)}

									{visibleRunError && (
										<div role="alert" className="rounded-xl bg-rose-50 dark:bg-rose-950/40 p-4 text-sm text-rose-800 dark:text-rose-200 font-bold shadow-sm border border-rose-300 dark:border-rose-800">
											{visibleRunError}
										</div>
									)}

									{!visibleRun && !visibleRunError && !isRunning && (
										<div className="clay-inset rounded-xl p-8 text-center text-sm text-slate-600 dark:text-slate-300 font-medium border border-slate-200 dark:border-slate-800">
											尚未运行当前文件。点击下方「运行当前文件」即可就地执行。
										</div>
									)}

									{visibleRun && (
										<>
											<div className={`rounded-xl px-4 py-3 text-sm font-bold shadow-sm border ${visibleRun.success ? "bg-emerald-50 text-emerald-800 border-emerald-300 dark:bg-emerald-950/50 dark:text-emerald-200 dark:border-emerald-800" : "bg-rose-50 text-rose-800 border-rose-300 dark:bg-rose-950/50 dark:text-rose-200 dark:border-rose-800"}`}>
												{visibleRun.success ? "执行通过" : "执行失败"} · {visibleRun.passed} 通过 · {visibleRun.failed} 失败 · {visibleRun.skipped} 跳过 · {duration(visibleRun.durationMs)}
											</div>
											<div className="max-h-[42vh] space-y-2 overflow-y-auto pr-1">
												{visibleRun.tests.map((test, index) => (
													<div key={`${test.name}:${index}`} className="clay-inset flex items-start justify-between gap-3 rounded-xl px-3.5 py-2.5 text-xs border border-slate-200 dark:border-slate-800">
														<span className="min-w-0 break-words font-bold text-slate-900 dark:text-slate-100" title={test.name}>{test.name}</span>
														<span className={`shrink-0 font-mono font-bold ${test.status === "passed" ? "text-emerald-700 dark:text-emerald-300" : test.status === "failed" ? "text-rose-700 dark:text-rose-300" : "text-slate-600"}`}>
															{test.status} · {duration(test.durationMs)}
														</span>
													</div>
												))}
											</div>
											{visibleRun.output && (
												<details className="clay-inset rounded-xl p-3 text-xs border border-slate-200 dark:border-slate-800">
													<summary className="cursor-pointer font-bold text-slate-800 dark:text-slate-100">运行输出</summary>
													<pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono select-text clay-code-window p-3 rounded-xl">{visibleRun.output}</pre>
												</details>
											)}
										</>
									)}
								</div>
							)}

							{/* Tactile Floating Workbench Action Dock */}
							<div className="w-full flex flex-wrap items-center justify-between gap-3 pt-3 mt-3 border-t border-slate-200 dark:border-slate-800">
								{/* Left Status & Diff Counter */}
								<div className="flex items-center gap-3">
									<div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full clay-inset text-slate-700 dark:text-slate-200 text-xs font-mono font-medium border border-slate-200 dark:border-slate-800">
										<IconCheckOutline14 size={13} className="text-emerald-500" />
										<span>断言通过: <strong className="text-slate-950 dark:text-white font-bold">{visibleRun ? `${visibleRun.passed}/${visibleRun.tests.length}` : "—"}</strong></span>
									</div>
								</div>

								{/* Right Action Buttons */}
								<div className="flex items-center gap-2 flex-wrap">
									<button
										type="button"
										className="px-3.5 py-1.5 rounded-full clay-btn-soft text-slate-800 hover:text-slate-950 dark:text-slate-200 dark:hover:text-white text-xs font-bold shadow-sm"
										onClick={() => (onSwitchToDiff ? onSwitchToDiff() : onSwitchToWorkbench?.())}
									>
										改动对比
									</button>
									<button
										type="button"
										className="clay-btn clay-btn-mint px-4 py-2 rounded-full text-xs font-bold text-white flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed shadow-md"
										onClick={() => void runSelectedFile()}
										disabled={!file || isRunning}
									>
										<span>{isRunning ? "执行中..." : "运行当前文件"}</span>
									</button>
									<button
										type="button"
										className="px-3.5 py-1.5 rounded-full clay-btn-soft text-emerald-800 hover:text-emerald-950 dark:text-emerald-300 dark:hover:text-emerald-100 font-bold text-xs shadow-sm"
										onClick={onSwitchToWorkbench}
									>
										工作台
									</button>
								</div>
							</div>
						</div>

						{/* Execution Real-time Telemetry & Micro Console (3 Pods from Screen 3) */}
						<div className="w-full grid grid-cols-1 md:grid-cols-3 gap-3">
							{/* Pod 1: Isolated FS State */}
							<div className="clay-card rounded-2xl p-3.5 flex flex-col gap-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm">
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-slate-100">
										<IconFolderOpenOutline16 size={14} className="text-sky-500" />
										<span>实际工作区</span>
									</div>
									<span className="px-2 py-0.5 rounded-full bg-sky-100 text-sky-800 dark:bg-sky-950/60 dark:text-sky-300 text-[10px] font-bold border border-sky-300 dark:border-sky-800">{cwd ? "已选择" : "未选择"}</span>
								</div>
								<p className="font-mono text-[11px] text-slate-600 dark:text-slate-400 truncate" title={cwd}>{cwd}</p>
								<p className="text-[11px] text-slate-600 dark:text-slate-400">测试直接使用此目录，不创建临时文件系统沙盒。</p>
							</div>

							{/* Pod 2: Security & Permissions Barrier */}
							<div className="clay-card rounded-2xl p-3.5 flex flex-col gap-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm">
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-slate-100">
										<span className="w-2 h-2 rounded-full bg-emerald-500" />
										<span>执行权限说明</span>
									</div>
									<span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 text-[10px] font-bold border border-amber-300 dark:border-amber-800">仅限可信代码</span>
								</div>
								<p className="text-[11px] text-slate-600 dark:text-slate-400 leading-tight">测试继承服务进程环境变量，可访问文件和网络；PI_OFFLINE 不提供系统级网络隔离。</p>
							</div>

							{/* Pod 3: Vitest Worker Cluster */}
							<div className="clay-card rounded-2xl p-3.5 flex flex-col gap-1.5 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 shadow-sm">
								<div className="flex items-center justify-between">
									<div className="flex items-center gap-1.5 text-xs font-bold text-slate-900 dark:text-slate-100">
										<span className="w-2 h-2 rounded-full bg-amber-500" />
										<span>运行状态</span>
									</div>
									<span className="px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 text-[10px] font-bold border border-amber-300 dark:border-amber-800">{isRunning ? "执行中" : visibleRun ? (visibleRun.success ? "已通过" : "已失败") : "未运行"}</span>
								</div>
								<div className="flex items-center justify-between text-[11px] font-mono text-slate-700 dark:text-slate-300 font-semibold pt-0.5">
									<span>Worker / PID</span>
									<span>未采集</span>
								</div>
								<div className="flex items-center justify-between text-[11px] font-mono text-slate-700 dark:text-slate-300 font-semibold">
									<span>执行时限</span>
									<span>180 秒</span>
								</div>
							</div>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
