/**
 * Windows isolation uses a different LPAC AppContainer SID for every sandbox.
 * Only that SID receives Modify access to the allowed physical roots. Existing
 * integrity labels and other users' ACL entries are never changed.
 *
 * Child processes can read explicitly allowed roots; SDK reads retain the host's
 * access. Network access is enabled, while broad application-package grants are opted out.
 */
import fs from "node:fs/promises";
import { readdirSync, lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const POLL_MS = 25;
const OUTPUT_LIMIT = 8 * 1024 * 1024;
// Windows defines DISABLE_MAX_PRIVILEGE as 0x1; SANDBOX_INERT is 0x2.
const DISABLE_MAX_PRIVILEGE = 0x1;
const INTERNAL_ENV = new Set(["PI_WEB_LAUNCH_TOKEN", "PI_WEB_SECRET", "PI_WEB_SECRET_FILE", "PI_WEB_PASSWORD", "PIWEB_BUILD_LOCK_TOKEN", "PIWEB_BUILD_LOCK_FILE", "PIWEB_PROCESS_LOCK_TOKEN", "PIWEB_PROCESS_LOCK_FILE"]);
const NODE_LAUNCH_ENV = new Set(["NODE_OPTIONS", "NODE_PATH"]);
function privateEnvironmentKey(key: string): boolean {
	return INTERNAL_ENV.has(key.toUpperCase()) || /(?:^|_)(?:API_?KEY|ACCESS_?KEY(?:_ID)?|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)(?:_|$)/i.test(key);
}

export interface AclSandboxOptions {
	writableDirs: string[];
	readableDirs?: string[];
	/** Parent for a unique scratch directory; null means scratch is not writable. */
	tempDir?: string | null;
	shell?: SandboxShell;
	spawnRestricted?: RestrictedSpawner;
}
export interface SandboxShell {
	path: string;
	transport: "argv" | "script";
	scriptExt?: ".sh";
}
export interface AclSandboxExecOptions {
	cwd: string;
	onData?: (chunk: Buffer) => void;
	signal?: AbortSignal;
	timeout?: number;
	env?: Record<string, string>;
}
export interface AclSandboxExecResult {
	exitCode: number | null;
	timedOut?: boolean;
	aborted?: boolean;
	outputLimitExceeded?: boolean;
}
export interface AclSandbox {
	readonly available: true;
	readonly tempDir: string;
	exec(command: string, options: AclSandboxExecOptions): Promise<AclSandboxExecResult>;
	/** script exports one CommonJS function; its JSON return value is captured from stdout. */
	runNode(script: string, input: unknown, options: AclSandboxExecOptions): Promise<AclSandboxExecResult & { output: string }>;
	dispose(): Promise<void>;
}
export interface RestrictedSpawnInput {
	commandLine: string;
	application?: string;
	cwd: string;
	env?: Record<string, string>;
}
export interface RestrictedProcessHandle {
	pid: number;
	exitCode: () => number | null;
	read: (maxBytes: number) => Buffer[];
	kill: () => void;
	close: () => void;
}
export type RestrictedSpawner = (input: RestrictedSpawnInput) => RestrictedProcessHandle;

export interface SandboxCapability {
	available: boolean;
	backend: "windows-appcontainer" | null;
	unsupportedReason?: string;
}
let lastCreationFailure: string | undefined;
async function loadKoffi(): Promise<typeof import("koffi")> {
	const mod = await import("koffi");
	return (mod as unknown as { default?: typeof import("koffi") }).default ?? mod;
}
export interface Win32DesktopApi {
	stationName(): string | null;
	threadDesktopName(): string | null;
	canOpenDesktop(name: string): boolean;
}

/**
 * 宿主受限子桌面（如 Antigravity 的 `WinSta0\exebox-*`）能跑普通子进程，但 AppContainer 的
 * `USER32.dll` 初始化会在这种桌面上直接以 `0xC0000142` (`STATUS_DLL_INIT_FAILED`) 退出。
 * 当当前仍在 `WinSta0` 内、处于非 `Default` 桌面且 `WinSta0\Default` 可打开时，把子进程切回 `WinSta0\Default`。
 */
export function selectAppContainerDesktop(api: Win32DesktopApi): string | null {
	const station = api.stationName();
	const desktop = api.threadDesktopName();
	if (!station || !desktop) return null;
	if (station.toLowerCase() !== "winsta0") return null;
	if (desktop.toLowerCase() === "default") return null;
	return api.canOpenDesktop("Default") ? "WinSta0\\Default" : null;
}

/** 从 Win32 WindowStation / Desktop 对象句柄读取对象名 (`UOI_NAME = 2`)。 */
function readUserObjectName(
	GetUserObjectInformationW: (hObj: unknown, nIndex: number, pvInfo: Buffer, nLength: number, lpnLengthNeeded: Buffer) => number,
	handle: unknown,
): string | null {
	if (!handle) return null;
	const nameBuf = Buffer.alloc(512);
	const neededBuf = Buffer.alloc(4);
	if (!GetUserObjectInformationW(handle, 2, nameBuf, nameBuf.length, neededBuf)) return null;
	const bytes = neededBuf.readUInt32LE(0);
	if (bytes < 2 || bytes > nameBuf.length) return null;
	return nameBuf.subarray(0, bytes).toString("utf16le").replace(/\0+$/, "") || null;
}

let cachedDesktopResolved = false;
let cachedDesktopBuffer: Buffer | null = null;

function getAppContainerDesktopBuffer(koffiModule: { load(name: string): { func(sig: string): (...args: never[]) => unknown } }): Buffer | null {
	if (cachedDesktopResolved) return cachedDesktopBuffer;
	cachedDesktopResolved = true;
	try {
		const user32 = koffiModule.load("user32.dll");
		const kernel32 = koffiModule.load("kernel32.dll");
		const GetProcessWindowStation = user32.func("void* GetProcessWindowStation()") as () => unknown;
		const GetCurrentThreadId = kernel32.func("uint32 GetCurrentThreadId()") as () => number;
		const GetThreadDesktop = user32.func("void* GetThreadDesktop(uint32 dwThreadId)") as (tid: number) => unknown;
		const GetUserObjectInformationW = user32.func(
			"int GetUserObjectInformationW(void* hObj, int nIndex, uint8* pvInfo, uint32 nLength, uint8* lpnLengthNeeded)",
		) as (hObj: unknown, nIndex: number, pvInfo: Buffer, nLength: number, lpnLengthNeeded: Buffer) => number;
		const OpenDesktopW = user32.func("void* OpenDesktopW(str16 lpszDesktop, uint32 dwFlags, int fInherit, uint32 dwDesiredAccess)") as (
			name: string,
			flags: number,
			inherit: number,
			access: number,
		) => unknown;
		const CloseDesktop = user32.func("int CloseDesktop(void* hDesktop)") as (handle: unknown) => number;

		const selected = selectAppContainerDesktop({
			stationName: () => readUserObjectName(GetUserObjectInformationW, GetProcessWindowStation()),
			threadDesktopName: () => readUserObjectName(GetUserObjectInformationW, GetThreadDesktop(GetCurrentThreadId())),
			canOpenDesktop: (name) => {
				const handle = OpenDesktopW(name, 0, 0, 0x00020000);
				if (!handle) return false;
				CloseDesktop(handle);
				return true;
			},
		});
		cachedDesktopBuffer = selected ? Buffer.from(`${selected}\0`, "utf16le") : null;
	} catch {
		cachedDesktopBuffer = null;
	}
	return cachedDesktopBuffer;
}

export function formatAclProbeFailure(result: { exitCode: number | null; output: string }): string {
	const detail = result.output.trim();
	const codeLabel = result.exitCode === null
		? "unknown exit code"
		: result.exitCode > 0xffff || result.exitCode < 0
			? `exit code ${result.exitCode} (0x${(result.exitCode >>> 0).toString(16).toUpperCase().padStart(8, "0")})`
			: `exit code ${result.exitCode}`;
	return detail
		? `Isolated Node runtime could not start: ${detail} (${codeLabel})`
		: `Isolated Node runtime could not start: ${codeLabel}`;
}

export async function probeAclSandboxCapability(): Promise<SandboxCapability> {
	if (process.platform !== "win32") return { available: false, backend: null, unsupportedReason: "File-write isolation requires Windows." };
	if (process.arch !== "x64") return { available: false, backend: null, unsupportedReason: "The Windows isolation backend currently requires x64." };
	try {
		const sandbox = await createAclSandbox({ writableDirs: [], tempDir: null });
		if (!sandbox) throw new Error(lastCreationFailure ?? "Could not create the isolated runtime.");
		try {
			const result = await sandbox.runNode("module.exports=()=>process.version;", null, { cwd: sandbox.tempDir, timeout: 5000 });
			if (result.exitCode !== 0) throw new Error(formatAclProbeFailure(result));
		} finally { await sandbox.dispose(); }
		return { available: true, backend: "windows-appcontainer" };
	} catch (error) {
		return { available: false, backend: null, unsupportedReason: error instanceof Error ? error.message : String(error) };
	}
}

/** Do not grant a file object that already has an alias outside its directory. */
async function checkPhysicalRoot(root: string): Promise<void> {
	if (path.resolve(root).toLowerCase() !== (await fs.realpath(root)).toLowerCase()) throw new Error("Writable root must be a physical directory.");
	const stat = await fs.lstat(root);
	if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Writable root must be a physical directory.");
	const pendingDirectories = [root];
	while (pendingDirectories.length) {
		const directory = pendingDirectories.pop()!;
		let checks: Promise<void>[] = [];
		let failure: unknown;
		// Streaming enumeration and bounded parallel stats avoid one serialized I/O
		// round trip per dependency, without skipping any object receiving the ACE.
		for await (const entry of await fs.opendir(directory)) {
			checks.push((async () => {
				const target = path.join(directory, entry.name);
				const item = await fs.lstat(target);
				if (item.isSymbolicLink()) return; // Never follow a junction.
				if (item.isDirectory()) pendingDirectories.push(target);
				else if (item.isFile() && item.nlink > 1) throw new Error("Writable roots containing hard-linked files cannot be isolated safely. File tools can still edit ordinary source files; shell execution needs a workspace without shared hard links or explicit full permission.");
			})().catch((error) => { failure ??= error; }));
			if (checks.length === 32) { await Promise.all(checks); if (failure) throw failure; checks = []; }
		}
		await Promise.all(checks);
		if (failure) throw failure;
	}
}
function quoteArgument(value: string): string {
	return '"' + value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/g, "$1$1") + '"';
}

export async function createAclSandbox(options: AclSandboxOptions): Promise<AclSandbox | null> {
	if (process.platform !== "win32" || process.arch !== "x64") return null;
	let backend: ReturnType<typeof createWin32Backend> | undefined;
	let scratch: string | undefined;
	let disposed = false;
	let disposal: Promise<void> | undefined;
	const active = new Map<Promise<unknown>, AbortController>();
	const granted: Array<() => void> = [];
	const cleanup = async () => {
		const errors: unknown[] = [];
		for (const revoke of granted.reverse()) try { revoke(); } catch (error) { errors.push(error); }
		try { backend?.close(); } catch (error) { errors.push(error); }
		if (scratch) try { await fs.rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }); } catch (error) { errors.push(error); }
		if (errors.length) throw new AggregateError(errors, "Could not fully clean up Windows isolation.");
	};
	try {
		backend = createWin32Backend(await loadKoffi(), options.writableDirs.length > 0 && options.tempDir !== null);
		const tempParent = options.tempDir ?? os.tmpdir();
		await fs.mkdir(tempParent, { recursive: true });
		scratch = await fs.mkdtemp(path.join(tempParent, "piweb-sandbox-"));
		for (const root of [...new Set(options.writableDirs.map((dir) => path.resolve(dir)))]) {
			await checkPhysicalRoot(root);
			granted.push(backend.grantRoot(root));
		}
		for (const root of options.readableDirs ?? []) {
			if (options.writableDirs.some((writable) => path.resolve(writable).toLowerCase() === path.resolve(root).toLowerCase())) continue;
			if (path.resolve(root).toLowerCase() !== (await fs.realpath(root)).toLowerCase()) throw new Error("Readable root must be physical.");
			granted.push(backend.grantRoot(root, 0x1200a9));
		}
		granted.push(backend.grantRoot(scratch, options.tempDir !== null && options.writableDirs.length > 0 ? 0x1301bf : 0x1200a9));
		// A user-installed Node executable need not be readable by an AppContainer.
		// Copy the fixed runtime into the private root rather than modifying its install ACL.
		const nodeRuntime = path.join(scratch, "node.exe");
		await fs.copyFile(process.execPath, nodeRuntime);
		const scratchDir = scratch;
		const spawner = options.spawnRestricted ?? backend.spawn;
		const configuredShell = options.shell ?? { path: "cmd.exe", transport: "argv" as const };
		const shell = configuredShell.path.toLowerCase() === "cmd.exe"
			? { ...configuredShell, path: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe") }
			: configuredShell;
		if (shell.transport === "script" && !options.spawnRestricted) {
			throw new Error("Native MSYS/Git Bash requires global objects that are not available in the isolated runtime. Use cmd.exe.");
		}

		const execute = (prepare: () => Promise<RestrictedSpawnInput & { files: string[] }>, execOptions: AclSandboxExecOptions): Promise<AclSandboxExecResult> => {
			if (disposed) return Promise.reject(new Error("sandbox is disposed"));
			const abort = new AbortController();
			const forwardAbort = () => abort.abort();
			if (execOptions.signal?.aborted) abort.abort();
			execOptions.signal?.addEventListener("abort", forwardAbort, { once: true });
			const files: string[] = [];
			let handle: RestrictedProcessHandle | undefined;
			const task = (async () => {
				const startedAt = Date.now();
				try {
					if (abort.signal.aborted) return { exitCode: null, aborted: true };
					const input = await prepare();
					files.push(...input.files);
					if (abort.signal.aborted) return { exitCode: null, aborted: true };
					handle = spawner(input);
					let total = 0;
					// 超限后继续排空管道但不再转发：命令不会因为写满管道而卡住，也不会被杀掉
					const flush = (final = false) => {
						let budget = final ? Infinity : 4 * 1024 * 1024;
						while (budget > 0) {
							const chunks = handle!.read(Math.min(budget, 1024 * 1024));
							if (!chunks.length) break;
							for (const chunk of chunks) {
								if (total < OUTPUT_LIMIT) execOptions.onData?.(chunk.subarray(0, OUTPUT_LIMIT - total));
								total += chunk.length;
								budget -= chunk.length;
							}
						}
						return total > OUTPUT_LIMIT;
					};
					for (;;) {
						if (abort.signal.aborted) { handle.kill(); flush(true); return { exitCode: null, aborted: true }; }
						if (execOptions.timeout && Date.now() - startedAt >= execOptions.timeout) {
							handle.kill(); flush(true); return { exitCode: null, timedOut: true };
						}
						flush();
						const exit = handle.exitCode();
						if (exit !== null) {
							// A shell may leave detached/background children. The command owns all of them.
							handle.kill();
							return flush(true) ? { exitCode: exit, outputLimitExceeded: true } : { exitCode: exit };
						}
						await new Promise((resolve) => setTimeout(resolve, POLL_MS));
					}
				} finally {
					try { handle?.close(); }
					finally {
						execOptions.signal?.removeEventListener("abort", forwardAbort);
						for (const file of files) await fs.rm(file, { force: true }).catch(() => undefined);
					}
				}
			})();
			active.set(task, abort);
			void task.then(() => active.delete(task), () => active.delete(task));
			return task;
		};
		const sandbox: AclSandbox = {
			available: true,
			tempDir: scratchDir,
			exec(command, execOptions) {
				return execute(async () => {
					if (shell.transport === "argv") {
						return { commandLine: quoteArgument(shell.path) + ' /d /s /c "' + command + '"', application: shell.path, cwd: execOptions.cwd, env: execOptions.env, files: [] };
					}
					const scriptPath = path.join(scratchDir, randomUUID() + (shell.scriptExt ?? ".sh"));
					await fs.writeFile(scriptPath, command + "\n", "utf8");
					return { commandLine: quoteArgument(shell.path) + " " + quoteArgument(scriptPath), application: shell.path, cwd: execOptions.cwd, env: execOptions.env, files: [scriptPath] };
				}, execOptions);
			},
			async runNode(script, input, execOptions) {
				const chunks: Buffer[] = [];
				const result = await execute(async () => {
					const scriptPath = path.join(scratchDir, randomUUID() + ".cjs");
					const inputPath = path.join(scratchDir, randomUUID() + ".json");
					try {
						const loader = '\nPromise.resolve().then(() => module.exports(JSON.parse(require("node:fs").readFileSync(process.argv[2], "utf8")))).then((value) => { if(value !== undefined) process.stdout.write(typeof value === "string" ? value : JSON.stringify(value)); }, (error) => { console.error(error && error.stack || String(error)); process.exitCode = 1; });\n';
						await fs.writeFile(scriptPath, script + loader, "utf8");
						await fs.writeFile(inputPath, JSON.stringify(input), "utf8");
					} catch (error) {
						await Promise.allSettled([fs.rm(scriptPath, { force: true }), fs.rm(inputPath, { force: true })]);
						throw error;
					}
					// The private helper has a fixed loader. Host launchers may inject
					// NODE_OPTIONS preloads or NODE_PATH entries inaccessible to its token.
					return { commandLine: [nodeRuntime, "--preserve-symlinks", "--preserve-symlinks-main", scriptPath, inputPath].map(quoteArgument).join(" "), application: nodeRuntime, cwd: execOptions.cwd, env: { ...execOptions.env, NODE_OPTIONS: "", NODE_PATH: "" }, files: [scriptPath, inputPath] };
				}, { ...execOptions, onData: (chunk) => { chunks.push(chunk); execOptions.onData?.(chunk); } });
				return { ...result, output: Buffer.concat(chunks).toString("utf8") };
			},
			dispose() {
				if (disposal) return disposal;
				disposed = true;
				disposal = (async () => {
					for (const abort of active.values()) abort.abort();
					await Promise.allSettled([...active.keys()]);
					await cleanup();
				})();
				return disposal;
			},
		};
		return sandbox;
	} catch (error) {
		lastCreationFailure = error instanceof Error ? error.message : String(error);
		await cleanup().catch(() => undefined);
		console.warn("[piweb] Windows file-write isolation unavailable:", error instanceof Error ? error.message : String(error));
		return null;
	}
}

/** All structures below are explicitly x64; the public entrypoints reject other architectures. */
function createWin32Backend(koffi: typeof import("koffi"), writableTemp: boolean) {
	const kernel32 = koffi.load("kernel32.dll");
	const advapi32 = koffi.load("advapi32.dll");
	const userenv = koffi.load("userenv.dll");
	const ole32 = koffi.load("ole32.dll");
	const kernelbase = koffi.load("kernelbase.dll");
	const GetCurrentProcess = kernel32.func("void *GetCurrentProcess()");
	const OpenProcessToken = advapi32.func("bool OpenProcessToken(void *process, uint32 access, void *outToken)");
	const CreateRestrictedToken = advapi32.func("bool CreateRestrictedToken(void *existing, uint32 flags, uint32 disableCount, void *disableSids, uint32 privilegeCount, void *privileges, uint32 restrictCount, void *restrictSids, void *outToken)");
	const CreateProcessAsUserW = advapi32.func("bool CreateProcessAsUserW(void *token, str16 app, str16 cmdline, void *pa, void *ta, bool inherit, uint32 flags, void *env, str16 cwd, void *startup, void *processInfo)");
	const CreateFileW = kernel32.func("void *CreateFileW(str16 name, uint32 access, uint32 share, void *attributes, uint32 disposition, uint32 flags, void *template)");
	const GetSecurityInfo = advapi32.func("uint32 GetSecurityInfo(void *handle, uint32 type, uint32 info, void *owner, void *group, void *dacl, void *sacl, void *sd)");
	const SetEntriesInAclW = advapi32.func("uint32 SetEntriesInAclW(uint32 count, void *entries, void *oldAcl, void *newAcl)");
	const SetSecurityInfo = advapi32.func("uint32 SetSecurityInfo(void *handle, uint32 type, uint32 info, void *owner, void *group, void *dacl, void *sacl)");
	const CreateJobObjectW = kernel32.func("void *CreateJobObjectW(void *attributes, str16 name)");
	const SetInformationJobObject = kernel32.func("bool SetInformationJobObject(void *job, int infoClass, void *info, uint32 length)");
	const AssignProcessToJobObject = kernel32.func("bool AssignProcessToJobObject(void *job, void *process)");
	const TerminateJobObject = kernel32.func("bool TerminateJobObject(void *job, uint32 code)");
	const ResumeThread = kernel32.func("uint32 ResumeThread(void *thread)");
	const GetExitCodeProcess = kernel32.func("bool GetExitCodeProcess(void *process, void *outCode)");
	const TerminateProcess = kernel32.func("bool TerminateProcess(void *process, uint32 code)");
	const WaitForSingleObject = kernel32.func("uint32 WaitForSingleObject(void *handle, uint32 ms)");
	const CloseHandle = kernel32.func("bool CloseHandle(void *handle)");
	const LocalFree = kernel32.func("void *LocalFree(void *p)");
	const GetLastError = kernel32.func("uint32 GetLastError()");
	const CreateMutexW = kernel32.func("void *CreateMutexW(void *attributes, bool owner, str16 name)");
	const ReleaseMutex = kernel32.func("bool ReleaseMutex(void *mutex)");
	const CreatePipe = kernel32.func("bool CreatePipe(void *readHandle, void *writeHandle, void *attributes, uint32 size)");
	const SetHandleInformation = kernel32.func("bool SetHandleInformation(void *handle, uint32 mask, uint32 flags)");
	const PeekNamedPipe = kernel32.func("bool PeekNamedPipe(void *pipe, void *buffer, uint32 size, void *read, void *available, void *remaining)");
	const ReadFile = kernel32.func("bool ReadFile(void *file, void *buffer, uint32 size, void *read, void *overlapped)");
	const InitializeProcThreadAttributeList = kernel32.func("bool InitializeProcThreadAttributeList(void *list, uint32 count, uint32 flags, void *size)");
	const UpdateProcThreadAttribute = kernel32.func("bool UpdateProcThreadAttribute(void *list, uint32 flags, uintptr attribute, void *value, uintptr size, void *previous, void *returnSize)");
	const DeleteProcThreadAttributeList = kernel32.func("void DeleteProcThreadAttributeList(void *list)");
	const CreateAppContainerProfile = userenv.func("int32 CreateAppContainerProfile(str16 name, str16 display, str16 description, void *capabilities, uint32 count, void *sid)");
	const DeleteAppContainerProfile = userenv.func("int32 DeleteAppContainerProfile(str16 name)");
	const GetAppContainerFolderPath = userenv.func("int32 GetAppContainerFolderPath(str16 sid, void *folder)");
	const ConvertSidToStringSidW = advapi32.func("bool ConvertSidToStringSidW(void *sid, void *stringSid)");
	const CoTaskMemFree = ole32.func("void CoTaskMemFree(void *memory)");
	const DeriveCapabilitySidsFromName = kernelbase.func("bool DeriveCapabilitySidsFromName(str16 name, void *groupSids, void *groupCount, void *capabilitySids, void *capabilityCount)");

	const pointer = (buffer: Buffer, offset = 0) => Number(buffer.readBigUInt64LE(offset));
	const address = (handle: unknown): bigint => typeof handle === "number" || typeof handle === "bigint" ? BigInt(handle) : BigInt(koffi.address(handle));
	const valid = (handle: unknown) => Boolean(handle) && address(handle) !== 0xffffffffffffffffn;
	const check = (ok: unknown, name: string) => { if (!ok) throw new Error(name + " failed (Windows error " + GetLastError() + ")."); };
	const close = (handle: unknown) => { if (valid(handle)) CloseHandle(handle); };
	const profileName = "piweb-" + randomUUID();
	const sidHolder = Buffer.alloc(8);
	const profileError = CreateAppContainerProfile(profileName, profileName, "PiWeb isolated command", null, 0, sidHolder);
	if (profileError < 0) throw new Error("CreateAppContainerProfile failed (HRESULT " + profileError + ").");
	const sid = pointer(sidHolder);
	let profilePath: string;
	let token = 0;
	try {
		const stringHolder = Buffer.alloc(8);
		check(ConvertSidToStringSidW(sid, stringHolder), "ConvertSidToStringSidW");
		try {
			const sidString = koffi.decode(pointer(stringHolder), "char16_t", -1) as string;
			const folder = Buffer.alloc(8);
			const folderError = GetAppContainerFolderPath(sidString, folder);
			if (folderError < 0) throw new Error("GetAppContainerFolderPath failed (HRESULT " + folderError + ").");
			try { profilePath = koffi.decode(pointer(folder), "char16_t", -1) as string; }
			finally { CoTaskMemFree(pointer(folder)); }
		} finally { LocalFree(pointer(stringHolder)); }
		const original = Buffer.alloc(8), restricted = Buffer.alloc(8);
		check(OpenProcessToken(GetCurrentProcess(), 0xf01ff, original), "OpenProcessToken");
		try {
			check(CreateRestrictedToken(pointer(original), DISABLE_MAX_PRIVILEGE, 0, null, 0, null, 0, null, restricted), "CreateRestrictedToken");
			token = pointer(restricted);
		} finally { close(pointer(original)); }
	} catch (error) { close(token); LocalFree(sid); DeleteAppContainerProfile(profileName); throw error; }
	const capabilitySids: number[] = [];
	try {
		for (const name of ["internetClient", "lpacNetwork", "registryRead"]) {
			const groupArray = Buffer.alloc(8), groupCount = Buffer.alloc(4);
			const capArray = Buffer.alloc(8), capCount = Buffer.alloc(4);
			check(DeriveCapabilitySidsFromName(name, groupArray, groupCount, capArray, capCount), "DeriveCapabilitySidsFromName");
			try {
				for (let index = 0; index < groupCount.readUInt32LE(); index++) {
					const item = koffi.decode(pointer(groupArray) + index * 8, "uintptr") as number;
					LocalFree(item);
				}
				for (let index = 0; index < capCount.readUInt32LE(); index++) {
					const capability = Number(koffi.decode(pointer(capArray) + index * 8, "uintptr"));
					capabilitySids.push(capability);
				}
			} finally { LocalFree(pointer(groupArray)); LocalFree(pointer(capArray)); }
		}
	} catch (error) {
		for (const capability of capabilitySids) LocalFree(capability);
		close(token); LocalFree(sid); DeleteAppContainerProfile(profileName); throw error;
	}
	const capabilityEntries = Buffer.alloc(capabilitySids.length * 16);
	capabilitySids.forEach((capability, index) => {
		capabilityEntries.writeBigUInt64LE(BigInt(capability), index * 16);
		capabilityEntries.writeUInt32LE(4, index * 16 + 8); // SE_GROUP_ENABLED
	});

	const inheritable = Buffer.alloc(24);
	inheritable.writeUInt32LE(24, 0);
	inheritable.writeUInt32LE(1, 16);
	let closed = false;
	const aclMutex = CreateMutexW(null, false, "Local\\PiWebSandboxDaclV2");
	if (!valid(aclMutex)) {
		close(token); LocalFree(sid);
		for (const capability of capabilitySids) LocalFree(capability);
		DeleteAppContainerProfile(profileName);
		throw new Error("Could not serialize sandbox ACL changes.");
	}
	const grantRoot = (root: string, permission = 0x1301bf, initialMode = 1): (() => void) & { refresh: () => void } => {
		// A handle without FILE_SHARE_DELETE pins the physical root until revocation.
		// Include FILE_LIST_DIRECTORY: metadata-only access does not participate
		// in sharing checks and cannot prevent a root rename.
		const directory = CreateFileW(root, 0x1 | 0x00020000 | 0x00040000, 0x1 | 0x2, null, 3, 0x02000000 | 0x00200000, null);
		check(valid(directory), "Open writable root");
		const update = (mode: number) => {
			const acquired = WaitForSingleObject(aclMutex, 5000);
			if (acquired !== 0 && acquired !== 0x80) throw new Error("Timed out coordinating sandbox ACL changes.");
			const oldAcl = Buffer.alloc(8);
			const descriptor = Buffer.alloc(8);
			let newAcl = 0;
			try {
				const error = GetSecurityInfo(directory, 1, 4, null, null, oldAcl, null, descriptor);
				if (error) throw new Error("GetSecurityInfo failed (Windows error " + error + ").");
				const entry = Buffer.alloc(48); // EXPLICIT_ACCESS_W
				entry.writeUInt32LE(permission, 0); // Modify excludes WRITE_DAC/WRITE_OWNER
				entry.writeUInt32LE(mode, 4);
				entry.writeUInt32LE(3, 8); // OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE
				entry.writeBigUInt64LE(BigInt(sid), 40); // TRUSTEE_IS_SID
				const result = Buffer.alloc(8);
				const aclError = SetEntriesInAclW(1, entry, pointer(oldAcl), result);
				if (aclError) throw new Error("SetEntriesInAclW failed (Windows error " + aclError + ").");
				newAcl = pointer(result);
				const setError = SetSecurityInfo(directory, 1, 4, null, null, newAcl, null);
				if (setError) throw new Error("SetSecurityInfo failed (Windows error " + setError + ").");
			} finally {
				if (newAcl) LocalFree(newAcl);
				if (pointer(descriptor)) LocalFree(pointer(descriptor));
				ReleaseMutex(aclMutex);
			}
		};
		try { update(initialMode); }
		catch (error) { close(directory); throw error; }
		let revoked = false;
		return Object.assign(() => {
			if (revoked) return;
			try { update(4); revoked = true; }
			finally { close(directory); }
		}, { refresh: () => update(initialMode) });
	};
	// Replace the profile's broad package-SID grant with RX. Only a writable
	// sandbox's own AC/Temp subtree gets Modify; readonly's profile remains RX.
	const profileRevocations = new Map<string, ReturnType<typeof grantRoot>>();
	const denyProfile = (directory: string) => {
		const current = profileRevocations.get(directory);
		if (current) current.refresh();
		else {
			const relative = path.relative(path.join(profilePath!, "Temp"), directory);
			const inPrivateTemp = relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative));
			profileRevocations.set(directory, grantRoot(directory, writableTemp && inPrivateTemp ? 0x1301bf : 0x1200a9, 2));
		}
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const child = path.join(directory, entry.name);
			if (entry.isDirectory() && !lstatSync(child).isSymbolicLink()) denyProfile(child);
		}
	};
	try { denyProfile(path.dirname(profilePath!)); }
	catch (error) {
		for (const revoke of [...profileRevocations.values()].reverse()) revoke();
		for (const capability of capabilitySids) LocalFree(capability);
		close(aclMutex);
		close(token); LocalFree(sid); DeleteAppContainerProfile(profileName); throw error;
	}
	const spawn: RestrictedSpawner = ({ commandLine, application, cwd, env }) => {
		const held: unknown[] = [];
		let attrList: Buffer | undefined;
		let attrInitialized = false;
		let job: unknown;
		let child: unknown;
		let thread: unknown;
		let transferred = false;
		try {
			const makePipe = () => {
				const read = Buffer.alloc(8), write = Buffer.alloc(8);
				check(CreatePipe(read, write, inheritable, 65536), "CreatePipe");
				const readHandle = pointer(read), writeHandle = pointer(write);
				held.push(readHandle, writeHandle);
				check(SetHandleInformation(readHandle, 1, 0), "SetHandleInformation");
				return { read: readHandle, write: writeHandle };
			};
			const out = makePipe(), err = makePipe();
			const stdin = CreateFileW("NUL", 0x80000000, 0x1 | 0x2, inheritable, 3, 0x80, null);
			check(valid(stdin), "Open stdin");
			held.push(stdin);
			job = CreateJobObjectW(null, null);
			check(valid(job), "CreateJobObjectW");
			const limits = Buffer.alloc(144);
			limits.writeUInt32LE(0x2000, 16); // KILL_ON_JOB_CLOSE, no breakaway
			check(SetInformationJobObject(job, 9, limits, limits.length), "SetInformationJobObject");
			const attrSize = Buffer.alloc(8);
			InitializeProcThreadAttributeList(null, 3, 0, attrSize);
			attrList = Buffer.alloc(pointer(attrSize));
			check(InitializeProcThreadAttributeList(attrList, 3, 0, attrSize), "InitializeProcThreadAttributeList");
			attrInitialized = true;
			const handles = Buffer.alloc(24);
			[stdin, out.write, err.write].forEach((handle, index) => handles.writeBigUInt64LE(address(handle), index * 8));
			check(UpdateProcThreadAttribute(attrList, 0, 0x20002, handles, handles.length, null, null), "UpdateProcThreadAttribute");
			const capabilities = Buffer.alloc(24);
			capabilities.writeBigUInt64LE(BigInt(sid), 0);
			capabilities.writeBigUInt64LE(BigInt(koffi.address(capabilityEntries)), 8);
			capabilities.writeUInt32LE(capabilitySids.length, 16);
			check(UpdateProcThreadAttribute(attrList, 0, 0x20009, capabilities, capabilities.length, null, null), "AppContainer security capabilities");
			const packagePolicy = Buffer.alloc(4); packagePolicy.writeUInt32LE(1);
			// LPAC opts out of broad ALL_APPLICATION_PACKAGES grants.
			check(UpdateProcThreadAttribute(attrList, 0, 0x2000f, packagePolicy, packagePolicy.length, null, null), "AppContainer package policy");
			const startup = Buffer.alloc(112);
			startup.writeUInt32LE(startup.length, 0);
			const desktopBuffer = getAppContainerDesktopBuffer(koffi);
			if (desktopBuffer) startup.writeBigUInt64LE(BigInt(koffi.address(desktopBuffer)), 16);
			startup.writeUInt32LE(0x100, 60);
			[stdin, out.write, err.write].forEach((handle, index) => startup.writeBigUInt64LE(address(handle), 80 + index * 8));
			startup.writeBigUInt64LE(BigInt(koffi.address(attrList)), 104);
			const environment = new Map<string, [string, string]>();
			for (const [key, value] of Object.entries(process.env)) {
				if (value !== undefined && !value.includes("\0") && !privateEnvironmentKey(key)) environment.set(key.toUpperCase(), [key, NODE_LAUNCH_ENV.has(key.toUpperCase()) ? "" : value]);
			}
			for (const [key, value] of Object.entries(env ?? {})) {
				if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) throw new Error("Invalid command environment.");
				if (privateEnvironmentKey(key)) continue;
				environment.set(key.toUpperCase(), [key, NODE_LAUNCH_ENV.has(key.toUpperCase()) ? "" : value]);
			}
			const entries = [...environment].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
			const environmentBlock = Buffer.from(entries.map(([, [key, value]]) => key + "=" + value).join("\0") + "\0\0", "utf16le");
			const info = Buffer.alloc(24);
			check(CreateProcessAsUserW(token, application ?? null, commandLine, null, null, true, 0x08000000 | 0x400 | 0x4 | 0x80000, environmentBlock, cwd, startup, info), "CreateProcessAsUserW");
			child = pointer(info);
			thread = pointer(info, 8);
			// AppContainer startup provisions protected Temp subdirectories. Reapply
			// the deny after provisioning, while no child instruction has run.
			denyProfile(path.dirname(profilePath!));
			check(AssignProcessToJobObject(job, child), "AssignProcessToJobObject");
			check(ResumeThread(thread) !== 0xffffffff, "ResumeThread");
			close(thread); thread = undefined;
			// Only read ends survive in the host. EOF works even after a background process.
			for (const handle of [stdin, out.write, err.write]) {
				close(handle);
				held.splice(held.indexOf(handle), 1);
			}
			const code = Buffer.alloc(4), available = Buffer.alloc(4), readCount = Buffer.alloc(4);
			let result: number | null = null;
			let processClosed = false;
			let terminated = false;
			const kill = () => {
				if (terminated) return;
				check(TerminateJobObject(job, 1), "TerminateJobObject");
				terminated = true;
				if (WaitForSingleObject(job, 5000) !== 0) throw new Error("Sandbox process tree did not terminate.");
			};
			transferred = true;
			return {
				pid: info.readUInt32LE(16),
				exitCode() {
					if (result !== null) return result;
					if (WaitForSingleObject(child, 0) !== 0) return null;
					check(GetExitCodeProcess(child, code), "GetExitCodeProcess");
					result = code.readUInt32LE(0);
					return result;
				},
				read(maxBytes) {
					const chunks: Buffer[] = [];
					let remaining = Math.max(0, maxBytes);
					for (const pipe of [out.read, err.read]) {
						while (remaining > 0) {
							if (!PeekNamedPipe(pipe, null, 0, null, available, null)) {
								if (GetLastError() === 109) break;
								throw new Error("PeekNamedPipe failed (Windows error " + GetLastError() + ").");
							}
							const size = Math.min(available.readUInt32LE(0), remaining, 65536);
							if (!size) break;
							const chunk = Buffer.allocUnsafe(size);
							check(ReadFile(pipe, chunk, size, readCount, null), "ReadFile");
							const count = readCount.readUInt32LE(0);
							if (!count) break;
							chunks.push(chunk.subarray(0, count));
							remaining -= count;
						}
					}
					return chunks;
				},
				kill,
				close() {
					if (processClosed) return;
					try { kill(); }
					finally {
						processClosed = true;
						close(child); close(job);
						for (const handle of held) close(handle);
					}
				},
			};
		} finally {
			if (attrInitialized) DeleteProcThreadAttributeList(attrList);
			if (!transferred) {
				if (valid(child)) { TerminateProcess(child, 1); WaitForSingleObject(child, 5000); }
				close(thread); close(child); close(job);
				for (const handle of held) close(handle);
			}
		}
	};
	return {
		spawn,
		grantRoot,
		close() {
			if (closed) return;
			closed = true;
			try {
				const errors: unknown[] = [];
				for (const revoke of [...profileRevocations.values()].reverse()) try { revoke(); } catch (error) { errors.push(error); }
				if (errors.length) throw new AggregateError(errors, "Could not clean up the isolated profile ACL.");
			}
			finally {
				close(token); LocalFree(sid);
				close(aclMutex);
				for (const capability of capabilitySids) LocalFree(capability);
				DeleteAppContainerProfile(profileName);
			}
		},
	};
}
