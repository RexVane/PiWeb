"use client";

/**
 * 正文（Markdown）里可交互元素的接线。
 *
 * 用 context 而不是逐层传 props：MarkdownBlock 在对话正文、轨迹详情、提示词面板等处复用，
 * 中间隔着好几层，逐层透传会把签名污染到与之无关的组件上。
 * 没有 Provider 时（例如文件查看器里渲染 Markdown）这些交互自然不生效，正文照常显示。
 */
import { createContext, useContext } from "react";

export interface MarkdownActions {
	/** 用文件查看器打开项目内路径；没有工作区时不给（此时路径只作展示） */
	openFile?: (path: string) => void;
}

const MarkdownActionsContext = createContext<MarkdownActions>({});

export const MarkdownActionsProvider = MarkdownActionsContext.Provider;

export function useMarkdownActions(): MarkdownActions {
	return useContext(MarkdownActionsContext);
}
