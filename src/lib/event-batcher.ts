/**
 * 事件批量器：把高频流式事件合并成"每帧一次"的批量更新。
 *
 * 服务端按 token 推 delta，客户端原本每个事件一次 setState → 一次整树渲染。
 * 合并后一次渲染里按顺序折叠整批事件，token 速率再高也只有每 16ms 一次渲染，
 * 主线程不再被切碎（点击、滚动因此变顺）。
 */
export interface EventBatcher<T> {
	/** 入队；达到上限立刻冲刷，避免极端情况下无限堆积 */
	push(event: T): void;
	flush(): void;
	/** 丢弃未处理的事件（例如快照到达：旧事件已经过时） */
	cancel(): void;
	size(): number;
}

export function createEventBatcher<T>({
	flush,
	schedule = (run) => {
		const id = setTimeout(run, 16);
		return () => clearTimeout(id);
	},
	limit = 400,
}: {
	flush: (events: T[]) => void;
	schedule?: (run: () => void) => () => void;
	limit?: number;
}): EventBatcher<T> {
	let pending: T[] = [];
	let cancelScheduled: (() => void) | null = null;

	const stopScheduled = () => {
		if (!cancelScheduled) return;
		cancelScheduled();
		cancelScheduled = null;
	};

	const flushNow = () => {
		stopScheduled();
		if (!pending.length) return;
		const batch = pending;
		pending = [];
		flush(batch);
	};

	return {
		push(event) {
			pending.push(event);
			if (pending.length >= limit) {
				flushNow();
				return;
			}
			cancelScheduled ??= schedule(flushNow);
		},
		flush: flushNow,
		cancel() {
			stopScheduled();
			pending = [];
		},
		size: () => pending.length,
	};
}
