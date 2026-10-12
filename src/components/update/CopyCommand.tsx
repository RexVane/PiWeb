"use client";

import { useState } from "react";
import { useI18n } from "@/i18n";
import { copyText } from "@/lib/clipboard";

/** 要用户自己在终端执行的命令：等宽显示 + 复制按钮（设置行和右下角提示条共用） */
export function CopyCommand({ command }: { command: string }) {
	const { t } = useI18n();
	const [copied, setCopied] = useState<"" | "ok" | "fail">("");
	return (
		<span className="flex min-w-0 items-center gap-1.5">
			<code
				className="min-w-0 flex-1"
				style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--dsw-label-primary)", whiteSpace: "nowrap", overflowX: "auto" }}
			>
				{command}
			</code>
			<button
				type="button"
				className="btn-outline flex-none"
				style={{ height: 22, padding: "0 8px", fontSize: 11, color: copied === "fail" ? "var(--dsw-danger)" : undefined }}
				onClick={() => {
					void copyText(command).then((ok) => {
						setCopied(ok ? "ok" : "fail");
						setTimeout(() => setCopied(""), 1500);
					});
				}}
			>
				{copied === "ok" ? t.updateCopied : copied === "fail" ? t.copyFailed : t.copy}
			</button>
		</span>
	);
}
