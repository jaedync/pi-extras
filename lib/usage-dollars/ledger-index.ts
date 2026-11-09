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

/** On disk, strings repeat once: a record is [ts, provider, model, cost, id] with provider and model as string-table indexes. */
interface IndexFile {
	v: number;
	maxAgeMs: number;
	strings: string[];
	files: Record<string, [ino: number, offset: number, seen: number, provider: number, model: number, records: Array<[number, number, number, number, string]>]>;
}

const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

export function encodeIndex(files: ReadonlyMap<string, FileState>, maxAgeMs: number): string {
	const strings: string[] = [];
	const ids = new Map<string, number>();
	const ref = (text: string): number => {
		let id = ids.get(text);
		if (id === undefined) {
			id = strings.length;
			strings.push(text);
			ids.set(text, id);
		}
		return id;
	};
	const out: IndexFile["files"] = {};
	for (const [path, state] of files) {
		out[path] = [state.ino, state.offset, state.seen, ref(state.model.provider), ref(state.model.model),
			state.records.map((record) => [record.ts, ref(record.provider), ref(record.model), record.cost, record.id])];
	}
	return JSON.stringify({ v: VERSION, maxAgeMs, strings, files: out } satisfies IndexFile);
}

/**
 * Undefined for anything this version did not write, or an index that kept
 * fewer days than `maxAgeMs` needs. Throws on text that is not JSON.
 */
export function decodeIndex(text: string, maxAgeMs: number): Map<string, FileState> | undefined {
	const raw = JSON.parse(text) as IndexFile;
	if (!raw || raw.v !== VERSION || !finite(raw.maxAgeMs) || raw.maxAgeMs < maxAgeMs) return undefined;
	if (!Array.isArray(raw.strings) || !raw.strings.every((entry) => typeof entry === "string") || !raw.files || typeof raw.files !== "object") return undefined;
	const strings = raw.strings;
	const text_ = (index: unknown): string | undefined => isCount(index) && index < strings.length ? strings[index] : undefined;
	const files = new Map<string, FileState>();
	for (const [path, entry] of Object.entries(raw.files)) {
		if (!Array.isArray(entry) || entry.length !== 6 || !isCount(entry[0]) || !isCount(entry[1]) || !isCount(entry[2]) || entry[2] < entry[1] || !Array.isArray(entry[5])) return undefined;
		const provider = text_(entry[3]);
		const model = text_(entry[4]);
		if (provider === undefined || model === undefined) return undefined;
		const records: SpendRecord[] = [];
		for (const row of entry[5]) {
			if (!Array.isArray(row) || row.length !== 5) return undefined;
			const [ts, p, m, cost, id] = row;
			const recordProvider = text_(p);
			const recordModel = text_(m);
			if (!finite(ts) || !finite(cost) || cost < 0 || typeof id !== "string" || recordProvider === undefined || recordModel === undefined) return undefined;
			records.push({ ts, provider: recordProvider, model: recordModel, cost, id });
		}
		files.set(path, { ino: entry[0], offset: entry[1], seen: entry[2], model: { provider, model }, records });
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
