/** Serializable results from pi's terminal autocomplete provider. */
export interface FileCompletion {
	value: string;
	label: string;
	description?: string;
	text: string;
	cursor: number;
}

export interface FileCompletions {
	prefix: string;
	items: FileCompletion[];
}
