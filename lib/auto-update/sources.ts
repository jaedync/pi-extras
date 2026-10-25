/**
 * Which settings.json `packages` entries auto-update manages, and how a set
 * rewrites them. Managed: `npm:<name>` without a version, and git sources
 * without a ref, plus entries that already name a store folder. Pinned
 * entries and other local paths stay as the user wrote them.
 *
 * Git source parsing follows Pi's own (pi-coding-agent utils/git.js
 * splitRef), so an entry counts as pinned here exactly when Pi pins it.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ManagedEntry, UpdateSet } from "./state.ts";

export type Origin =
	| { readonly kind: "npm"; readonly source: string; readonly name: string; readonly key: string; readonly label: string }
	| { readonly kind: "git"; readonly source: string; readonly url: string; readonly key: string; readonly label: string };

export type Classified =
	| { readonly kind: "managed"; readonly origin: Origin }
	| { readonly kind: "store"; readonly key: string }
	| { readonly kind: "pinned" }
	| { readonly kind: "local" };

const NPM_SPEC = /^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/;

/** A store key: lowercase letters, digits, dots and dashes only. */
function slug(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^[-.]+|-+$/g, "").replace(/-{2,}/g, "-");
}

/** The repository and the ref after `@`, as Pi splits them. */
function splitRef(url: string): { repo: string; ref?: string } {
	const scp = url.match(/^git@([^:]+):(.+)$/);
	const at = (path: string, rebuild: (repoPath: string) => string) => {
		const index = path.indexOf("@");
		if (index < 0) return { repo: url };
		const repoPath = path.slice(0, index);
		const ref = path.slice(index + 1);
		return repoPath && ref ? { repo: rebuild(repoPath), ref } : { repo: url };
	};
	if (scp) return at(scp[2] ?? "", (repoPath) => `git@${scp[1]}:${repoPath}`);
	if (url.includes("://")) {
		try {
			const parsed = new URL(url);
			return at(parsed.pathname.replace(/^\/+/, ""), (repoPath) => {
				parsed.pathname = `/${repoPath}`;
				return parsed.toString().replace(/\/$/, "");
			});
		} catch {
			return { repo: url };
		}
	}
	const slash = url.indexOf("/");
	if (slash < 0) return { repo: url };
	return at(url.slice(slash + 1), (repoPath) => `${url.slice(0, slash)}/${repoPath}`);
}

/** Host and path of a git repository, for its key. Credentials never reach the key. */
function hostPath(repo: string): { host: string; path: string } | undefined {
	const scp = repo.match(/^git@([^:]+):(.+)$/);
	if (scp) return { host: scp[1] ?? "", path: scp[2] ?? "" };
	try {
		const parsed = new URL(repo.includes("://") ? repo : `https://${repo}`);
		return { host: parsed.hostname, path: parsed.pathname.replace(/^\/+/, "") };
	} catch {
		return undefined;
	}
}

function classifyGit(source: string): Classified {
	const prefixed = source.startsWith("git:");
	const url = prefixed ? source.slice(4).trim() : source;
	if (url.includes("#")) return { kind: "pinned" };
	const split = splitRef(url);
	if (split.ref) return { kind: "pinned" };
	const where = hostPath(split.repo);
	const path = where?.path.replace(/\.git$/, "").replace(/\/+$/, "");
	if (!where?.host || !path || path.split("/").length < 2) return { kind: "local" };
	const isUrl = /^(https?|ssh|git):\/\//i.test(split.repo) || split.repo.startsWith("git@");
	const cloneUrl = isUrl ? split.repo : `https://${split.repo}`;
	return { kind: "managed", origin: { kind: "git", source, url: cloneUrl, key: `git-${slug(`${where.host}/${path}`)}`, label: path.split("/").at(-1) ?? path } };
}

/** The key of a store path `<root>/packages/<key>/...`, or undefined. */
function storeKey(path: string, storeRoot: string): string | undefined {
	if (!isAbsolute(path)) return undefined;
	const rel = relative(resolve(storeRoot, "packages"), resolve(path));
	if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
	const parts = rel.split(sep);
	return parts.length >= 2 ? parts[0] : undefined;
}

export function classify(source: string, storeRoot: string): Classified {
	const trimmed = source.trim();
	if (trimmed.startsWith("npm:")) {
		const match = trimmed.slice(4).trim().match(NPM_SPEC);
		if (!match?.[1]) return { kind: "local" };
		if (match[2]) return { kind: "pinned" };
		return { kind: "managed", origin: { kind: "npm", source: trimmed, name: match[1], key: `npm-${slug(match[1])}`, label: match[1] } };
	}
	if (trimmed.startsWith("git:") || /^(https?|ssh|git):\/\//i.test(trimmed)) return classifyGit(trimmed);
	const key = storeKey(trimmed, storeRoot);
	return key ? { kind: "store", key } : { kind: "local" };
}

/** The source of a settings entry: the string, or an object's `source`. */
export function entrySource(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry === "object" && typeof (entry as { source?: unknown }).source === "string") return (entry as { source: string }).source;
	return undefined;
}

/** The entry with another source; an object keeps its filters. */
export function withSource(entry: unknown, source: string): unknown {
	return typeof entry === "string" ? source : { ...(entry as Record<string, unknown>), source };
}

/** The store key of a managed or stored entry, or undefined for every other entry. */
export function entryKey(entry: unknown, storeRoot: string): string | undefined {
	const source = entrySource(entry);
	if (source === undefined) return undefined;
	const classified = classify(source, storeRoot);
	if (classified.kind === "managed") return classified.origin.key;
	if (classified.kind === "store") return classified.key;
	return undefined;
}

/** `packages` with every managed entry naming its release in `set`. Other entries are unchanged. */
export function applySet(packages: readonly unknown[], set: UpdateSet, storeRoot: string): unknown[] {
	return packages.map((entry) => {
		const key = entryKey(entry, storeRoot);
		const release = key === undefined ? undefined : set.packages[key];
		return release ? withSource(entry, release.entry) : entry;
	});
}

/** `packages` with every store entry back to what the user had before `enable`. */
export function restoreOriginals(packages: readonly unknown[], managed: Readonly<Record<string, ManagedEntry>>, storeRoot: string): unknown[] {
	return packages.map((entry) => {
		const source = entrySource(entry);
		const classified = source === undefined ? undefined : classify(source, storeRoot);
		if (classified?.kind !== "store") return entry;
		const original = managed[classified.key];
		if (!original) return entry;
		// Filters the user changed since keep their new value; only the source goes back.
		const originalSource = entrySource(original.original) ?? original.origin;
		return withSource(entry, originalSource);
	});
}
