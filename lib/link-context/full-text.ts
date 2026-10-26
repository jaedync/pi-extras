/**
 * The whole result of a long pull, kept in a file. pull_link and auto-pull
 * show a preview of such a result; the file lets the agent read or search the
 * rest with its own tools instead of paging through it call by call.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LINK_CHARS } from "./auto-message.ts";
import { untrusted } from "./format.ts";
import { mediaHome } from "./media/provision.ts";
import type { Pulled } from "./types.ts";

/** Results longer than this get a file: auto-pull's limit for one link, the shortest one that shows a result. */
export const SAVE_CHARS = LINK_CHARS;
/** Files older than this are removed when a new one is saved. */
const KEEP_MS = 7 * 86_400_000;
/** At most this many files are kept, newest first. */
const KEEP_FILES = 200;
/** A temporary file this old was left by a write that never finished. */
const TEMP_MS = 3_600_000;

export function fullTextDir(): string {
	return join(mediaHome(), "full-text");
}

/** One name for one result, so a second read of the same text reuses its file. */
export function fullTextName(pulled: Pulled): string {
	const platform = pulled.platform.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24) || "link";
	const hash = createHash("sha256").update(pulled.url).update("\n").update(pulled.markdown).digest("hex").slice(0, 16);
	return `${platform}-${hash}.md`;
}

function prune(dir: string, keep: string, now: number): void {
	const names = readdirSync(dir);
	// Another process can rename or remove a file between the listing and its stat; such a file is skipped.
	const files = names.flatMap((name) => {
		const path = join(dir, name);
		try {
			return [{ name, path, at: statSync(path).mtimeMs }];
		} catch {
			return [];
		}
	});
	for (const file of files.filter((item) => item.name.startsWith(".") && item.name.endsWith(".tmp"))) {
		if (now - file.at > TEMP_MS) rmSync(file.path, { force: true });
	}
	const kept = files.filter((file) => file.name.endsWith(".md") && file.name !== keep).sort((a, b) => b.at - a.at);
	kept.forEach((file, index) => {
		if (now - file.at > KEEP_MS || index >= KEEP_FILES - 1) rmSync(file.path, { force: true });
	});
}

/**
 * Writes the whole result, in the same untrusted wrapper the tool uses, and
 * returns its path. Owner-only permissions: the text can come from a link the
 * user did not mean to share with other accounts on the machine.
 */
export function saveFullText(pulled: Pulled, dir = fullTextDir(), now = Date.now()): string {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	// mkdir does not change a folder that exists; an older or hand-made one may let others list the names.
	chmodSync(dir, 0o700);
	const name = fullTextName(pulled);
	const path = join(dir, name);
	if (!existsSync(path)) {
		// A temporary name and a rename, so a reader never sees half a file.
		const temporary = join(dir, `.${name}.${process.pid}.tmp`);
		writeFileSync(temporary, `${untrusted(pulled.url, pulled.markdown)}\n`, { mode: 0o600 });
		renameSync(temporary, path);
	} else {
		// A reused file counts as new, so pruning does not remove it while the cache still names it.
		utimesSync(path, now / 1000, now / 1000);
	}
	try {
		prune(dir, name, now);
	} catch {
		// Old files staying one more time does no harm; the new file is written.
	}
	return path;
}
