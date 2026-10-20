/**
 * ask_user_question：PiWeb 内置的「问用户」工具（对标 Codex / Claude 桌面端的选择窗口）。
 * 模型一次问 1–4 个问题，每题 2–4 个选项（可多选），界面另给「其他」让用户自己写；
 * 问题经扩展界面桥（extension_ui，method: "questions"）推给浏览器，待答状态进快照，刷新 / 重连不丢。
 * 没有页面在看也一直等（最多 30 分钟）：用户回来打开页面就能答；超时、跳过都如实告诉模型。
 * 本文件前后端共用（不引 SDK）；工具定义本身在 ask-user-tool.ts。
 */

export const ASK_USER_TOOL = "ask_user_question";
export const ASK_USER_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_OTHER_CHARS = 4000;

export interface AskOption {
	label: string;
	description?: string;
}

export interface AskQuestion {
	question: string;
	/** 页签上的短标签 */
	header: string;
	options: AskOption[];
	multiSelect?: boolean;
}

/** 浏览器交回的一题答案：选中的选项标签，和「其他」里自己写的话 */
export interface AskAnswer {
	selected: string[];
	other?: string;
}

export type AskOutcome =
	| { status: "answered"; answers: AskAnswer[] }
	| { status: "skipped" }
	| { status: "timeout" }
	| { status: "unavailable" };

/** 模型给的参数再收一遍：去空白、丢空选项、数量截到上限（schema 已校验过，这里只防手写的怪参数） */
export function normalizeQuestions(raw: unknown): AskQuestion[] {
	const list = Array.isArray((raw as { questions?: unknown })?.questions) ? (raw as { questions: unknown[] }).questions : [];
	const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");
	return list.slice(0, 4).flatMap((item): AskQuestion[] => {
		const q = (item ?? {}) as Record<string, unknown>;
		const question = text(q.question);
		const options = (Array.isArray(q.options) ? q.options : [])
			.map((option): AskOption | null => {
				const o = (option ?? {}) as Record<string, unknown>;
				const label = text(o.label);
				if (!label) return null;
				const description = text(o.description);
				return description ? { label, description } : { label };
			})
			.filter((option): option is AskOption => option !== null)
			.slice(0, 4);
		if (!question || !options.length) return [];
		return [{ question, header: text(q.header) || question.slice(0, 12), options, ...(q.multiSelect === true ? { multiSelect: true } : {}) }];
	});
}

/**
 * 浏览器交回的 JSON → 每题答案。只认问题里真有的选项标签；单选最多留一个；
 * 「其他」截到上限。格式不对就当没答（返回 null，由调用方按跳过处理）。
 */
export function parseAnswers(questions: AskQuestion[], value: string | undefined): AskAnswer[] | null {
	if (!value) return null;
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return null;
	}
	const list = (parsed as { answers?: unknown })?.answers;
	if (!Array.isArray(list)) return null;
	return questions.map((question, index) => {
		const raw = (list[index] ?? {}) as Record<string, unknown>;
		const labels = new Set(question.options.map((option) => option.label));
		let selected = (Array.isArray(raw.selected) ? raw.selected : []).filter((label): label is string => typeof label === "string" && labels.has(label));
		selected = [...new Set(selected)];
		const other = typeof raw.other === "string" ? raw.other.trim().slice(0, MAX_OTHER_CHARS) : "";
		if (!question.multiSelect) {
			// 单选：自己写了就以写的为准，否则只留第一个选项
			if (other) return { selected: [], other };
			return { selected: selected.slice(0, 1) };
		}
		return other ? { selected, other } : { selected };
	});
}

/** 给模型看的工具结果。首行固定（界面据此认出跳过 / 超时），每题一行「问题 → 答案」 */
export function formatOutcome(questions: AskQuestion[], outcome: AskOutcome): string {
	if (outcome.status === "skipped") {
		return "The user dismissed the questions without answering. Don't assume an answer: continue with what you can decide yourself, or ask again in plain text if you cannot proceed.";
	}
	if (outcome.status === "timeout") {
		return "The user did not answer within 30 minutes. Don't assume an answer: continue with what you can decide yourself, or stop and summarize what you need from the user.";
	}
	if (outcome.status === "unavailable") {
		return "The question window is unavailable right now. Ask the user in plain text instead.";
	}
	const lines = questions.map((question, index) => {
		const answer = outcome.answers[index] ?? { selected: [] };
		const parts = [...answer.selected];
		if (answer.other) parts.push(`(their own words) ${answer.other}`);
		return `${index + 1}. ${question.question} → ${parts.length ? parts.join("; ") : "(no answer)"}`;
	});
	return ["The user answered your questions:", ...lines, "Continue with these answers in mind."].join("\n");
}

/** 结果文本的首行，界面用来区分「已答 / 跳过 / 超时」 */
export const ASK_RESULT_PREFIX = {
	answered: "The user answered your questions:",
	skipped: "The user dismissed the questions",
	timeout: "The user did not answer within",
} as const;
