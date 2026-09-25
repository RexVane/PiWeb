"use client";

import { useEffect, useRef, useState } from "react";
import type { TestRunResult } from "@/lib/test-run-service";

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
}: {
	cwd: string;
	onClose?: () => void;
	onSwitchToWorkbench?: () => void;
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
				setSelection((previous) => previous?.cwd === cwd && nextFiles.includes(previous.file)
					? previous
					: nextFiles.length ? { cwd, file: nextFiles[0] } : null);
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
				const response = await fetch(`/api/tests?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(file)}`, { signal: controller.signal });
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

	return (
		<div className="mx-auto flex w-full max-w-7xl flex-col gap-4 p-2 sm:p-4 text-slate-800 dark:text-slate-100">
			<div className="clay-card flex flex-wrap items-center justify-between gap-3 rounded-2xl p-3.5">
				<div className="flex min-w-0 flex-wrap items-center gap-2">
					<span className="clay-inset rounded-full px-3 py-1.5 text-sm font-bold">测试检查器</span>
					<span className="clay-btn-soft max-w-xs truncate rounded-full px-3 py-1 font-mono text-xs" title={cwd}>{cwd || "未选择工作区"}</span>
					<span className="rounded-full bg-sky-50 px-2.5 py-1 text-[11px] font-semibold text-sky-700 dark:bg-sky-950/40 dark:text-sky-300">Vitest · 单文件执行</span>
				</div>
				<div className="flex items-center gap-2">
					<span className="font-mono text-xs text-slate-500">{files.length} 个测试文件</span>
					<button type="button" className="clay-btn-soft rounded-full px-3 py-1.5 text-xs" onClick={() => setRefreshKey((key) => key + 1)} disabled={!cwd || loadingFiles}>刷新文件</button>
					{onClose && <button type="button" className="clay-btn-soft rounded-full px-3 py-1.5 text-xs" onClick={onClose}>关闭</button>}
				</div>
			</div>

			{!cwd && <div className="clay-inset rounded-2xl p-6 text-sm text-slate-500">请先在工作台选择工作区，再查看或运行测试。</div>}
			{listError && <div role="alert" className="rounded-2xl bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{listError}</div>}
			{cwd && <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-12">
				<section className="clay-card flex flex-col gap-3 rounded-2xl p-4 xl:col-span-3">
					<div className="flex items-center justify-between gap-2 border-b border-slate-200/60 pb-3 text-sm font-bold dark:border-slate-800/60">
						<span>测试文件</span><span className="font-mono text-xs font-normal text-slate-400">tests/</span>
					</div>
					{loadingFiles && <p className="text-xs text-slate-500">正在读取测试文件...</p>}
					{!loadingFiles && !listError && files.length === 0 && <p className="text-xs text-slate-500">此工作区没有可运行的测试文件。</p>}
					<div className="max-h-[58vh] space-y-1 overflow-y-auto">
						{files.map((item) => <button key={item} type="button" title={item} className={`w-full break-all rounded-xl px-3 py-2 text-left font-mono text-xs ${file === item ? "clay-inset font-semibold text-emerald-700 dark:text-emerald-300" : "text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"}`} onClick={() => setSelection({ cwd, file: item })}>{item}</button>)}
					</div>
				</section>

				<section className="clay-card flex min-w-0 flex-col gap-3 rounded-2xl p-4 xl:col-span-9">
					<div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200/60 pb-3 dark:border-slate-800/60">
						<div className="min-w-0">
							<h2 className="truncate font-mono text-sm font-bold" title={file}>{file || "选择测试文件"}</h2>
							<p className="mt-1 text-xs text-slate-500">运行结果仅在实际执行后显示，不代表整个测试套件。</p>
						</div>
						<div className="flex items-center gap-2">
							<button type="button" className="clay-btn-soft rounded-full px-3 py-1.5 text-xs" onClick={onSwitchToWorkbench}>工作台</button>
							<button type="button" className="clay-btn clay-btn-mint rounded-full px-4 py-1.5 text-xs font-bold text-white disabled:cursor-not-allowed disabled:opacity-50" onClick={() => void runSelectedFile()} disabled={!file || isRunning}>{isRunning ? "执行中..." : "运行当前文件"}</button>
						</div>
					</div>
					<div className="clay-inset flex w-fit items-center gap-1 rounded-full p-1 text-xs">
						<button type="button" className={`rounded-full px-3 py-1 ${tab === "content" ? "clay-card font-bold" : "text-slate-500"}`} onClick={() => setTab("content")}>源码</button>
						<button type="button" className={`rounded-full px-3 py-1 ${tab === "results" ? "clay-card font-bold" : "text-slate-500"}`} onClick={() => setTab("results")}>运行结果</button>
					</div>
					{tab === "content" ? (
						<div className="clay-inset min-h-48 overflow-x-auto rounded-2xl bg-[#1a1f26] p-4 text-[#e6edf3]">
							{sourceError && <p role="alert" className="text-xs text-rose-300">{sourceError}</p>}
							{loadingSource && <p className="text-xs text-slate-400">正在读取源码...</p>}
							{visibleSource !== null && <pre className="w-max min-w-full font-mono text-xs leading-5 select-text"><code>{visibleSource}</code></pre>}
						</div>
					) : (
						<div className="space-y-3">
							{pendingRun?.cwd === cwd && pendingRun.file === file && <div role="status" className="clay-inset rounded-xl p-3 text-sm">正在运行 {file}，最长等待 180 秒...</div>}
							{visibleRunError && <div role="alert" className="rounded-xl bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{visibleRunError}</div>}
							{!visibleRun && !visibleRunError && !isRunning && <div className="clay-inset rounded-xl p-6 text-center text-sm text-slate-500">尚未运行当前文件。</div>}
							{visibleRun && <>
								<div className={`rounded-xl px-4 py-3 text-sm font-bold ${visibleRun.success ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300" : "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300"}`}>{visibleRun.success ? "执行通过" : "执行失败"} · {visibleRun.passed} 通过 · {visibleRun.failed} 失败 · {visibleRun.skipped} 跳过 · {duration(visibleRun.durationMs)}</div>
								<div className="max-h-[45vh] space-y-2 overflow-y-auto">{visibleRun.tests.map((test, index) => <div key={`${test.name}:${index}`} className="clay-inset flex items-start justify-between gap-3 rounded-xl px-3 py-2 text-xs"><span className="min-w-0 break-words">{test.name}</span><span className={`shrink-0 font-mono font-bold ${test.status === "passed" ? "text-emerald-600" : test.status === "failed" ? "text-rose-600" : "text-slate-500"}`}>{test.status} · {duration(test.durationMs)}</span></div>)}</div>
								{visibleRun.output && <details className="clay-inset rounded-xl p-3 text-xs"><summary className="cursor-pointer font-semibold">运行输出</summary><pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all font-mono select-text">{visibleRun.output}</pre></details>}
							</>}
						</div>
					)}
				</section>
			</div>}
		</div>
	);
}
