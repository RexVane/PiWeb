import { createContext } from "react";

/**
 * 对话区的贴底状态，交给流式正文用。
 *
 * 流式正文每帧往下长一点，长完要不要跟着滚到底，只能听对话区的：它按 96px 判断贴底、
 * 用户往上翻（或大纲 / 搜索在平滑跳转）就松开。正文自己再量一遍距离、另设阈值，
 * 两边说法不一，就会把已经翻上去的人拽回来、把刚起步的平滑跳转打断。
 * 不在对话区里（没有 Provider）就不贴底。
 */
export interface ChatScroll {
	/** 现在是否贴着底部（读的是对话区的同一个 ref，不另做判断） */
	shouldPin(): boolean;
	/** 立刻贴到底部 */
	pin(): void;
}

export const ChatScrollContext = createContext<ChatScroll | null>(null);
