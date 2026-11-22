/** Public, data-only PiWeb resource protocol. Pi owns extension discovery and tool registration. */
export const RESOURCE_API_VERSION = 1 as const;
export const RESOURCE_FRAME_CHANNEL = "piweb-resource/v1" as const;
/** Optional, declarative browser capabilities. No feature-specific URLs or tool names. */
export const RESOURCE_BROWSER_CAPABILITIES = ["workspaces.list", "models.list", "sessions.open", "sessions.draft", "views.open"] as const;
export type ResourceBrowserCapability = typeof RESOURCE_BROWSER_CAPABILITIES[number];
export interface ResourceDialogIntent {
	type: "views.open";
	view: WebResourceView;
	cwd: string;
	sessionPath?: string;
	data: JsonValue;
}

export type ResourceType = "extensions" | "skills" | "prompts";
export type ResourceScope = "user" | "project";
export type ResourceCompatibility = "web" | "adapt" | "unknown";
/** Pi's own per-package resource filters; a market item may select just one part of a Git package. */
export interface ResourceSelection { extensions: string[]; skills: string[]; prompts: string[]; themes: string[] }
export type ResourcePlacement = "dialog" | "panel" | "settings" | "aboveEditor" | "belowEditor";
export type ResourceDialogMethod = "select" | "confirm" | "input" | "editor" | "web";
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ResourceView {
	id: string;
	title: string;
	/** 自带的各语言名称（zh / zh-Hant / en / ja / ru）；缺省时用 title */
	titles?: Partial<Record<"zh" | "zh-Hant" | "en" | "ja" | "ru", string>>;
	/** 侧栏入口图标名（白名单：clock / cube / chat / file / terminal / plugin）；缺省用 cube */
	icon?: string;
	capabilities?: ResourceBrowserCapability[];
	entry: string;
	placement: ResourcePlacement;
	/** Mount a request-free status view beside the composer. Only valid for aboveEditor/belowEditor. */
	autoMount?: boolean;
	/** Only explicit user selection makes this view the renderer of a standard Pi request. */
	methods: ResourceDialogMethod[];
}

export interface ResourceManifest {
	apiVersion: number;
	id: string;
	views: ResourceView[];
	/** A Node ESM entry exporting activate(host). It is never imported while listing resources. */
	host?: string;
}

export interface ResourcePackage {
	id: string;
	name: string;
	version: string;
	source: string;
	scope: ResourceScope;
	root: string;
	installRoot: string;
	/** Paths relative to the containing Pi package, used for its official resource filter. */
	extensionPaths: string[];
	/** All declared contributions owned by this feature/member, for its unified switch. */
	resourcePaths?: ResourceSelection;
	cwd: string;
	enabled: boolean;
	manifest?: ResourceManifest;
	error?: string;
}

/** Safe projection: no package filesystem roots, credentials, or executable source. */
export interface WebResourceView {
	id: string;
	resourceId: string;
	scope: ResourceScope;
	title: string;
	/** 资源自带的本地化名称，侧栏/标题优先用它 */
	titles?: Partial<Record<"zh" | "zh-Hant" | "en" | "ja" | "ru", string>>;
	/** 侧栏图标名（白名单）；缺省用 cube */
	icon?: string;
	capabilities?: ResourceBrowserCapability[];
	placement: ResourcePlacement;
	autoMount?: boolean;
	methods: ResourceDialogMethod[];
	url: string;
	/** Passive development preview: frame actions must not reach an installed backend. */
	preview?: boolean;
}

export interface ResourceCatalogItem {
	id: string;
	name: string;
	description: string;
	author: string;
	version: string;
	types: ResourceType[];
	compatibility: ResourceCompatibility;
	/** An actual Pi install source; omitted for a resource not yet published. */
	source?: string;
	selection?: ResourceSelection;
	repository?: string;
	apiVersion?: number;
}

export interface ResourceCatalog {
	version: 1;
	items: ResourceCatalogItem[];
}

export interface FeaturedExtension extends ResourceCatalogItem {
	installed: boolean;
}

export interface ResourcePreferences {
	developmentRoot?: string;
	catalogUrls: string[];
	/** method -> resource view id. Never chosen by tool name or installation order. */
	renderers: Partial<Record<ResourceDialogMethod, string>>;
}

export interface ResourceActionContext {
	cwd: string;
	scope?: ResourceScope;
	sessionPath?: string;
	signal?: AbortSignal;
}

export interface ResourceRunRequest {
	cwd: string;
	prompt: string;
	title?: string;
	model?: { provider: string; id: string };
	timeoutMs?: number;
	signal?: AbortSignal;
	/** Host-only callback; never accepted from an iframe or a JSON action request. */
	onSession?: (sessionPath: string) => void | Promise<void>;
}

export interface ResourceRunResult {
	sessionPath: string;
	status: "success" | "error";
	summary?: string;
	error?: string;
}

/** Injected into every installed host entry, first-party and third-party alike. */
export interface ResourceHostApi {
	apiVersion: 1;
	id: string;
	cwd: string;
	scope: ResourceScope;
	agentDir: string;
	dataDir: string;
	signal: AbortSignal;
	actions: {
		register(name: string, handler: (args: JsonValue, context: ResourceActionContext) => Promise<JsonValue> | JsonValue): () => void;
	};
	services: {
		register(name: string, start: (signal: AbortSignal) => Promise<(() => unknown) | void> | (() => unknown) | void): () => void;
	};
	storage: {
		read(name: string): Promise<JsonValue | undefined>;
		write(name: string, value: JsonValue): Promise<void>;
	};
	paths: { resolveWorkspace(value: string): Promise<string> };
	/** Optional additive v1 capability for an extension-owned workspace, never a private settings-file edit. */
	workspaces?: { register(cwd: string): Promise<string> };
	sessions: { run(request: ResourceRunRequest): Promise<ResourceRunResult> };
}

export type ResourceUiOutcome =
	| { status: "answered"; value: JsonValue }
	| { status: "cancelled" | "timeout" | "unavailable" };

export interface ResourceUiApi {
	apiVersion: 1;
	request(resourceId: string, viewId: string, data: JsonValue, options?: { title?: string; timeout?: number; signal?: AbortSignal }): Promise<ResourceUiOutcome>;
	invoke(resourceId: string, action: string, args?: JsonValue): Promise<JsonValue>;
	/** Optional v1 capability: uses this live session's SDK tool validation, hooks and permissions. Never exposed directly to a browser. */
	executeTool?(name: string, args: JsonValue, options?: { signal?: AbortSignal }): Promise<ResourceToolOutcome>;
}

export interface ResourceToolOutcome {
	isError: boolean;
	result: { content: unknown[]; details?: unknown };
}

export interface ResourceFrameContext {
	viewId: string;
	resourceId: string;
	scope: ResourceScope;
	cwd: string;
	sessionPath?: string;
	preview?: boolean;
	capabilities?: ResourceBrowserCapability[];
	/** Additive v1 frontend capability; older hosts omit it. */
	focusRequestSupported?: boolean;
	request?: JsonValue;
	data?: JsonValue;
}
