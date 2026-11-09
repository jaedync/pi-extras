/**
 * Spend on this machine, read from Pi session files: every assistant turn's
 * recorded cost, by provider and model, and the spend Pi records outside
 * turns (compaction and branch summaries, cache refreshes). Main sessions, forks and subagent
 * sessions all live under the sessions directory; a turn copied into a fork
 * keeps its response id, so it counts once. Queries and totals go by the key
 * of a provider's limit readings (lib/plan-billing.ts): claude-code spend is
 * anthropic spend, while an openai API key keeps its own.
 *
 * Reads are incremental: each file is read from where the last refresh
 * stopped, and only files touched within the window are opened. With an
 * index file, the processes of one agent directory share those offsets and
 * records (ledger-index.ts): a new process reads only the bytes that no
 * process has read yet. A full read of a busy week (790 MB) took 20 s of one
 * core at load and up to three minutes in a busy Pi process; every new Pi
 * process and every subagent paid it on its first usage call.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { limitKey } from "../plan-billing.ts";
import { acquireLock, type FileLock, type LockOptions } from "../file-lock.ts";
import { encodeIndex, readIndex, writeIndex, type FileState, type IndexStamp } from "./ledger-index.ts";
import { familyMatches, UNKNOWN_MODEL, type SpendRecord } from "./ledger-parse.ts";
import { emptyStats, readAppended, sessionFiles, type FileInfo, type ReadStats } from "./ledger-read.ts";

export { parseSpendLine, type LedgerLine, type SessionModel, type SpendRecord } from "./ledger-parse.ts";
export type { ReadStats } from "./ledger-read.ts";

export interface SpendLedgerOptions {
	root: string;
	/** Records and files older than this are dropped. */
	maxAgeMs: number;
	/** Refreshes closer together than this reuse the last read. */
	minRefreshMs: number;
	/** The index shared with other processes. Without one, this process reads every file itself. */
	indexFile?: string;
	/**
	 * How long a refresh waits for another process that is updating the index.
	 * Past it, this process reads the new bytes itself and does not save them.
	 */
	lockWaitMs?: number;
}

export interface SpendLedger {
	refresh(now: number): Promise<void>;
	/** `family` here is a model family (fable), not a provider family. */
	sum(query: { provider: string; sinceMs: number; untilMs: number; family?: string }): number;
	/** Keyed by limitKey (lib/plan-billing.ts): the family id for a plan login. */
	byProvider(sinceMs: number, untilMs: number): Record<string, number>;
	models(provider: string, sinceMs: number): string[];
	/** Work done since this ledger was made: files opened, bytes read, lines parsed. */
	stats(): ReadStats;
	/** Why the last refresh could not save the shared index, or undefined when it saved or had nothing new. */
	indexProblem(): string | undefined;
}

/**
 * A holder updates the index for a few milliseconds; only a full read takes
 * long, and it touches the lock every HEARTBEAT_MS. A lock left this long
 * without a touch belongs to a stopped process.
 */
const LEDGER_LOCK: LockOptions = { staleMs: 30_000, settleMs: 5_000 };
const HEARTBEAT_MS = 2_000;
/** A long read saves its progress this often, so other processes can use it and a stopped process loses little. */
const COMMIT_EVERY_MS = 5_000;
const DEFAULT_LOCK_WAIT_MS = 2_000;

const errorText = (error: unknown): string =>
	error instanceof Error ? ("code" in error && typeof error.code === "string" ? error.code : error.message) : String(error);

/** Whether a saved state still describes the file: same inode, and not past its end. */
const describes = (state: FileState | undefined, info: FileInfo): state is FileState =>
	!!state && state.ino === info.ino && state.offset <= info.size;

export function createSpendLedger(options: SpendLedgerOptions): SpendLedger {
	let files = new Map<string, FileState>();
	let lastRefresh = -Infinity;
	let pending: Promise<void> | undefined;
	let indexStamp: IndexStamp | undefined;
	/** True while this process has records the index does not: they go in at its next save. */
	let unsaved = false;
	let saveError: string | undefined;
	const counters = emptyStats();
	/** unique() results by range; a refresh clears them. */
	let ranges = new Map<string, SpendRecord[]>();

	/** Take each file's saved state that is further along than this process's own. */
	async function adoptIndex(indexFile: string, found: ReadonlyMap<string, FileInfo>): Promise<void> {
		const loaded = await readIndex(indexFile, options.maxAgeMs, indexStamp);
		if (loaded.state === "unchanged") return;
		if (loaded.state !== "read") {
			// Nothing to take; the next save writes what this process has, so others can use it.
			indexStamp = loaded.state === "unusable" ? loaded.stamp : undefined;
			unsaved = true;
			return;
		}
		indexStamp = loaded.stamp;
		const next = new Map(files);
		for (const [path, theirs] of loaded.files) {
			const info = found.get(path);
			if (!info || !describes(theirs, info)) continue;
			const ours = next.get(path);
			if (!describes(ours, info) || theirs.seen > ours.seen) next.set(path, theirs);
		}
		files = next;
	}

	function behind(found: ReadonlyMap<string, FileInfo>): Array<[string, FileInfo]> {
		return [...found].filter(([path, info]) => {
			const state = files.get(path);
			return !describes(state, info) || state.seen !== info.size;
		});
	}

	async function readFile(path: string, info: FileInfo, cutoff: number, lock: FileLock | undefined): Promise<void> {
		const known = files.get(path);
		// A replaced or shrunken file was rewritten; its old records no longer describe it.
		const base: FileState = describes(known, info) ? known : { ino: info.ino, offset: 0, seen: 0, records: [], model: UNKNOWN_MODEL };
		let touched = Date.now();
		const heartbeat = lock ? () => {
			if (Date.now() - touched < HEARTBEAT_MS) return;
			touched = Date.now();
			lock.touch();
		} : undefined;
		const read = info.size > base.offset
			? await readAppended(path, base.offset, info.size, base.model, counters, heartbeat)
			: { records: [], offset: base.offset, model: base.model };
		files.set(path, {
			ino: info.ino,
			offset: read.offset,
			seen: info.size,
			model: read.model,
			records: [...base.records, ...read.records].filter((record) => record.ts >= cutoff),
		});
		unsaved = true;
	}

	function prune(found: ReadonlyMap<string, FileInfo>, cutoff: number): void {
		const next = new Map<string, FileState>();
		for (const [path, state] of files) {
			if (!found.has(path)) {
				unsaved = true;
				continue;
			}
			const old = state.records.some((record) => record.ts < cutoff);
			next.set(path, old ? { ...state, records: state.records.filter((record) => record.ts >= cutoff) } : state);
		}
		files = next;
	}

	/** A failed save keeps the records in this process and reports the reason; the next refresh tries again. */
	function save(indexFile: string): void {
		if (!unsaved) return;
		try {
			indexStamp = writeIndex(indexFile, encodeIndex(files, options.maxAgeMs));
			unsaved = false;
			saveError = undefined;
		} catch (error) {
			saveError = errorText(error);
		}
	}

	async function readBehind(found: ReadonlyMap<string, FileInfo>, cutoff: number, held?: { lock: FileLock; indexFile: string }): Promise<void> {
		let committed = Date.now();
		for (const [path, info] of behind(found)) {
			try {
				await readFile(path, info, cutoff, held?.lock);
			} catch {
				// An unreadable file counts as no spend rather than failing the report.
				files.delete(path);
			}
			if (held && Date.now() - committed >= COMMIT_EVERY_MS) {
				prune(found, cutoff);
				save(held.indexFile);
				committed = Date.now();
			}
		}
	}

	/** Read what no process has read yet, under the index lock, and save it for the others. */
	async function refreshShared(indexFile: string, found: ReadonlyMap<string, FileInfo>, cutoff: number): Promise<void> {
		await adoptIndex(indexFile, found);
		if (behind(found).length === 0 && !unsaved) return;
		let lock: FileLock | undefined;
		try {
			mkdirSync(dirname(indexFile), { recursive: true, mode: 0o700 });
			lock = await acquireLock(`${indexFile}.lock`, options.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS, LEDGER_LOCK);
		} catch (error) {
			// No lock can be made (a read-only or full disk): count this process's spend without the index.
			saveError = errorText(error);
			await readBehind(found, cutoff);
			return;
		}
		saveError = undefined;
		if (!lock) {
			// Another process is still updating the index; read the gap here rather than wait longer.
			await readBehind(found, cutoff);
			return;
		}
		try {
			// The holder before us may have read these bytes already.
			await adoptIndex(indexFile, found);
			await readBehind(found, cutoff, { lock, indexFile });
			prune(found, cutoff);
			save(indexFile);
		} finally {
			lock.release();
		}
	}

	async function doRefresh(now: number): Promise<void> {
		const cutoff = now - options.maxAgeMs;
		const found = await sessionFiles(options.root, cutoff);
		if (options.indexFile) await refreshShared(options.indexFile, found, cutoff);
		else await readBehind(found, cutoff);
		prune(found, cutoff);
		ranges = new Map();
		lastRefresh = now;
	}

	function unique(sinceMs: number, untilMs: number): SpendRecord[] {
		const key = `${sinceMs}|${untilMs}`;
		const hit = ranges.get(key);
		if (hit) return hit;
		const seen = new Set<string>();
		const result: SpendRecord[] = [];
		for (const state of files.values()) {
			for (const record of state.records) {
				if (record.ts < sinceMs || record.ts > untilMs || seen.has(record.id)) continue;
				seen.add(record.id);
				result.push(record);
			}
		}
		ranges.set(key, result);
		return result;
	}

	return {
		async refresh(now) {
			if (now - lastRefresh < options.minRefreshMs) return;
			pending ??= doRefresh(now).finally(() => { pending = undefined; });
			await pending;
		},
		sum({ provider, sinceMs, untilMs, family }) {
			const key = limitKey(provider);
			let total = 0;
			for (const record of unique(sinceMs, untilMs)) {
				if (limitKey(record.provider) === key && (!family || familyMatches(record.model, family))) total += record.cost;
			}
			return total;
		},
		byProvider(sinceMs, untilMs) {
			const totals: Record<string, number> = {};
			for (const record of unique(sinceMs, untilMs)) {
				const key = limitKey(record.provider);
				totals[key] = (totals[key] ?? 0) + record.cost;
			}
			return totals;
		},
		models(provider, sinceMs) {
			const key = limitKey(provider);
			return [...new Set(unique(sinceMs, Infinity).filter((record) => limitKey(record.provider) === key).map((record) => record.model))];
		},
		stats: () => ({ ...counters }),
		indexProblem: () => saveError,
	};
}
