/** Browser-safe metadata; template bodies are read only when the user opens a file. */
export interface PromptTemplateView {
	name: string;
	description: string;
	argumentHint?: string;
	filePath: string;
	scope: "user" | "project" | "temporary";
	origin: "top-level" | "package";
	sourceLabel: string;
	disabled: boolean;
	canToggle: boolean;
	canDelete: boolean;
	readError?: boolean;
}
