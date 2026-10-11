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
