/**
 * Reads spend records from Pi session files: which files to read, and the
 * lines appended to one since an offset. Only lines whose start names a spend
 * marker are decoded and parsed; tool results, most of the bytes, stay bytes.
 */
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { HEAD_CHARS, parseSpendLine, type SessionModel, type SpendRecord } from "./ledger-parse.ts";

export interface FileInfo {
	size: number;
	ino: number;
}

/** Work done, for tests and benchmarks: a cold read must not come back quietly. */
export interface ReadStats {
	filesOpened: number;
	bytesRead: number;
	linesParsed: number;
}

export const emptyStats = (): ReadStats => ({ filesOpened: 0, bytesRead: 0, linesParsed: 0 });

/** Small chunks keep each synchronous step short, so Pi's event loop keeps running during a long read. */
const CHUNK_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;
/** A UTF-8 character is at most 4 bytes, so this many bytes always hold a line's first HEAD_CHARS characters. */
const HEAD_BYTES = HEAD_CHARS * 4;
/** parseSpendLine reads only lines whose head holds one of these; the byte check is a superset of its own. */
const MARKERS = [
	'"role":"assistant"', '"type":"compaction"', '"type":"branch_summary"', '"type":"usage"', '"type":"model_change"',
	'"customType":"pi-extras.cache-warm"',
].map((marker) => Buffer.from(marker));

function mayHoldSpend(line: Buffer): boolean {
	const head = line.length > HEAD_BYTES ? line.subarray(0, HEAD_BYTES) : line;
	return MARKERS.some((marker) => head.includes(marker));
}

/**
 * Session files touched since `sinceMs`. A directory's mtime moves only when
 * files are added or removed, not when a session grows, so every directory is
 * listed; the stats run in parallel.
 */
export async function sessionFiles(dir: string, sinceMs: number): Promise<Map<string, FileInfo>> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return new Map();
	}
	const nested = await Promise.all(entries.filter((entry) => entry.isDirectory())
		.map((entry) => sessionFiles(join(dir, entry.name), sinceMs)));
	const own = await Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
		.map(async (entry): Promise<[string, FileInfo] | undefined> => {
			const path = join(dir, entry.name);
			try {
				const info = await stat(path);
				return info.mtimeMs >= sinceMs ? [path, { size: info.size, ino: info.ino }] : undefined;
			} catch {
				return undefined; // Removed between listing and stat.
			}
		}));
	return new Map([...nested.flatMap((found) => [...found]), ...own.filter((pair) => !!pair)]);
}

export interface AppendedRead {
	records: SpendRecord[];
	offset: number;
	model: SessionModel;
}

/**
 * Spend records in the complete lines appended since `offset`, read chunk by
 * chunk so a large session never sits in memory. A trailing partial line is
 * left for the next read. `onChunk` runs after each chunk (a lock heartbeat).
 */
export async function readAppended(
	path: string, offset: number, size: number, from: SessionModel, stats: ReadStats, onChunk?: () => void,
): Promise<AppendedRead> {
	const handle = await open(path, "r");
	stats.filesOpened++;
	const records: SpendRecord[] = [];
	let model = from;
	let position = offset;
	// The start of a line that has no newline yet; a line can span many chunks.
	let pending: Buffer[] = [];
	let pendingBytes = 0;
	const take = (line: Buffer): void => {
		if (!mayHoldSpend(line)) return;
		stats.linesParsed++;
		const parsed = parseSpendLine(line.toString("utf8"), model);
		if (parsed?.record) records.push(parsed.record);
		if (parsed?.model) model = parsed.model;
	};
	try {
		while (position < size) {
			const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - position));
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
			if (bytesRead === 0) break;
			position += bytesRead;
			stats.bytesRead += bytesRead;
			const data = chunk.subarray(0, bytesRead);
			let start = 0;
			let end = data.indexOf(NEWLINE);
			if (end >= 0 && pendingBytes > 0) {
				take(Buffer.concat([...pending, data.subarray(0, end)]));
				pending = [];
				pendingBytes = 0;
				start = end + 1;
				end = data.indexOf(NEWLINE, start);
			}
			for (; end >= 0; start = end + 1, end = data.indexOf(NEWLINE, start)) take(data.subarray(start, end));
			if (start < data.length) {
				pending.push(data.subarray(start));
				pendingBytes += data.length - start;
			}
			onChunk?.();
		}
	} finally {
		await handle.close();
	}
	return { records, offset: position - pendingBytes, model };
}
