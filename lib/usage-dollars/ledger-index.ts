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

const VERSION = 2;
/** The version is in the name, so the processes of two releases never overwrite each other's index. */
export const INDEX_FILE_NAME = `spend-index-v${VERSION}.json`;

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
 * On disk, the first line is {"v", "maxAgeMs"}, and each further line is one
 * session file: its path as JSON, a tab, and [ino, offset, seen, provider,
 * model, names, records]. A record is [ts, provider, model, cost, id] with
 * provider and model as indexes into the file's names. JSON escapes a tab
 * in a path, so the first tab ends the path. One line per file lets a save
 * reuse the text of every file that did not change, and a damaged line costs
 * only its own file.
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
	const lines = [JSON.stringify({ v: VERSION, maxAgeMs })];
	for (const [path, state] of files) lines.push(`${JSON.stringify(path)}\t${encodeFile(state)}`);
	return `${lines.join("\n")}\n`;
}

const isName = (names: readonly unknown[], index: unknown): index is number =>
	typeof index === "number" && index >= 0 && index < names.length && Number.isInteger(index);

/** Plain loops and no closures: a week's index holds about 50,000 rows. */
function decodeFile(entry: unknown): FileState | undefined {
	if (!Array.isArray(entry) || entry.length !== 7) return undefined;
	const [ino, offset, seen, provider, model, names, rows] = entry as unknown[];
	if (!isCount(ino) || !isCount(offset) || !isCount(seen) || seen < offset || !Array.isArray(names) || !Array.isArray(rows)) return undefined;
	for (const name of names) if (typeof name !== "string") return undefined;
	if (!isName(names, provider) || !isName(names, model)) return undefined;
	const records: SpendRecord[] = new Array(rows.length);
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index] as unknown[];
		if (!Array.isArray(row) || row.length !== 5) return undefined;
		const ts = row[0], p = row[1], m = row[2], cost = row[3], id = row[4];
		if (typeof ts !== "number" || !Number.isFinite(ts) || typeof cost !== "number" || !(cost >= 0) || cost === Infinity || typeof id !== "string"
			|| !isName(names, p) || !isName(names, m)) return undefined;
		records[index] = { ts, provider: names[p] as string, model: names[m] as string, cost, id };
	}
	return { ino, offset, seen, model: { provider: names[provider] as string, model: names[model] as string }, records };
}

export interface DecodedIndex {
	files: Map<string, FileState>;
	/** Lines that did not parse: their files are read again, and the next save writes them right. */
	damaged: number;
}

function decodeLine(line: string): [string, FileState, string] | undefined {
	const tab = line.indexOf("\t");
	if (tab < 0) return undefined;
	try {
		const path: unknown = JSON.parse(line.slice(0, tab));
		const text = line.slice(tab + 1);
		const state = decodeFile(JSON.parse(text));
		return typeof path === "string" && state ? [path, state, text] : undefined;
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
}

/** Undefined for an index this version did not write, or one that kept fewer days than `maxAgeMs` needs. */
export function decodeIndex(text: string, maxAgeMs: number): DecodedIndex | undefined {
	const lines = text.split("\n");
	let header: { v?: unknown; maxAgeMs?: unknown } | undefined;
	try {
		header = JSON.parse(lines[0] ?? "") as typeof header;
	} catch (error) {
		if (error instanceof SyntaxError) return undefined;
		throw error;
	}
	if (!header || header.v !== VERSION || !finite(header.maxAgeMs) || header.maxAgeMs < maxAgeMs) return undefined;
	const files = new Map<string, FileState>();
	let damaged = 0;
	for (let index = 1; index < lines.length; index++) {
		const line = lines[index] as string;
		if (!line) continue;
		const decoded = decodeLine(line);
		if (!decoded) {
			damaged++;
			continue;
		}
		const [path, state, fragment] = decoded;
		// The line is this state's text: a save that keeps the state reuses it.
		encoded.set(state, fragment);
		files.set(path, state);
	}
	return { files, damaged };
}

export type IndexRead =
	| { state: "missing" }
	| { state: "unchanged" }
	| { state: "read"; files: Map<string, FileState>; damaged: number; stamp: IndexStamp }
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
		const decoded = decodeIndex(await handle.readFile("utf8"), maxAgeMs);
		return decoded ? { state: "read", ...decoded, stamp } : { state: "unusable", reason: "another version", stamp };
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
