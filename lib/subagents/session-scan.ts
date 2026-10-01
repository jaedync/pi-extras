/** Parse-only scanning preserves empty files and shares stable transcript identities with inspectors. */
import { readFileSync, statSync } from "node:fs";
import type { FileEntry, SessionEntry } from "@earendil-works/pi-coding-agent";

const CACHE_LIMIT = 64;
type Parser = (text: string) => FileEntry[];
interface Snapshot { stamp: string; branch: SessionEntry[]; messages: readonly unknown[] }

export function createSessionScanner(parse: Parser, migrate: (entries: FileEntry[]) => void) {
	const cache = new Map<string, Snapshot>();
	const snapshot = (file: string): Snapshot => {
		const stat = statSync(file);
		const stamp = `${stat.mtimeMs}:${stat.size}`;
		const cached = cache.get(file);
		if (cached?.stamp === stamp) {
			cache.delete(file);
			cache.set(file, cached);
			return cached;
		}
		const entries = parse(readFileSync(file, "utf8"));
		const header = entries[0];
		if (!header || header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string") throw new Error(`Not a Pi session: ${file}`);
		migrate(entries);
		const byId = new Map(entries.slice(1).map((entry) => [entry.id, entry as SessionEntry]));
		const branch: SessionEntry[] = [];
		const seen = new Set<string>();
		let current = entries.at(-1) as SessionEntry | undefined;
		while (current && current.type !== "session" as string) {
			if (typeof current.id !== "string" || seen.has(current.id)) throw new Error(`Invalid Pi session branch: ${file}`);
			seen.add(current.id);
			branch.push(current);
			current = current.parentId ? byId.get(current.parentId) : undefined;
		}
		branch.reverse();
		const result = { stamp, branch, messages: branch.filter((entry) => entry.type === "message").map((entry) => (entry as { message: unknown }).message) };
		cache.delete(file);
		cache.set(file, result);
		if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
		return result;
	};
	return { branch: (file: string) => snapshot(file).branch, messages: (file: string) => snapshot(file).messages };
}
