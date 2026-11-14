/** Approval binds to the complete tool invocation, including file contents and timeouts. */
export interface PermissionAction {
	toolName: string;
	input: unknown;
	toolCallId?: string;
}

function ordered(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(ordered);
	if (value && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, ordered(entry)]));
	}
	return value;
}

export function permissionActionKey(action: PermissionAction): string {
	return JSON.stringify([action.toolName, ordered(action.input)]);
}

export function permissionActionDescription(action: PermissionAction): string {
	return `${action.toolName} ${JSON.stringify(action.input)}`;
}
