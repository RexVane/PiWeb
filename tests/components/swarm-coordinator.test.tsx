// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SwarmCoordinatorPod } from "@/components/SwarmCoordinatorPod";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function response(data: unknown, ok = true, status = 200) {
	return {
		ok,
		status,
		json: async () => (ok ? { success: true, data } : { success: false, error: String(data) }),
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((yes) => { resolve = yes; });
	return { promise, resolve };
}

describe("SwarmCoordinatorPod prerequisites and launch validation", () => {
	it("does not show a previous workspace's late Git status or job history", async () => {
		const oldGit = deferred<ReturnType<typeof response>>();
		const oldHistory = deferred<ReturnType<typeof response>>();
		vi.stubGlobal("fetch", vi.fn((url: string) => {
			if (url === "/api/git?cwd=%2Fold") return oldGit.promise;
			if (url === "/api/swarm?cwd=%2Fold") return oldHistory.promise;
			if (url === "/api/git?cwd=%2Fnew") return Promise.resolve(response({ available: true, isRepo: true, root: "/new", branch: "new-branch", files: [] }));
			if (url === "/api/swarm?cwd=%2Fnew") return Promise.resolve(response([]));
			throw new Error(`unexpected url: ${url}`);
		}));
		const trust = { required: true, trusted: true, source: "test" };
		const { rerender } = render(<SwarmCoordinatorPod cwd="/old" projectTrust={trust} />);
		rerender(<SwarmCoordinatorPod cwd="/new" projectTrust={trust} />);
		expect(await screen.findByText("new-branch")).toBeTruthy();
		await act(async () => {
			oldGit.resolve(response({ available: true, isRepo: true, root: "/old", branch: "old-branch", files: [] }));
			oldHistory.resolve(response([{ id: "old-job", cwd: "/old", root: "/old", base: "123", status: "completed", createdAt: Date.now(), tasks: [{ title: "old-task", instruction: "old", status: "completed" }] }]));
		});
		expect(screen.queryByText("old-branch")).toBeNull();
		expect(screen.queryByText(/old-job/)).toBeNull();
	});
	it("disables launch and warns when workspace has uncommitted git changes (dirty)", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url.startsWith("/api/git")) {
				return response({
					available: true,
					isRepo: true,
					root: "/test-workspace",
					branch: "main",
					files: [{ path: "src/config.ts", kind: "modified" }],
				});
			}
			if (url.startsWith("/api/swarm")) {
				return response([]);
			}
			throw new Error(`unexpected url: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SwarmCoordinatorPod
				cwd="/test-workspace"
				projectTrust={{ required: true, trusted: true, source: "test" }}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText(/未提交改动 \(Git Dirty\)/)).toBeTruthy();
		});

		const launchBtn = screen.getByRole("button", { name: /禁止启动 \(工作区存在未提交改动: 1 项\)/ }) as HTMLButtonElement;
		expect(launchBtn.disabled).toBe(true);
	});

	it("disables launch and warns when project is not trusted", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url.startsWith("/api/git")) {
				return response({
					available: true,
					isRepo: true,
					root: "/test-workspace",
					branch: "main",
					files: [],
				});
			}
			if (url.startsWith("/api/swarm")) {
				return response([]);
			}
			throw new Error(`unexpected url: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SwarmCoordinatorPod
				cwd="/test-workspace"
				projectTrust={{ required: true, trusted: false, source: "test" }}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText(/工作区未信任 \(Untrusted\)/)).toBeTruthy();
		});

		const launchBtn = screen.getByRole("button", { name: /禁止启动 \(项目未信任/ }) as HTMLButtonElement;
		expect(launchBtn.disabled).toBe(true);
	});

	it("uses the Git root trust decision for a workspace opened from a subdirectory", async () => {
		let rootTrusted = false;
		let trustPayload: any = null;
		const onSetProjectTrust = vi.fn(async () => {});
		vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
			if (url.startsWith("/api/git")) return response({ available: true, isRepo: true, root: "/repo", branch: "main", files: [] });
			if (url.startsWith("/api/swarm?cwd=")) return response([]);
			if (url === "/api/security?cwd=%2Frepo") return response({ required: true, trusted: rootTrusted, source: "test" });
			if (url === "/api/security" && init?.method === "PUT") {
				trustPayload = JSON.parse(String(init.body));
				rootTrusted = true;
				return response({ required: true, trusted: true, source: "test" });
			}
			throw new Error(`unexpected url: ${url}`);
		}));
		render(<SwarmCoordinatorPod cwd="/repo/subdir" projectTrust={{ required: true, trusted: true, source: "test" }} onSetProjectTrust={onSetProjectTrust} />);
		await waitFor(() => expect(screen.getByText(/工作区未信任 \(Untrusted\)/)).toBeTruthy());
		expect((screen.getByRole("button", { name: /禁止启动 \(项目未信任/ }) as HTMLButtonElement).disabled).toBe(true);
		fireEvent.click(screen.getByRole("button", { name: "信任项目" }));
		await waitFor(() => expect(trustPayload).toEqual({ projectTrust: { cwd: "/repo", decision: true } }));
		expect(onSetProjectTrust).not.toHaveBeenCalled();
	});

	it("disables launch and warns when not a git repository", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url.startsWith("/api/git")) {
				return response({
					available: true,
					isRepo: false,
					root: null,
					branch: null,
					files: [],
				});
			}
			if (url.startsWith("/api/swarm")) {
				return response([]);
			}
			throw new Error(`unexpected url: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SwarmCoordinatorPod
				cwd="/test-workspace"
				projectTrust={{ required: true, trusted: true, source: "test" }}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText(/非 Git 仓库 \(Not Git Repository\)/)).toBeTruthy();
		});

		const launchBtn = screen.getByRole("button", { name: /禁止启动 \(非 Git 仓库/ }) as HTMLButtonElement;
		expect(launchBtn.disabled).toBe(true);
	});

	it("requires explicit tasks in a clean trusted workspace and supports adding/removing task cards", async () => {
		const fetchMock = vi.fn(async (url: string) => {
			if (url.startsWith("/api/git")) {
				return response({
					available: true,
					isRepo: true,
					root: "/test-workspace",
					branch: "main",
					files: [],
				});
			}
			if (url.startsWith("/api/swarm")) {
				return response([]);
			}
			throw new Error(`unexpected url: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SwarmCoordinatorPod
				cwd="/test-workspace"
				projectTrust={{ required: true, trusted: true, source: "test" }}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText(/干净的 Git 状态 \(Ready\)/)).toBeTruthy();
		});

		expect((screen.getByRole("button", { name: /请填写所有任务的目标与指令/ }) as HTMLButtonElement).disabled).toBe(true);
		fireEvent.change(screen.getByPlaceholderText("输入第 1 个子任务简述..."), { target: { value: "检查路径校验" } });
		fireEvent.change(screen.getByPlaceholderText("指定目标文件与函数改写逻辑规范..."), { target: { value: "只修改 src/lib/path-security.ts 的边界处理" } });
		expect((screen.getByRole("button", { name: /启动群组任务 \(1 个任务\)/ }) as HTMLButtonElement).disabled).toBe(false);

		// Add two more tasks without prefilled instructions.
		const addBtn = screen.getByRole("button", { name: /\+ 添加子任务/ });
		fireEvent.click(addBtn);
		expect(screen.getByText("2 / 3 任务")).toBeTruthy();
		fireEvent.click(screen.getByRole("button", { name: /\+ 添加子任务/ }));

		expect(screen.getByText("3 / 3 任务")).toBeTruthy();
		// Add button should disappear or be disabled when 3 tasks reached
		expect(screen.queryByRole("button", { name: /\+ 添加子任务/ })).toBeNull();
	});
});

describe("SwarmCoordinatorPod run lifecycle and patch acceptance", () => {
	it("keeps patch acceptance disabled until every worker finishes", async () => {
		const runningJob = {
			id: "swarm-partial-1234",
			cwd: "/test-workspace",
			root: "/test-workspace",
			base: "abcdef",
			status: "running",
			createdAt: Date.now(),
			tasks: [
				{ title: "First", instruction: "Edit", status: "completed", patch: "--- a/file.txt\n+++ b/file.txt\n" },
				{ title: "Second", instruction: "Edit", status: "running" },
			],
		};
		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.startsWith("/api/git")) return response({ available: true, isRepo: true, root: "/test-workspace", branch: "main", files: [] });
			if (url.startsWith("/api/swarm?cwd=")) return response([runningJob]);
			if (url === "/api/swarm/swarm-partial-1234" && !init?.method) return response(runningJob);
			throw new Error(`unexpected url: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		render(<SwarmCoordinatorPod cwd="/test-workspace" projectTrust={{ required: true, trusted: true, source: "test" }} />);
		const acceptBtn = await screen.findByRole("button", { name: "等待全部任务结束" }) as HTMLButtonElement;
		expect(acceptBtn.disabled).toBe(true);
		fireEvent.click(acceptBtn);
		expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST" && String(init.body).includes('"action":"accept"'))).toBe(false);
	});

	it("renders active job with diff and calls accept patch with index and cwd", async () => {
		const activeJob = {
			id: "swarm-test-1234",
			cwd: "/test-workspace",
			root: "/test-workspace",
			base: "abcdef",
			status: "completed",
			createdAt: Date.now() - 60000,
			finishedAt: Date.now(),
			tasks: [
				{
					title: "重构模型路由策略",
					instruction: "解耦 provider-resolver 工具类",
					status: "completed",
					report: "已提炼 provider-resolver.ts",
					patch: `--- a/src/resolver.ts\n+++ b/src/resolver.ts\n@@ -1,3 +1,3 @@\n-const old = 1;\n+const refined = 2;\n`,
					accepted: false,
				},
				{
					title: "补齐 MCP 插件重试机制",
					instruction: "增加指数退避策略",
					status: "completed",
					report: "已增加重试逻辑，无需改动文件",
				},
			],
		};

		let acceptedPayload: any = null;

		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.startsWith("/api/git")) {
				return response({
					available: true,
					isRepo: true,
					root: "/test-workspace",
					branch: "main",
					files: [],
				});
			}
			if (url === "/api/swarm?cwd=%2Ftest-workspace" || url === "/api/swarm?cwd=/test-workspace") {
				return response([activeJob]);
			}
			if (url === "/api/swarm/swarm-test-1234") {
				if (init?.method === "POST") {
					acceptedPayload = JSON.parse(String(init.body));
					return response({
						...activeJob,
						tasks: [
							{ ...activeJob.tasks[0], accepted: true },
							activeJob.tasks[1],
						],
					});
				}
				return response(activeJob);
			}
			throw new Error(`unexpected url: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SwarmCoordinatorPod
				cwd="/test-workspace"
				projectTrust={{ required: true, trusted: true, source: "test" }}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByText("ID: swarm-test-1234")).toBeTruthy();
			expect(screen.getByText("Task 1: 重构模型路由策略")).toBeTruthy();
			expect(screen.getByText("Task 2: 补齐 MCP 插件重试机制")).toBeTruthy();
		});

		// Task 1 has a patch, so it displays accept button
		const acceptBtn = screen.getByRole("button", { name: /采纳改动 \(Accept Patch\)/ });
		expect(acceptBtn).toBeTruthy();

		// Task 2 has NO patch, so it displays report without accept button
		expect(screen.getByText("已增加重试逻辑，无需改动文件")).toBeTruthy();

		// Click accept button
		fireEvent.click(acceptBtn);

		await waitFor(() => {
			expect(acceptedPayload).toEqual({ cwd: "/test-workspace", action: "accept", index: 0 });
			expect(screen.getByText(/文件修改已成功写入工作区/)).toBeTruthy();
		});
	});

	it("renders cancel button during running swarm and calls action cancel", async () => {
		const runningJob = {
			id: "swarm-running-5678",
			cwd: "/test-workspace",
			root: "/test-workspace",
			base: "abcdef",
			status: "running",
			createdAt: Date.now() - 30000,
			tasks: [
				{
					title: "任务 1",
					instruction: "指示 1",
					status: "running",
				},
			],
		};

		let cancelledPayload: any = null;

		const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.startsWith("/api/git")) {
				return response({
					available: true,
					isRepo: true,
					root: "/test-workspace",
					branch: "main",
					files: [],
				});
			}
			if (url.startsWith("/api/swarm?cwd=")) {
				return response([runningJob]);
			}
			if (url === "/api/swarm/swarm-running-5678") {
				if (init?.method === "POST") {
					cancelledPayload = JSON.parse(String(init.body));
					return response({ ...runningJob, status: "cancelled" });
				}
				return response(runningJob);
			}
			throw new Error(`unexpected url: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);

		render(
			<SwarmCoordinatorPod
				cwd="/test-workspace"
				projectTrust={{ required: true, trusted: true, source: "test" }}
			/>,
		);

		await waitFor(() => {
			expect(screen.getByRole("button", { name: /中断全部智能体 \(action: cancel\)/ })).toBeTruthy();
		});

		const cancelBtn = screen.getByRole("button", { name: /中断全部智能体 \(action: cancel\)/ });
		fireEvent.click(cancelBtn);

		await waitFor(() => {
			expect(cancelledPayload).toEqual({ cwd: "/test-workspace", action: "cancel" });
		});
	});
});
