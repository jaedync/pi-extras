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
import { acquireLock, type FileLock, type LockOptions } from "../file-lock.ts";
import { encodeIndex, readIndex, writeIndex, type FileState, type IndexStamp } from "./ledger-index.ts";
import { UNKNOWN_MODEL } from "./ledger-parse.ts";
import { createSpendQueries, type SpendQueries } from "./ledger-query.ts";
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
	/** For tests: the heartbeat, commit and adopt intervals, and a call after each file read. */
	testing?: { heartbeatMs?: number; commitEveryMs?: number; adoptEveryMs?: number; afterFile?: (path: string) => Promise<void> | void };
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
	/** Why the last save, read, lock or heartbeat of the shared index failed; a refresh that takes the lock clears it. */
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
/** A process that reads without the lock looks this often for the holder's saved progress. */
const ADOPT_EVERY_MS = 1_000;

/** The index file, and the lock while this process holds it; a lost lock clears `held`. */
interface Shared {
	indexFile: string;
	held?: { lock: FileLock };
}

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
	let built: SpendQueries | undefined;

	/** Take each file's saved state that is further along than this process's own. */
	async function adoptIndex(indexFile: string, found: ReadonlyMap<string, FileInfo>): Promise<void> {
		let loaded;
		try {
			loaded = await readIndex(indexFile, options.maxAgeMs, indexStamp);
		} catch (error) {
			// A handle that would not close: the records this process has stay, and the report names the reason.
			saveError = errorText(error);
			return;
		}
		if (loaded.state === "unchanged") return;
		if (loaded.state !== "read") {
			// Nothing to take; the next save writes what this process has, so others can use it.
			indexStamp = loaded.state === "unusable" ? loaded.stamp : undefined;
			unsaved = true;
			return;
		}
		indexStamp = loaded.stamp;
		if (loaded.damaged > 0) unsaved = true;
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

	async function readFile(path: string, info: FileInfo, cutoff: number, heartbeat: (() => void) | undefined): Promise<void> {
		const known = files.get(path);
		// A replaced or shrunken file was rewritten; its old records no longer describe it.
		const base: FileState = describes(known, info) ? known : { ino: info.ino, offset: 0, seen: 0, records: [], model: UNKNOWN_MODEL };
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

	/**
	 * Read every file that is behind. With the lock held, touch it every
	 * HEARTBEAT_MS over the whole read, so a long read keeps it, and save the
	 * progress every COMMIT_EVERY_MS. A lock that is no longer this process's
	 * (taken over) or cannot be touched ends the saves; the read goes on in
	 * memory. Without the lock, take what the holder saves between files.
	 */
	async function readBehind(found: ReadonlyMap<string, FileInfo>, cutoff: number, shared?: Shared): Promise<void> {
		const heartbeatMs = options.testing?.heartbeatMs ?? HEARTBEAT_MS;
		const commitEveryMs = options.testing?.commitEveryMs ?? COMMIT_EVERY_MS;
		const adoptEveryMs = options.testing?.adoptEveryMs ?? ADOPT_EVERY_MS;
		let committed = Date.now();
		let looked = Date.now();
		let touched = Date.now();
		const heartbeat = shared?.held ? () => {
			const held = shared.held;
			if (!held || Date.now() - touched < heartbeatMs) return;
			touched = Date.now();
			try {
				if (!held.lock.touch()) shared.held = undefined;
			} catch (error) {
				saveError = errorText(error);
				shared.held = undefined;
			}
		} : undefined;
		for (const [path, info] of behind(found)) {
			if (shared && !shared.held && Date.now() - looked >= adoptEveryMs) {
				// The holder saves its progress; a file it already read need not be read here too.
				looked = Date.now();
				await adoptIndex(shared.indexFile, found);
				const state = files.get(path);
				if (describes(state, info) && state.seen === info.size) continue;
			}
			try {
				await readFile(path, info, cutoff, heartbeat);
			} catch {
				// An unreadable file counts as no spend rather than failing the report.
				files.delete(path);
			}
			heartbeat?.();
			await options.testing?.afterFile?.(path);
			if (shared?.held && Date.now() - committed >= commitEveryMs) {
				prune(found, cutoff);
				save(shared.indexFile);
				committed = Date.now();
			}
		}
	}

	function release(lock: FileLock): void {
		try {
			lock.release();
		} catch (error) {
			// The records are in memory; a lock that cannot be removed only goes stale for the others.
			saveError = errorText(error);
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
			await readBehind(found, cutoff, { indexFile });
			return;
		}
		const shared: Shared = { indexFile, held: { lock } };
		try {
			// The holder before us may have read these bytes already.
			await adoptIndex(indexFile, found);
			await readBehind(found, cutoff, shared);
			if (shared.held) {
				prune(found, cutoff);
				save(indexFile);
			}
		} finally {
			release(lock);
		}
	}

	async function doRefresh(now: number): Promise<void> {
		const cutoff = now - options.maxAgeMs;
		const found = await sessionFiles(options.root, cutoff);
		if (options.indexFile) await refreshShared(options.indexFile, found, cutoff);
		else await readBehind(found, cutoff);
		prune(found, cutoff);
		built = undefined;
		lastRefresh = now;
	}

	/** Built at the first query after a refresh. */
	function queries(): SpendQueries {
		built ??= createSpendQueries(files.values());
		return built;
	}

	return {
		async refresh(now) {
			if (now - lastRefresh < options.minRefreshMs) return;
			pending ??= doRefresh(now).finally(() => { pending = undefined; });
			await pending;
		},
		sum: (query) => queries().sum(query),
		byProvider: (sinceMs, untilMs) => queries().byProvider(sinceMs, untilMs),
		models: (provider, sinceMs) => queries().models(provider, sinceMs),
		stats: () => ({ ...counters }),
		indexProblem: () => saveError,
	};
}
