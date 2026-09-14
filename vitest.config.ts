import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		// 组件之间用 "@/..." 互相引用（vitest 不读 tsconfig paths，需显式配置）
		alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
	},
	test: {
		// 默认 node；组件测试在文件头加 // @vitest-environment jsdom
		environment: "node",
		// SDK, Git and large-upload fixtures each allocate their own process and storage.
		maxWorkers: 4,
		// Heavy fixtures (real Git repositories, SDK module loading, uploads) can exceed the
		// 5s default when the whole suite runs together on a loaded machine.
		testTimeout: 30_000,
		hookTimeout: 60_000,
		include: ["tests/**/*.test.{ts,tsx}"],
		// jsdom 缺失的浏览器 API 垫片（node 环境下自动跳过）
		setupFiles: ["tests/setup-dom.ts"],
	},
});
