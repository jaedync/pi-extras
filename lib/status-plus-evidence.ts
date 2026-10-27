/** Bounded, read-only durable evidence cache. Stat signatures also invalidate misses
 * and partial writes; a running child can publish evidence after the first render.
 *
 * A walk's totals must not depend on what an earlier walk left here. A transcript is
 * read on from where the last read stopped, a caller's projection keeps only what it
 * reads (so a session's children fit), and a changed file the walk cannot afford keeps
 * what was read before; the budget records that the walk waited, so the caller can
 * come back for the rest. A transcript is read at most MAX_PASS_BYTES a pass, so a child
 * that grew past it still counts, over several walks. What a new process could not read
 * (a deleted file, a JSON file over the size limit) is not served from here either. */
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync, type Stats } from "node:fs";

/** A JSON file is read whole, so one larger than this is not read. */
const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** New transcript bytes one pass reads; a longer append is read on at the next walk. */
const MAX_PASS_BYTES = 50 * 1024 * 1024;
/** Counted as kept: a projected transcript is a small part of its file. */
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 4096;
/** Rough heap a kept record costs beyond its JSON: object headers and a message's content hash. */
const RECORD_BYTES = 96;
/** Bytes at a transcript's start and before its read offset that must be unchanged for the rest to be an append. */
const SEAM_BYTES = 64;
const NEWLINE = 0x0a;

/**
 * Where a transcript's complete lines end, and what they held. `skipping`: the
 * offset is inside a line longer than a pass, which is skipped up to its newline.
 */
interface Lines { ino: number; offset: number; start: Buffer; seam: Buffer; head: unknown[]; headBytes: number; skipping?: boolean; }
interface Entry { signature: string; value: unknown; bytes: number; lines?: Lines; }

const cache = new Map<string, Entry>();
let cacheBytes = 0;

export interface EvidenceBudget {
	bytes: number;
	/** Set when a read waited for a later walk: what this walk saw is not yet everything. */
	deferred?: boolean;
}

const signatureOf = (stat: Stats): string => `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
const missing = (error: unknown): boolean => (error as { code?: unknown })?.code === "ENOENT";

function forget(key: string): void {
	const previous = cache.get(key);
	if (!previous) return;
	cacheBytes -= previous.bytes;
	cache.delete(key);
}

function remember(key: string, entry: Entry): void {
	forget(key);
	cache.set(key, entry);
	cacheBytes += entry.bytes;
	while (cache.size > MAX_CACHE_ENTRIES || cacheBytes > MAX_CACHE_BYTES) {
		const first = cache.keys().next().value!;
		cacheBytes -= cache.get(first)!.bytes;
		cache.delete(first);
	}
}

/** A hit moves to the back, so eviction takes what no walk has asked for longest. */
function touch(key: string, entry: Entry): unknown {
	cache.delete(key);
	cache.set(key, entry);
	return entry.value;
}

/** Charge a read to the walk. One it cannot pay for waits, and the walk is marked as having waited. */
function afford(budget: EvidenceBudget | undefined, bytes: number): boolean {
	if (!budget) return true;
	if (bytes > budget.bytes) {
		budget.deferred = true;
		return false;
	}
	budget.bytes -= bytes;
	return true;
}

function readRange(path: string, start: number, end: number): Buffer {
	const buffer = Buffer.allocUnsafe(Math.max(0, end - start));
	const fd = openSync(path, "r");
	try {
		let done = 0;
		while (done < buffer.length) {
			const read = readSync(fd, buffer, done, buffer.length - done, start + done);
			if (read === 0) break;
			done += read;
		}
		return buffer.subarray(0, done);
	} finally {
		closeSync(fd);
	}
}

/** An unpooled copy: a small pooled buffer kept in the cache would keep its whole shared slab alive. */
function own(bytes: Buffer): Buffer {
	const copy = Buffer.alloc(bytes.length);
	bytes.copy(copy);
	return copy;
}

/** Whether the file still holds what was read: same inode, no shorter, same first bytes and bytes before the old end. */
function resumes(path: string, stat: Stats, lines: Lines): boolean {
	if (stat.ino !== lines.ino || stat.size < lines.offset) return false;
	return readRange(path, 0, lines.start.length).equals(lines.start)
		&& readRange(path, lines.offset - lines.seam.length, lines.offset).equals(lines.seam);
}

/** The last bytes before `end`, joined to the earlier seam when the new complete lines are shorter than one. */
function seamBefore(chunk: Buffer, end: number, earlier: Buffer | undefined): Buffer {
	if (end >= SEAM_BYTES || !earlier) return own(chunk.subarray(Math.max(0, end - SEAM_BYTES), end));
	const joined = Buffer.concat([earlier, chunk.subarray(0, end)]);
	return own(joined.subarray(Math.max(0, joined.length - SEAM_BYTES)));
}

/** The file's first bytes once its complete lines reach that far; until then, read again as they grow. */
function startOf(path: string, chunk: Buffer, from: number, offset: number, earlier: Buffer | undefined): Buffer {
	if (earlier?.length === SEAM_BYTES) return earlier;
	const length = Math.min(SEAM_BYTES, offset);
	return own(from === 0 ? chunk.subarray(0, length) : readRange(path, 0, length));
}

function parse(bytes: Buffer, keep: (record: unknown) => unknown): { records: unknown[]; bytes: number } {
	const records: unknown[] = [];
	let size = 0;
	for (const line of bytes.toString("utf8").split("\n")) {
		if (!line.trim()) continue;
		let record: unknown;
		try { record = JSON.parse(line); } catch { continue; /* retain complete records during append */ }
		const kept = keep(record);
		if (kept === undefined) continue;
		records.push(kept);
		size += RECORD_BYTES + (kept === record ? line.length : JSON.stringify(kept)?.length ?? 0);
	}
	return { records, bytes: size };
}

/** A JSON file, passed through `keep` once per change. One caller per path: the cache holds what it kept. */
export function evidenceJson(path: string, budget?: EvidenceBudget, keep: (value: unknown) => unknown = (value) => value): unknown {
	const key = `json:${path}`;
	const previous = cache.get(key);
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
			forget(key);
			return;
		}
		const signature = signatureOf(stat);
		if (previous?.signature === signature) return touch(key, previous);
		if (!afford(budget, stat.size)) return previous?.value;
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		const value = keep(parsed);
		remember(key, { signature, value, bytes: value === parsed ? stat.size : JSON.stringify(value)?.length ?? 0 });
		return value;
	} catch (error) {
		if (missing(error)) {
			forget(key);
			return;
		}
		// Do not memoize unreadable paths or malformed JSON as permanent misses; a file
		// caught mid-write still has what was read from it before.
		return previous?.value;
	}
}

/** What one pass read: complete records, a parsed last fragment, and where its complete lines end. */
interface Pass { complete: { records: unknown[]; bytes: number }; fragment: { records: unknown[]; bytes: number }; end: number; skipping: boolean }

/**
 * Parse one pass. A pass that stops before the file's end parses no fragment:
 * its last line goes on in the next pass. A line still open at the end of a full
 * pass is longer than a pass, so it is skipped (a huge tool result holds no spend).
 */
function readPass(chunk: Buffer, partial: boolean, skipping: boolean, keep: (record: unknown) => unknown): Pass {
	const none = { records: [], bytes: 0 };
	const skipTo = skipping ? chunk.indexOf(NEWLINE) + 1 : 0;
	const last = chunk.lastIndexOf(NEWLINE) + 1;
	// Still inside the skipped line, or a full pass that holds no line end: skip it all.
	if ((skipping && skipTo === 0) || (partial && last === 0)) return { complete: none, fragment: none, end: chunk.length, skipping: true };
	const end = Math.max(last, skipTo);
	return {
		complete: parse(chunk.subarray(skipTo, end), keep),
		fragment: partial ? none : parse(chunk.subarray(end), keep),
		end,
		skipping: false,
	};
}

/** JSONL records, each passed through `keep` (undefined drops it). One caller per path: the cache holds what it kept. */
export function evidenceLines(path: string, budget?: EvidenceBudget, keep: (record: unknown) => unknown = (record) => record): unknown[] | undefined {
	const key = `lines:${path}`;
	const previous = cache.get(key);
	const stale = previous?.value as unknown[] | undefined;
	try {
		const stat = statSync(path);
		if (!stat.isFile()) {
			forget(key);
			return;
		}
		const signature = signatureOf(stat);
		if (previous?.signature === signature) return touch(key, previous) as unknown[];
		const lines = previous?.lines && resumes(path, stat, previous.lines) ? previous.lines : undefined;
		const from = lines?.offset ?? 0;
		const to = Math.min(stat.size, from + MAX_PASS_BYTES);
		if (!afford(budget, to - from)) return stale;
		const chunk = readRange(path, from, to);
		const partial = from + chunk.length < stat.size;
		// The rest waits for the next walk; a partial pass must not look up to date to it.
		if (partial && budget) budget.deferred = true;
		const pass = readPass(chunk, partial, lines?.skipping === true, keep);
		const head = lines ? [...lines.head, ...pass.complete.records] : pass.complete.records;
		const headBytes = (lines?.headBytes ?? 0) + pass.complete.bytes;
		const value = pass.fragment.records.length ? [...head, ...pass.fragment.records] : head;
		const offset = from + pass.end;
		remember(key, {
			signature: partial ? `partial:${signature}` : signature, value, bytes: headBytes + pass.fragment.bytes,
			lines: {
				ino: stat.ino, offset, start: startOf(path, chunk, from, offset, lines?.start), seam: seamBefore(chunk, pass.end, lines?.seam), head, headBytes,
				...(pass.skipping ? { skipping: true } : {}),
			},
		});
		return value;
	} catch (error) {
		if (missing(error)) {
			forget(key);
			return;
		}
		return stale;
	}
}

export function evidenceFiles(path: string): string[] {
	const key = `dir:${path}`;
	try {
		const stat = statSync(path);
		if (!stat.isDirectory()) return [];
		const signature = signatureOf(stat);
		const previous = cache.get(key);
		if (previous?.signature === signature) return touch(key, previous) as string[];
		const value = readdirSync(path).sort();
		remember(key, { signature, value, bytes: JSON.stringify(value).length });
		return value;
	} catch {
		return [];
	}
}
