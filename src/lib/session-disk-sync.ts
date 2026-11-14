import { closeSync, openSync, readSync, statSync, type Stats } from "node:fs";

const READ_CHUNK = 64 * 1024;
const READ_BUDGET = 8 * 1024 * 1024;
const LINE_LIMIT = 1024 * 1024;
const LARGE_LINE_HEAD = 8 * 1024;
const SAMPLE_SIZE = 4 * 1024;

interface Stamp {
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
}
interface Samples {
	head: Buffer;
	tail: Buffer;
	tailAt: number;
}

function sameStamp(a: Stamp, b: Stamp): boolean {
	return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

function readAt(fd: number, start: number, size: number): Buffer {
	const bytes = Buffer.alloc(size);
	let at = 0;
	while (at < size) {
		const count = readSync(fd, bytes, at, size - at, start + at);
		if (!count) break;
		at += count;
	}
	return bytes.subarray(0, at);
}

function samplesAt(fd: number, through: number): Samples {
	const head = readAt(fd, 0, Math.min(through, SAMPLE_SIZE));
	const tailAt = Math.max(0, through - SAMPLE_SIZE);
	return { head, tailAt, tail: readAt(fd, tailAt, through - tailAt) };
}

/**
 * A per-session checkpoint: unchanged files cost one stat; an append reads only
 * its tail in 64 KiB chunks, with an 8 MiB work budget and a 1 MiB row buffer.
 * Replacements, truncation, same-size edits and changed checkpoint bytes are
 * reported even when every JSONL entry keeps its original ID.
 */
export class SessionDiskTracker {
	checkedThrough: number;
	private offset: number;
	private stamp?: Stamp;
	private samples?: Samples;
	private line: Buffer = Buffer.alloc(0);
	private largeLine = false;
	private readonly persistedIds = new Set<string>();

	constructor(private readonly file: string, through?: number, initialIds: Iterable<string> = []) {
		this.checkedThrough = through ?? 0;
		this.offset = this.checkedThrough;
		let fd: number | undefined;
		try {
			const stat = statSync(file);
			if (!stat.isFile()) return;
			this.checkedThrough = through ?? stat.size;
			this.offset = this.checkedThrough;
			fd = openSync(file, "r");
			this.stamp = this.stampOf(stat);
			this.samples = samplesAt(fd, this.checkedThrough);
			if (this.checkedThrough > 0) this.adopt(initialIds);
		} catch {
			// New sessions are initially lazy files; their first persisted rows
			// will be checked against the SessionManager's in-memory entries.
		} finally {
			if (fd !== undefined) closeSync(fd);
		}
	}

	/** The reopened SDK has also loaded complete rows beyond our work budget. */
	adopt(ids: Iterable<string>): void {
		for (const id of ids) this.persistedIds.add(id);
	}

	private stampOf(stat: Stats): Stamp {
		return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
	}

	private reset(stat: Stamp, fd: number): void {
		this.checkedThrough = stat.size;
		this.offset = stat.size;
		this.line = Buffer.alloc(0);
		this.largeLine = false;
		this.stamp = stat;
		this.samples = samplesAt(fd, this.checkedThrough);
	}

	private append(bytes: Buffer): void {
		if (this.largeLine) {
			if (this.line.length < LARGE_LINE_HEAD) this.line = Buffer.concat([this.line, bytes.subarray(0, LARGE_LINE_HEAD - this.line.length)]);
			return;
		}
		if (this.line.length + bytes.length > LINE_LIMIT) {
			this.line = Buffer.concat([this.line, bytes]).subarray(0, LARGE_LINE_HEAD);
			// Copy the small prefix so it does not retain the oversized buffer.
			this.line = Buffer.from(this.line);
			this.largeLine = true;
		} else if (bytes.length) this.line = Buffer.concat([this.line, bytes]);
	}

	private externalLine(getEntry: (id: string) => unknown): number {
		const text = this.line.toString("utf8").trim();
		if (!text) return 0;
		if (this.largeLine) {
			// SDK IDs precede message content. Large own rows need no full JSON
			// allocation; an unrecognizable header is conservatively external.
			const id = /"id"\s*:\s*"([^"\\]*)"/.exec(text)?.[1];
			const alreadyPersisted = id ? this.persistedIds.has(id) : false;
			if (id) this.persistedIds.add(id);
			return id && !alreadyPersisted && getEntry(id) ? 0 : 1;
		}
		try {
			const entry = JSON.parse(text);
			if (entry?.type === "session") return 0;
			if (typeof entry?.id !== "string") return 1;
			this.persistedIds.add(entry.id);
			const known = getEntry(entry.id);
			// Appended edits can reuse an ID. The unchanged own row must also
			// retain its content, rather than merely exist in the memory index.
			return known && JSON.stringify(known) === JSON.stringify(entry) ? 0 : 1;
		} catch {
			return 1;
		}
	}

	check(getEntry: (id: string) => unknown): number {
		let stat: Stamp;
		try {
			const value = statSync(this.file);
			if (!value.isFile()) return 0;
			stat = this.stampOf(value);
		} catch { return 0; }
		if (this.stamp && sameStamp(this.stamp, stat) && this.offset >= stat.size) return 0;
		let fd: number | undefined;
		try {
			fd = openSync(this.file, "r");
			const changed = this.stamp && !sameStamp(this.stamp, stat);
			const rewritten = this.stamp && (this.stamp.dev !== stat.dev || this.stamp.ino !== stat.ino
				|| stat.size < this.stamp.size || (changed && stat.size === this.stamp.size));
			const sampleChanged = this.samples && (!readAt(fd, 0, this.samples.head.length).equals(this.samples.head)
				|| !readAt(fd, this.samples.tailAt, this.samples.tail.length).equals(this.samples.tail));
			if (rewritten || sampleChanged) {
				this.reset(stat, fd);
				return 1;
			}
			const buffer = Buffer.alloc(READ_CHUNK);
			let remaining = READ_BUDGET;
			let count = 0;
			while (this.offset < stat.size && remaining > 0) {
				const read = readSync(fd, buffer, 0, Math.min(buffer.length, remaining, stat.size - this.offset), this.offset);
				if (!read) break;
				let from = 0;
				for (;;) {
					const newline = buffer.subarray(0, read).indexOf(0x0a, from);
					if (newline < 0) break;
					this.append(buffer.subarray(from, newline));
					count += this.externalLine(getEntry);
					this.line = Buffer.alloc(0); this.largeLine = false;
					this.checkedThrough = this.offset + newline + 1;
					from = newline + 1;
				}
				this.append(buffer.subarray(from, read));
				this.offset += read;
				remaining -= read;
			}
			this.stamp = stat;
			this.samples = samplesAt(fd, this.checkedThrough);
			return count;
		} catch { return 0; }
		finally { if (fd !== undefined) closeSync(fd); }
	}
}
