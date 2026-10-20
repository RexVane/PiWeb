/**
 * ask_user_question 的工具定义（只在服务端用：引了 pi-ai 的 TypeBox）。
 * 题目 / 答案的归一化与给模型的结果文本在 ask-user.ts，前端也共用那份。
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { ASK_USER_TOOL, formatOutcome, normalizeQuestions, type AskOutcome, type AskQuestion } from "./ask-user";

const AskUserParams = Type.Object({
	questions: Type.Array(
		Type.Object({
			question: Type.String({ description: "The complete question, ending with a question mark. Write it in the user's language." }),
			header: Type.String({ description: "Very short label shown on the question's tab (max ~12 characters), e.g. \"Scope\", \"Database\"." }),
			options: Type.Array(
				Type.Object({
					label: Type.String({ description: "Concise choice text (1–5 words)." }),
					description: Type.Optional(Type.String({ description: "One sentence on what picking it means or its trade-off." })),
				}),
				{ minItems: 2, maxItems: 4, description: "2–4 mutually exclusive choices (unless multiSelect). Do not add an \"Other\" option: the user can always write their own answer." },
			),
			multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting several options. Default false." })),
		}),
		{ minItems: 1, maxItems: 4, description: "1–4 questions to ask at once." },
	),
});

const DESCRIPTION = [
	"Ask the user 1–4 multiple-choice questions in an interactive window and wait for their answers.",
	"Use it when you are blocked on a decision that is genuinely the user's — choosing between approaches, confirming scope, clarifying an ambiguous requirement — instead of asking in plain text and ending your turn.",
	"Don't use it for things you can find out by reading the code or for routine permission to continue.",
	"Give each question 2–4 concise options with a one-line description of the trade-off; put the recommended option first and append \" (Recommended)\" to its label (in the user's language).",
	"The user can always type their own answer instead, so never add an \"Other\" option. Set multiSelect when several options can apply together.",
].join(" ");

/** 工具本体；ask 由会话提供（把问题推给浏览器并等答案） */
export function createAskUserTool(ask: (questions: AskQuestion[], signal?: AbortSignal) => Promise<AskOutcome>) {
	return defineTool({
		name: ASK_USER_TOOL,
		label: "Ask user",
		description: DESCRIPTION,
		promptSnippet: "Ask the user multiple-choice questions in an interactive window when a decision is genuinely theirs",
		parameters: AskUserParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal) {
			const questions = normalizeQuestions(params);
			if (!questions.length) {
				const outcome: AskOutcome = { status: "unavailable" };
				return { content: [{ type: "text", text: "No valid questions: each question needs text and options to choose from." }], details: { questions, outcome } };
			}
			const outcome = await ask(questions, signal);
			return { content: [{ type: "text", text: formatOutcome(questions, outcome) }], details: { questions, outcome } };
		},
	});
}
