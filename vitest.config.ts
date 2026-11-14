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
		env: { NODE_ENV: "test" },
		// SDK, Git and large-upload fixtures each allocate their own process and storage.
		maxWorkers: 4,
		// Heavy fixtures (real Git repositories, SDK module loading, uploads) can exceed the
		// 5s default when the whole suite runs together on a loaded machine.
		testTimeout: 30_000,
		hookTimeout: 60_000,
		include: ["tests/**/*.test.{ts,tsx}"],
		// jsdom 缺失的浏览器 API 垫片（node 环境下自动跳过）
		setupFiles: ["tests/setup-dom.ts"],
		reporters: process.env.PIWEB_TEST_REPORT ? ["default", "json"] : ["default"],
		outputFile: process.env.PIWEB_TEST_REPORT,
		coverage: {
			enabled: process.env.PIWEB_COVERAGE === "1",
			provider: "v8",
			reportOnFailure: true,
			include: ["src/**", "scripts/{file-lock,http-request-guard,remote-engine,update-environment,web-auth-protocol,web-auth-constants,process-identity}.mjs"],
			reporter: ["json-summary", "text-summary"],
			reportsDirectory: process.env.PIWEB_COVERAGE_REPORT_DIR ?? "coverage",
			thresholds: {
				branches: 70,
				// Keep separate baselines for these large modules; a global total
				// alone can hide regressions in their request and permission branches.
				// Ratchet these measured floors upward as coverage grows; do not
				// lower them to accommodate a failing change or exclude new branches.
				"src/hooks/usePiWeb.ts": { branches: 53 },
				"src/lib/git-service.ts": { branches: 42 },
			},
		},
	},
});
