/**
 * models.json / auth.json 的外部改动感知。不依赖 SDK（运行时作为 unknown 传入），方便直接测。
 */
import { statSync } from "node:fs";
import path from "node:path";

/** 两个文件的指纹（大小 + 修改时间，不读内容）：指纹变了才需要重新加载模型目录 */
export function modelFilesFingerprint(agentDir: string): string {
	return ["models.json", "auth.json"]
		.map((name) => {
			try {
				const stat = statSync(path.join(agentDir, name));
				return `${name}:${stat.size}:${stat.mtimeMs}`;
			} catch {
				return `${name}:-`;
			}
		})
		.join("|");
}

/**
 * SDK 的 auth 存储第一次读 auth.json 后就缓存在内存里，手改之后要让它重读。
 * SDK 没有公开这个入口：运行时把存储包在 RuntimeCredentials.store 里，这里走这条路径调 reload()。
 * 路径不存在（SDK 版本变了）就什么都不做，只剩 models.json 的刷新；tests/model-files.test.ts 会用真实 SDK 验证这条路径。
 */
export function reloadStoredCredentials(runtime: unknown): void {
	const store = (runtime as { credentials?: { store?: { reload?: () => void } } }).credentials?.store;
	try {
		store?.reload?.();
	} catch {
		// auth.json 写坏了：保留旧缓存，错误由下一次读取报出来
	}
}
