/** Bounded, read-only durable evidence cache. Stat signatures also invalidate misses
 * and partial writes; a running child can publish evidence after the first render. */
import { readFileSync, readdirSync, statSync } from "node:fs";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_CACHE_BYTES = 64 * 1024 * 1024;
const cache = new Map<string, { signature: string; value: unknown; bytes: number }>();
let cacheBytes = 0;
export interface EvidenceBudget { bytes: number; }

function cached<T>(path: string, directory: boolean, load: () => T, budget?: EvidenceBudget): T | undefined {
	try {
		const stat = statSync(path);
		if (directory ? !stat.isDirectory() : !stat.isFile() || stat.size > MAX_FILE_BYTES) return;
		const signature = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
		const key = `${directory ? "dir" : "file"}:${path}`;
		const previous = cache.get(key);
		if (previous?.signature === signature) return previous.value as T;
		if (budget && !directory) {
			if (stat.size > budget.bytes) return;
			budget.bytes -= stat.size;
		}
		const value = load();
		if (previous) { cacheBytes -= previous.bytes; cache.delete(key); }
		const bytes = directory ? JSON.stringify(value).length : stat.size;
		cache.set(key, { signature, value, bytes });
		cacheBytes += bytes;
		while (cache.size > 256 || cacheBytes > MAX_CACHE_BYTES) {
			const first = cache.keys().next().value!;
			cacheBytes -= cache.get(first)!.bytes;
			cache.delete(first);
		}
		return value;
	} catch {
		// Do not memoize unreadable paths or malformed JSON as permanent misses.
		return;
	}
}

export function evidenceJson(path: string, budget?: EvidenceBudget): unknown {
	return cached(path, false, () => JSON.parse(readFileSync(path, "utf8")), budget);
}

export function evidenceLines(path: string, budget?: EvidenceBudget): unknown[] | undefined {
	return cached(path, false, () => {
		const entries: unknown[] = [];
		for (const line of readFileSync(path, "utf8").split("\n")) {
			if (!line.trim()) continue;
			try { entries.push(JSON.parse(line)); } catch { /* retain complete records during append */ }
		}
		return entries;
	}, budget);
}

export function evidenceFiles(path: string): string[] {
	return cached(path, true, () => readdirSync(path).sort()) ?? [];
}
