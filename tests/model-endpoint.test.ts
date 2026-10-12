/**
 * 本机/私网地址判断：**只用于界面提示**（自动勾上「允许访问本机/私有网络地址」）。
 * 真正的闸门在服务端（requestModelCatalog），这里判错不影响安全，但判太松会让服务端白拒一次。
 */
import { describe, expect, it } from "vitest";
import { looksPrivateEndpoint } from "../src/lib/model-endpoint";

describe("模型目录地址判断", () => {
	it("本机、私网、链路本地都算私网", () => {
		for (const url of [
			"http://127.0.0.1:3425/v1",
			"http://localhost:11434/v1",
			"https://gateway.local/v1",
			"http://192.168.1.7/v1",
			"http://10.0.0.5/v1",
			"http://172.16.3.4/v1",
			"http://172.31.255.1/v1",
			"http://169.254.169.254/latest",
			"http://[::1]:8080/v1",
		]) expect(looksPrivateEndpoint(url), url).toBe(true);
	});

	it("公网地址不算私网，URL 写错时保守地当作公网（交给服务端去拒）", () => {
		for (const url of ["https://api.example.com/v1", "https://openrouter.ai/api/v1", "http://172.32.0.1/v1", "http://fcorp.example.com/v1"]) {
			expect(looksPrivateEndpoint(url), url).toBe(false);
		}
		expect(looksPrivateEndpoint("not a url")).toBe(false);
		expect(looksPrivateEndpoint("")).toBe(false);
	});
});
