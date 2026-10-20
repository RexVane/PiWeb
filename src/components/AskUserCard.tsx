"use client";

/**
 * 选择窗口：内置 ask_user_question 工具的问题卡，显示在输入框正上方（对标 Codex / Claude 桌面端）。
 * 每题单选或多选，另有「其他」可自己写；跳过 / 提交都经 extensionUiResponse 交回服务端，
 * 答案是 JSON（{ answers: [{ selected, other? }] }），服务端再按题目校验一遍。
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { IconCheckOutline14 } from "@/components/icons";
import { useI18n } from "@/i18n";
import type { ExtensionDialog } from "@/hooks/usePiWeb";

interface Draft {
	selected: string[];
	other: string;
}

const isAnswered = (draft: Draft | undefined) => Boolean(draft && (draft.selected.length > 0 || draft.other.trim()));

export function AskUserCard({
	dialog,
	onAnswer,
}: {
	dialog: ExtensionDialog;
	onAnswer: (id: string, response: { value?: string; cancelled?: boolean }) => void;
}) {
	const { t } = useI18n();
	const questions = dialog.questions ?? [];
	const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(() => ({ selected: [], other: "" })));
	const [index, setIndex] = useState(0);
	const cardRef = useRef<HTMLElement>(null);
	const otherRef = useRef<HTMLInputElement>(null);

	// 弹出时没人在打字（焦点在页面本身）才把焦点挪进卡片，免得打断正在输入框里写的话
	useEffect(() => {
		const active = document.activeElement;
		if (!active || active === document.body) cardRef.current?.focus({ preventScroll: true });
	}, []);

	if (!questions.length) return null;
	const current = Math.min(index, questions.length - 1);
	const question = questions[current];
	const draft = drafts[current] ?? { selected: [], other: "" };
	const allAnswered = questions.every((_, i) => isAnswered(drafts[i]));
	const many = questions.length > 1;

	/** 改当前题：基于最新状态算（连点几项、紧接着打字时，渲染闭包里的 draft 可能还是旧的） */
	const updateCurrent = (fn: (d: Draft) => Draft) => setDrafts((list) => list.map((d, j) => (j === current ? fn(d) : d)));
	/** 下一道还没答的题（从当前往后绕一圈）；都答了返回 -1 */
	const nextUnanswered = (from: number, list: Draft[]) => {
		for (let step = 1; step <= questions.length; step++) {
			const i = (from + step) % questions.length;
			if (!isAnswered(list[i])) return i;
		}
		return -1;
	};
	const choose = (label: string) => {
		if (question.multiSelect) {
			updateCurrent((d) => ({ ...d, selected: d.selected.includes(label) ? d.selected.filter((l) => l !== label) : [...d.selected, label] }));
			return;
		}
		const next = { selected: [label], other: "" };
		updateCurrent(() => next);
		// 单选点了就是答了：自动跳到下一道没答的题，最后一题停住等提交
		const target = nextUnanswered(current, drafts.map((d, j) => (j === current ? next : d)));
		if (target >= 0 && target !== current) setIndex(target);
	};
	const setOther = (text: string) => {
		// 单选时自己写了就以写的为准，清掉已选项；多选时两者并存
		updateCurrent((d) => (question.multiSelect ? { ...d, other: text } : { selected: text.trim() ? [] : d.selected, other: text }));
	};
	const submit = () => {
		if (!allAnswered) return;
		const answers = drafts.map((d) => ({ selected: d.selected, ...(d.other.trim() ? { other: d.other.trim() } : {}) }));
		onAnswer(dialog.id, { value: JSON.stringify({ answers }) });
	};
	const primary = () => {
		if (allAnswered) return submit();
		if (!isAnswered(draft)) return;
		const target = nextUnanswered(current, drafts);
		if (target >= 0) setIndex(target);
	};
	const primaryLabel = allAnswered || !many ? t.askSubmit : t.askNext;
	const primaryDisabled = !allAnswered && (!many || !isAnswered(draft));

	const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
		if (event.nativeEvent.isComposing) return;
		if (event.target === otherRef.current) {
			if (event.key === "Enter") {
				event.preventDefault();
				primary();
			} else if (event.key === "Escape") {
				event.preventDefault();
				cardRef.current?.focus({ preventScroll: true });
			}
			event.stopPropagation();
			return;
		}
		const digit = /^[1-9]$/.test(event.key) ? Number(event.key) : 0;
		if (digit && digit <= question.options.length) {
			choose(question.options[digit - 1].label);
		} else if (digit === question.options.length + 1) {
			otherRef.current?.focus();
		} else if (many && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
			setIndex((current + (event.key === "ArrowRight" ? 1 : questions.length - 1)) % questions.length);
		} else if (event.key === "Enter" && event.target === event.currentTarget) {
			primary();
		} else {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
	};

	/** 行尾的单选圈 / 多选框：一眼看出这题能选几个 */
	const mark = (checked: boolean) => (
		<span className="pw-ask-mark" data-kind={question.multiSelect ? "check" : "radio"} data-checked={checked || undefined} aria-hidden>
			{checked && question.multiSelect && <IconCheckOutline14 size={11} />}
		</span>
	);
	const title = many ? t.askTitleMany.replace("{n}", String(questions.length)) : t.askTitle;
	const questionId = `pw-ask-${dialog.id}-q`;
	return (
		<section ref={cardRef} className="pw-ask" tabIndex={-1} aria-label={title} onKeyDown={onKeyDown} data-testid="ask-user-card">
			<div className="pw-ask-head">
				<span className="pw-ask-dot" aria-hidden />
				<span className="pw-ask-title">{title}</span>
				{many && (
					<div className="pw-ask-tabs" role="tablist">
						{questions.map((q, i) => (
							<button
								key={`${i}-${q.header}`}
								type="button"
								role="tab"
								aria-selected={i === current}
								data-answered={isAnswered(drafts[i]) || undefined}
								className="pw-ask-tab"
								title={isAnswered(drafts[i]) ? `${q.question} · ${t.askAnswered}` : q.question}
								onClick={() => setIndex(i)}
							>
								{isAnswered(drafts[i]) && <IconCheckOutline14 size={11} />}
								{q.header}
							</button>
						))}
					</div>
				)}
			</div>
			<div className="pw-ask-question" id={questionId}>
				{question.question}
				{question.multiSelect && <span className="pw-ask-multi">{t.askMultiHint}</span>}
			</div>
			<div className="pw-ask-options" role={question.multiSelect ? "group" : "radiogroup"} aria-labelledby={questionId}>
				{question.options.map((option, i) => {
					const checked = draft.selected.includes(option.label);
					return (
						<button
							key={`${current}-${i}-${option.label}`}
							type="button"
							role={question.multiSelect ? "checkbox" : "radio"}
							aria-checked={checked}
							className="pw-ask-option"
							onClick={() => choose(option.label)}
						>
							<span className="pw-ask-num">{i + 1}</span>
							<span className="pw-ask-text">
								<span className="pw-ask-label">{option.label}</span>
								{option.description && <span className="pw-ask-desc">{option.description}</span>}
							</span>
							{mark(checked)}
						</button>
					);
				})}
				<label className="pw-ask-option pw-ask-other" data-checked={draft.other.trim() ? true : undefined}>
					<span className="pw-ask-num">{question.options.length + 1}</span>
					<input
						key={current}
						ref={otherRef}
						value={draft.other}
						placeholder={t.askOtherPlaceholder}
						aria-label={t.askOther}
						maxLength={4000}
						onChange={(event) => setOther(event.target.value)}
					/>
					{mark(Boolean(draft.other.trim()))}
				</label>
			</div>
			<div className="pw-ask-foot">
				<span className="pw-ask-hint">{t.askWaitHint}</span>
				<button type="button" className="pw-ask-skip" onClick={() => onAnswer(dialog.id, { cancelled: true })}>
					{t.askSkip}
				</button>
				<button type="button" className="btn-primary-white" style={{ height: 30, padding: "0 16px", fontSize: 13 }} disabled={primaryDisabled} onClick={primary}>
					{primaryLabel}
				</button>
			</div>
		</section>
	);
}
