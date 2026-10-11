/**
 * 浏览器会话的签名密钥（服务端专用，含 node:fs / node:crypto）。
 *
 * 与「密钥就是密码」的做法不同：这里是一把独立的 32 字节随机值，
 * Cookie 泄露后无法离线爆破出任何用户凭据；删掉这个文件即撤销全部会话。
 * 位置与其它 PiWeb 状态一致（web-workspaces.json / web-uploads 同目录），
 * 放在 pi 的 agent 目录下，用 web- 前缀。
 *
 * 这里手写一份 agent 目录解析，而不是 import ./pi：
 * proxy（Next 16 的 Node runtime 中间件）会引用本模块，不该把整个 pi SDK 打进包里。
 * 规则与 @earendil-works/pi-coding-agent 的 getAgentDir() 一致。
 */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SECRET_BYTES = 32;
/** 存盘的文件名，位于 agent 目录下 */
export const SECRET_FILENAME = "web-secret";
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function expandTilde(value: string): string {
	if (value === "~") return os.homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(os.homedir(), value.slice(2));
	return value;
}

/** pi 的 agent 目录：PI_CODING_AGENT_DIR 优先，默认 ~/.pi/agent */
export function agentDir(): string {
	const envDir = process.env.PI_CODING_AGENT_DIR;
	if (envDir) return expandTilde(envDir);
	return path.join(os.homedir(), ".pi", "agent");
}

/** 密钥文件路径：PI_WEB_SECRET_FILE 优先，默认 <agentDir>/web-secret */
export function secretFilePath(): string {
	const override = process.env.PI_WEB_SECRET_FILE;
	return override ? expandTilde(override) : path.join(agentDir(), SECRET_FILENAME);
}

export function encodeSecret(secret: Buffer): string {
	return secret.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 只接受 32 字节的 base64url，其它一律当作无效 */
export function decodeSecret(value: string): Buffer | undefined {
	const trimmed = value.trim();
	if (!BASE64URL_PATTERN.test(trimmed) || trimmed.length % 4 === 1) return undefined;
	const padding = "=".repeat((4 - (trimmed.length % 4)) % 4);
	const decoded = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/") + padding, "base64");
	return decoded.byteLength === SECRET_BYTES ? decoded : undefined;
}

/** 同一个路径只解析一次；测试改环境变量后按路径自动失效 */
const cache = new Map<string, Buffer>();

function readSecretFile(file: string): Buffer | undefined {
	try {
		return decodeSecret(fs.readFileSync(file, "utf8"));
	} catch {
		return undefined;
	}
}

function createSecretFile(file: string): Buffer {
	const secret = randomBytes(SECRET_BYTES);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	try {
		// wx：并发启动时只有一个进程能创建，其它进程读到它写下的值
		fs.writeFileSync(file, `${encodeSecret(secret)}\n`, { flag: "wx", mode: 0o600 });
		return secret;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException)?.code;
		if (code !== "EEXIST") throw error;
		const existing = readSecretFile(file);
		if (!existing) throw new Error(`web-secret file exists but is not a valid ${SECRET_BYTES}-byte key: ${file}`);
		return existing;
	}
}

/**
 * 取会话签名密钥，必要时生成。
 * PI_WEB_SECRET 直接给出 base64url 值时优先用它（容器/多实例不想挂卷的场合）。
 * 密钥无效（长度不对）时按文件缺失处理并重新生成，避免服务直接不可用。
 */
export function loadWebSecret(): Buffer {
	const inline = process.env.PI_WEB_SECRET;
	if (inline) {
		const decoded = decodeSecret(inline);
		if (!decoded) throw new Error(`PI_WEB_SECRET must be ${SECRET_BYTES} base64url-encoded bytes`);
		return decoded;
	}
	const file = secretFilePath();
	const hit = cache.get(file);
	if (hit) return hit;
	const secret = readSecretFile(file) ?? createSecretFile(file);
	cache.set(file, secret);
	return secret;
}

/** 仅供测试：清掉进程内缓存 */
export function resetWebSecretCache(): void {
	cache.clear();
}
