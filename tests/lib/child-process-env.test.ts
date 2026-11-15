import { describe, expect, it } from "vitest";
import { childProcessEnv, editorEnv, gitEnv, scrubbedEnv } from "../../src/lib/child-process-env";

/** 用普通对象当 base，避免依赖跑测试机器的真实环境变量。 */
const BASE: Record<string, string> = {
	PATH: "C:\\Windows\\System32",
	HOME: "/home/tester",
	USERPROFILE: "C:\\Users\\tester",
	APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
	TEMP: "C:\\Temp",
	LANG: "zh_CN.UTF-8",
	PI_WEB_LAUNCH_TOKEN: "launch-token",
	PI_WEB_SECRET: "web-secret",
	OPENAI_API_KEY: "sk-live-should-not-leak",
	DB_PASSWORD: "hunter2",
	MY_CREDENTIAL: "cred",
	PRIVATE_KEY: "pem",
	SOME_SECRET_VALUE: "s",
	NODE_OPTIONS: "--import=./guard.mjs",
	HTTP_PROXY: "http://proxy-user:proxy-pass@127.0.0.1:7890",
	SSH_AUTH_SOCK: "/tmp/ssh.sock",
	ORDINARY: "kept",
};

describe("scrubbedEnv", () => {
	it("strips credential-looking names and keeps platform essentials", () => {
		const env = scrubbedEnv(BASE);
		for (const name of ["PI_WEB_LAUNCH_TOKEN", "PI_WEB_SECRET", "OPENAI_API_KEY", "DB_PASSWORD", "MY_CREDENTIAL", "PRIVATE_KEY", "SOME_SECRET_VALUE", "NODE_OPTIONS"]) {
			expect(env, name).not.toHaveProperty(name);
		}
		for (const name of ["PATH", "HOME", "USERPROFILE", "APPDATA", "TEMP", "LANG", "ORDINARY", "SSH_AUTH_SOCK"]) {
			expect(env[name], name).toBe(BASE[name]);
		}
	});

	it("keeps proxy variables by default: their credentials are what the child needs to connect", () => {
		expect(scrubbedEnv(BASE).HTTP_PROXY).toBe(BASE.HTTP_PROXY);
	});

	it("allowlist keeps a sensitive-looking variable on purpose", () => {
		const env = scrubbedEnv({ ...BASE, MY_SERVICE_TOKEN: "needed" }, { allowlist: ["MY_SERVICE_TOKEN"] });
		expect(env.MY_SERVICE_TOKEN).toBe("needed");
		expect(env.PI_WEB_SECRET).toBeUndefined();
	});

	it("extra values are merged after scrubbing and win over base", () => {
		const env = scrubbedEnv(BASE, { extra: { GIT_TERMINAL_PROMPT: "0", PATH: "C:\\custom" } });
		expect(env.GIT_TERMINAL_PROMPT).toBe("0");
		expect(env.PATH).toBe("C:\\custom");
	});

	it("denylist removes additional names", () => {
		const env = scrubbedEnv(BASE, { denylist: ["ORDINARY"] });
		expect(env).not.toHaveProperty("ORDINARY");
	});

	it("can keep process-injection variables when asked", () => {
		const env = scrubbedEnv(BASE, { stripNodeInjection: false });
		expect(env.NODE_OPTIONS).toBe(BASE.NODE_OPTIONS);
		expect(env.PI_WEB_SECRET).toBeUndefined();
	});

	it("does not mutate the base environment", () => {
		const base = { ...BASE };
		scrubbedEnv(base);
		expect(base).toEqual(BASE);
	});
});

describe("convenience wrappers", () => {
	it("childProcessEnv/editorEnv never leak credentials from process.env", () => {
		const saved = { ...process.env };
		try {
			process.env.PIWEB_TEST_LAUNCH_TOKEN = "leak-me";
			process.env.PIWEB_TEST_API_KEY = "sk-leak";
			process.env.PIWEB_TEST_ORDINARY = "kept";
			const child = childProcessEnv();
			expect(child.PIWEB_TEST_LAUNCH_TOKEN).toBeUndefined();
			expect(child.PIWEB_TEST_API_KEY).toBeUndefined();
			expect(child.PIWEB_TEST_ORDINARY).toBe("kept");
			expect(child.PATH).toBe(process.env.PATH);
			const editor = editorEnv({ PIWEB_EDITOR_FLAG: "1" });
			expect(editor.PIWEB_EDITOR_FLAG).toBe("1");
			expect(editor.PIWEB_TEST_LAUNCH_TOKEN).toBeUndefined();
		} finally {
			for (const key of Object.keys(process.env)) if (key.startsWith("PIWEB_TEST_")) delete process.env[key];
			Object.assign(process.env, saved);
		}
	});

	it("gitEnv drops inherited repository-scoped git variables but keeps ordinary git settings", () => {
		const saved = { ...process.env };
		try {
			process.env.GIT_DIR = "C:\\repos\\other\\.git";
			process.env.GIT_WORK_TREE = "C:\\repos\\other";
			process.env.GIT_INDEX_FILE = "C:\\temp\\index";
			process.env.GIT_CONFIG_COUNT = "1";
			process.env.GIT_SSH_COMMAND = "ssh -i ./key";
			process.env.PIWEB_TEST_LAUNCH_TOKEN = "leak-me";
			const env = gitEnv({ GIT_TERMINAL_PROMPT: "0" });
			expect(env.GIT_DIR).toBeUndefined();
			expect(env.GIT_WORK_TREE).toBeUndefined();
			expect(env.GIT_INDEX_FILE).toBeUndefined();
			expect(env.GIT_CONFIG_COUNT).toBeUndefined();
			expect(env.GIT_SSH_COMMAND).toBe("ssh -i ./key");
			expect(env.GIT_TERMINAL_PROMPT).toBe("0");
			expect(env.PIWEB_TEST_LAUNCH_TOKEN).toBeUndefined();
			expect(env.PATH).toBe(process.env.PATH);
		} finally {
			for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG_COUNT", "GIT_SSH_COMMAND"]) delete process.env[key];
			for (const key of Object.keys(process.env)) if (key.startsWith("PIWEB_TEST_")) delete process.env[key];
			Object.assign(process.env, saved);
		}
	});
});
