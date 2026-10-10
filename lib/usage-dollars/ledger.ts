/**
 * Spend on this machine, read from Pi session files: every assistant turn's
 * recorded cost, by provider and model. Main sessions, forks and subagent
 * sessions all live under the sessions directory; a turn copied into a fork
 * keeps its response id, so it counts once.
 *
 * Reads are incremental: each file is read from where the last refresh
 * stopped, and only files touched within the window are opened. A cold read
 * of a busy week (550 MB) took under a second.
 */
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface SpendRecord {
	ts: number;
	provider: string;
	model: string;
	cost: number;
	id: string;
}

export interface SpendLedgerOptions {
	root: string;
	/** Records and files older than this are dropped. */
	maxAgeMs: number;
	/** Refreshes closer together than this reuse the last read. */
	minRefreshMs: number;
}

export interface SpendLedger {
	refresh(now: number): Promise<void>;
	sum(query: { provider: string; sinceMs: number; untilMs: number; family?: string }): number;
	byProvider(sinceMs: number, untilMs: number): Record<string, number>;
	models(provider: string, sinceMs: number): string[];
}

interface FileState {
	offset: number;
	records: SpendRecord[];
}

const CHUNK_BYTES = 8 * 1024 * 1024;
// Pi writes the role near the start of each line; tool results, the bulk of the bytes, are never parsed.
const HEAD_CHARS = 600;
const NEWLINE = 0x0a;

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function familyMatches(model: string, family: string): boolean {
	return model.toLowerCase().split(/[^a-z0-9]+/).includes(family.toLowerCase());
}

export function parseSpendLine(text: string): SpendRecord | undefined {
	if (!text.slice(0, HEAD_CHARS).includes('"role":"assistant"')) return undefined;
	let entry: { timestamp?: unknown; message?: Record<string, unknown> };
	try {
		entry = JSON.parse(text);
	} catch {
		return undefined;
	}
	const message = entry.message;
	if (!message || message.role !== "assistant") return undefined;
	const usage = message.usage as { cost?: unknown; totalTokens?: unknown } | undefined;
	const rawCost = typeof usage?.cost === "object" && usage.cost ? (usage.cost as { total?: unknown }).total : usage?.cost;
	const ts = finite(message.timestamp) ? message.timestamp : Date.parse(String(entry.timestamp));
	if (!finite(rawCost) || rawCost < 0 || !finite(ts)) return undefined;
	const provider = typeof message.provider === "string" ? message.provider : "unknown";
	const model = typeof message.model === "string" ? message.model : "unknown";
	const id = typeof message.responseId === "string" && message.responseId
		? `${provider}:${message.responseId}`
		: `${ts}|${provider}|${model}|${String(usage?.totalTokens)}`;
	return { ts, provider, model, cost: rawCost, id };
}

async function sessionFiles(dir: string, sinceMs: number, found: Map<string, number> = new Map()): Promise<Map<string, number>> {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return found;
	}
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			await sessionFiles(path, sinceMs, found);
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			try {
				const info = await stat(path);
				if (info.mtimeMs >= sinceMs) found.set(path, info.size);
			} catch {
				// Removed between listing and stat.
			}
		}
	}
	return found;
}

/** Complete lines appended since `offset`; a trailing partial line is left for the next read. */
async function readAppended(path: string, offset: number, size: number): Promise<{ lines: string[]; offset: number }> {
	const handle = await open(path, "r");
	const lines: string[] = [];
	let position = offset;
	let carry = Buffer.alloc(0);
	try {
		while (position < size) {
			const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, size - position));
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
			if (bytesRead === 0) break;
			position += bytesRead;
			const data = carry.length ? Buffer.concat([carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
			const last = data.lastIndexOf(NEWLINE);
			if (last < 0) {
				carry = data;
				continue;
			}
			lines.push(...data.subarray(0, last).toString("utf8").split("\n"));
			carry = data.subarray(last + 1);
		}
	} finally {
		await handle.close();
	}
	return { lines, offset: position - carry.length };
}

export function createSpendLedger(options: SpendLedgerOptions): SpendLedger {
	const files = new Map<string, FileState>();
	let lastRefresh = -Infinity;
	let pending: Promise<void> | undefined;

	async function readFile(path: string, size: number, cutoff: number): Promise<void> {
		const known = files.get(path);
		// A file that shrank was rewritten; its old records no longer describe it.
		const state = known && size >= known.offset ? known : { offset: 0, records: [] };
		if (size > state.offset) {
			const read = await readAppended(path, state.offset, size);
			const added = read.lines.map(parseSpendLine).filter((record): record is SpendRecord => !!record);
			state.records = [...state.records, ...added];
			state.offset = read.offset;
		}
		state.records = state.records.filter((record) => record.ts >= cutoff);
		files.set(path, state);
	}

	async function doRefresh(now: number): Promise<void> {
		const cutoff = now - options.maxAgeMs;
		const found = await sessionFiles(options.root, cutoff);
		for (const path of [...files.keys()]) if (!found.has(path)) files.delete(path);
		for (const [path, size] of found) {
			try {
				await readFile(path, size, cutoff);
			} catch {
				// An unreadable file counts as no spend rather than failing the report.
				files.delete(path);
			}
		}
		lastRefresh = now;
	}

	function unique(sinceMs: number, untilMs: number): SpendRecord[] {
		const seen = new Set<string>();
		const result: SpendRecord[] = [];
		for (const state of files.values()) {
			for (const record of state.records) {
				if (record.ts < sinceMs || record.ts > untilMs || seen.has(record.id)) continue;
				seen.add(record.id);
				result.push(record);
			}
		}
		return result;
	}

	return {
		async refresh(now) {
			if (now - lastRefresh < options.minRefreshMs) return;
			pending ??= doRefresh(now).finally(() => { pending = undefined; });
			await pending;
		},
		sum({ provider, sinceMs, untilMs, family }) {
			return unique(sinceMs, untilMs)
				.filter((record) => record.provider === provider && (!family || familyMatches(record.model, family)))
				.reduce((total, record) => total + record.cost, 0);
		},
		byProvider(sinceMs, untilMs) {
			const totals: Record<string, number> = {};
			for (const record of unique(sinceMs, untilMs)) totals[record.provider] = (totals[record.provider] ?? 0) + record.cost;
			return totals;
		},
		models(provider, sinceMs) {
			return [...new Set(unique(sinceMs, Infinity).filter((record) => record.provider === provider).map((record) => record.model))];
		},
	};
}
