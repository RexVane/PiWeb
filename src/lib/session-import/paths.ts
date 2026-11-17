/**
 * 各来源在本机的固定位置（一处收口，方便核对与测试替身）。
 *
 * 全部基于用户主目录；这些目录**只读**——导入过程中不往源目录写任何东西。
 */
import os from "node:os";
import path from "node:path";

/** Claude Code：~/.claude/projects/<项目 slug>/<会话 uuid>.jsonl */
export function claudeRoot(): string {
	return path.join(os.homedir(), ".claude", "projects");
}

/** Codex CLI：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl */
export function codexRoot(): string {
	return path.join(os.homedir(), ".codex", "sessions");
}

/** Grok CLI：~/.grok/sessions/<url 编码 cwd>/<id>/{summary.json,chat_history.jsonl} */
export function grokRoot(): string {
	return path.join(os.homedir(), ".grok", "sessions");
}

/** dsh：~/.dsh/sessions/<编码 cwd>/session-<uuid>/session.jsonl.zstd */
export function dshRoot(): string {
	return path.join(os.homedir(), ".dsh", "sessions");
}

/** ZCode：~/.zcode/cli/db/db.sqlite */
export function zcodeDb(): string {
	return path.join(os.homedir(), ".zcode", "cli", "db", "db.sqlite");
}

/** opencode：~/.local/share/opencode/opencode.db（Windows 上也是这个 XDG 风格路径） */
export function opencodeDb(): string {
	return path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
}

/** Kimi Code：~/.kimi/sessions/<工作区>/<会话>/agents/<agent>/wire.jsonl，state.json 在会话目录里 */
export function kimiSessionsRoot(): string {
	return path.join(os.homedir(), ".kimi", "sessions");
}

/** Kimi Code 的 session_index.jsonl 在 sessions/ 旁边（老会话的 workDir 兜底） */
export function kimiHome(): string {
	return path.join(os.homedir(), ".kimi");
}

/** WorkBuddy / WorkBuddy AI：~/.workbuddy(-ai)/projects/<项目>/<会话>.jsonl，每行带 cwd */
export function workbuddyRoots(): string[] {
	const roots: string[] = [];
	const configured = process.env.WORKBUDDY_CONFIG_DIR;
	if (configured) roots.push(configured);
	for (const dir of [".workbuddy", ".workbuddy-ai"]) roots.push(path.join(os.homedir(), dir));
	return roots;
}

/** Antigravity（桌面 / IDE）：~/.gemini/antigravity */
export function antigravityRoot(): string {
	return path.join(os.homedir(), ".gemini", "antigravity");
}

/** Antigravity CLI：~/.gemini/antigravity-cli */
export function antigravityCliRoot(): string {
	return path.join(os.homedir(), ".gemini", "antigravity-cli");
}

/** Qwen Code：$QWEN_HOME 或 ~/.qwen（新布局 projects/<编码项目>/chats/*.jsonl，老布局 tmp/<项目>/chats/*.json） */
export function qwenHome(): string {
	return process.env.QWEN_HOME || path.join(os.homedir(), ".qwen");
}

/** Qwen Code 新布局：~/.qwen/projects/<编码项目>/chats/ */
export function qwenProjectsRoot(): string {
	return path.join(qwenHome(), "projects");
}

/** Qwen Code 老布局（Gemini CLI fork 早期）：~/.qwen/tmp/<项目>/chats/ */
export function qwenLegacyTmpRoot(): string {
	return path.join(qwenHome(), "tmp");
}

/** Cursor Agent CLI：~/.cursor/chats/<工作区 md5>/<会话 uuid>/store.db */
export function cursorChatsRoot(): string {
	return path.join(os.homedir(), ".cursor", "chats");
}
