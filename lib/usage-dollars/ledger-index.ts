/**
 * The spend ledger's index, shared by every Pi process of one agent
 * directory: for each session file, how far it was read, the model at that
 * point and the spend records found. A process reads new bytes once, saves
 * them here, and every other process starts from the saved offsets, so no
 * process reads a week of sessions again. It is a cache: a missing, damaged
 * or older-version file only means a full read.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { dirname } from "node:path";
import type { SessionModel, SpendRecord } from "./ledger-parse.ts";

const VERSION = 1;

export interface FileState {
	/** A rename over the path (Pi rewrites a session that way) gives a new inode. */
	ino: number;
	/** The end of the last complete line read: the next read starts here. */
	offset: number;
	/** The file size at the last read; a partial line past offset is read again only when the file grows. */
	seen: number;
	records: readonly SpendRecord[];
	/** The session's model at offset, for off-turn spend later in the file. */
	model: SessionModel;
}

/** What identifies one version of the index file, to skip reading it again when no process changed it. */
export interface IndexStamp {
	ino: number;
	mtimeMs: number;
	size: number;
}

/**
 * On disk, each file's names appear once: a file is [ino, offset, seen,
 * provider, model, names, records], and a record is [ts, provider, model,
 * cost, id] with provider and model as indexes into the file's names. Each
 * file has its own names, so the text of a file that did not change is kept
 * from the last save.
 */
type Row = [ts: number, provider: number, model: number, cost: number, id: string];
type FileEntry = [ino: number, offset: number, seen: number, provider: number, model: number, names: string[], records: Row[]];

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/** A state object is replaced, never changed, so its text stays right while the object lives. */
const encoded = new WeakMap<FileState, string>();

function encodeFile(state: FileState): string {
	const hit = encoded.get(state);
	if (hit !== undefined) return hit;
	const names: string[] = [];
	const ids = new Map<string, number>();
	const ref = (text: string): number => {
		let id = ids.get(text);
		if (id === undefined) {
			id = names.length;
			names.push(text);
			ids.set(text, id);
		}
		return id;
	};
	const provider = ref(state.model.provider);
	const model = ref(state.model.model);
	const rows = state.records.map((record): Row => [record.ts, ref(record.provider), ref(record.model), record.cost, record.id]);
	const text = JSON.stringify([state.ino, state.offset, state.seen, provider, model, names, rows] satisfies FileEntry);
	encoded.set(state, text);
	return text;
}

export function encodeIndex(files: ReadonlyMap<string, FileState>, maxAgeMs: number): string {
	const parts = [...files].map(([path, state]) => `${JSON.stringify(path)}:${encodeFile(state)}`);
	return `{"v":${VERSION},"maxAgeMs":${JSON.stringify(maxAgeMs)},"files":{${parts.join(",")}}}`;
}

function decodeFile(entry: unknown): FileState | undefined {
	if (!Array.isArray(entry) || entry.length !== 7) return undefined;
	const [ino, offset, seen, provider, model, names, rows] = entry as unknown[];
	if (!isCount(ino) || !isCount(offset) || !isCount(seen) || seen < offset || !Array.isArray(names) || !Array.isArray(rows)) return undefined;
	if (!names.every((name) => typeof name === "string")) return undefined;
	const name = (index: unknown): string | undefined => isCount(index) && index < names.length ? names[index] as string : undefined;
	const sessionProvider = name(provider);
	const sessionModel = name(model);
	if (sessionProvider === undefined || sessionModel === undefined) return undefined;
	const records: SpendRecord[] = [];
	for (const row of rows) {
		if (!Array.isArray(row) || row.length !== 5) return undefined;
		const [ts, p, m, cost, id] = row as unknown[];
		const recordProvider = name(p);
		const recordModel = name(m);
		if (!finite(ts) || !finite(cost) || cost < 0 || typeof id !== "string" || recordProvider === undefined || recordModel === undefined) return undefined;
		records.push({ ts, provider: recordProvider, model: recordModel, cost, id });
	}
	return { ino, offset, seen, model: { provider: sessionProvider, model: sessionModel }, records };
}

/**
 * Undefined for anything this version did not write, or an index that kept
 * fewer days than `maxAgeMs` needs. Throws on text that is not JSON.
 */
export function decodeIndex(text: string, maxAgeMs: number): Map<string, FileState> | undefined {
	const raw = JSON.parse(text) as { v?: unknown; maxAgeMs?: unknown; files?: unknown };
	if (!raw || raw.v !== VERSION || !finite(raw.maxAgeMs) || raw.maxAgeMs < maxAgeMs || !raw.files || typeof raw.files !== "object") return undefined;
	const files = new Map<string, FileState>();
	for (const [path, entry] of Object.entries(raw.files)) {
		const state = decodeFile(entry);
		if (!state) return undefined;
		files.set(path, state);
	}
	return files;
}

export type IndexRead =
	| { state: "missing" }
	| { state: "unchanged" }
	| { state: "read"; files: Map<string, FileState>; stamp: IndexStamp }
	/** Damaged, or from another version: the next save replaces it. */
	| { state: "unusable"; reason: string; stamp?: IndexStamp };

const errorText = (error: unknown): string =>
	error instanceof Error ? ("code" in error && typeof error.code === "string" ? error.code : error.message) : String(error);

/** The index, unless it is unchanged since `known`. */
export async function readIndex(file: string, maxAgeMs: number, known: IndexStamp | undefined): Promise<IndexRead> {
	let handle;
	try {
		handle = await open(file, "r");
	} catch (error) {
		return errorText(error) === "ENOENT" ? { state: "missing" } : { state: "unusable", reason: errorText(error) };
	}
	let stamp: IndexStamp | undefined;
	try {
		// The stamp and the text come from one open file, so they describe the same version.
		const info = await handle.stat();
		stamp = { ino: info.ino, mtimeMs: info.mtimeMs, size: info.size };
		if (known && known.ino === stamp.ino && known.mtimeMs === stamp.mtimeMs && known.size === stamp.size) return { state: "unchanged" };
		const files = decodeIndex(await handle.readFile("utf8"), maxAgeMs);
		return files ? { state: "read", files, stamp } : { state: "unusable", reason: "another version", stamp };
	} catch (error) {
		return { state: "unusable", reason: errorText(error), ...(stamp ? { stamp } : {}) };
	} finally {
		await handle.close();
	}
}

/**
 * Write to a temporary file and rename it over the index, so a reader never
 * sees half a file. Returns the new file's stamp: a rename keeps the inode
 * and mtime, so it is the temporary file's.
 */
export function writeIndex(file: string, text: string): IndexStamp {
	const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		writeFileSync(temp, text, { mode: 0o600 });
		const info = statSync(temp);
		renameSync(temp, file);
		return { ino: info.ino, mtimeMs: info.mtimeMs, size: info.size };
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}
