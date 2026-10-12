/**
 * A lock file shared by Pi processes: whoever creates `path` holds it. The
 * holder's pid is written to a temporary file and linked into place, so the
 * lock never appears empty. A lock whose pid is dead is taken over.
 *
 * One window remains: two processes can see the same dead lock, and the
 * second one's check can pass just after the first replaced it. The check
 * compares the inode and mtime it saw, which keeps that window to a few
 * system calls.
 */
import { randomBytes } from "node:crypto";
import { closeSync, linkSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { basename } from "node:path";

export interface LockOptions {
	/**
	 * An empty or unreadable lock younger than this belongs to a holder that
	 * has not written its pid yet (only on file systems without hard links),
	 * so it counts as held.
	 */
	readonly settleMs?: number;
	/** A lock older than this is taken over even when its pid is alive: the pid was reused, or the holder is stuck. */
	readonly staleMs?: number;
	readonly now?: () => number;
}

export interface FileLock {
	release(): void;
}

const DEFAULT_SETTLE_MS = 10_000;
/** A short lock is held for a few milliseconds; a holder this old has stopped. */
const SHORT_STALE_MS = 5_000;
const SHORT_WAIT_MS = 3_000;
const ATTEMPTS = 4;
const NO_HARD_LINKS = new Set(["EPERM", "ENOTSUP", "EXDEV"]);

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) === "EPERM";
	}
}

function writeExclusive(file: string, text: string): void {
	const fd = openSync(file, "wx", 0o600);
	try {
		writeFileSync(fd, text);
	} catch (error) {
		closeSync(fd);
		unlinkSync(file);
		throw error;
	}
	closeSync(fd);
}

/** True when linked, false when the lock exists, undefined when the file system has no hard links. */
function linkInto(temp: string, path: string): boolean | undefined {
	try {
		linkSync(temp, path);
		return true;
	} catch (error) {
		if (errorCode(error) === "EEXIST") return false;
		if (NO_HARD_LINKS.has(errorCode(error) ?? "")) return undefined;
		throw error;
	}
}

/** True when this call created the lock; false when the lock already exists. */
function publish(path: string, token: string): boolean {
	const temp = `${path}.${token.replace(" ", ".")}.tmp`;
	writeExclusive(temp, token);
	let linked: boolean | undefined;
	try {
		linked = linkInto(temp, path);
	} catch (error) {
		unlinkSync(temp);
		throw error;
	}
	try {
		unlinkSync(temp);
	} catch (error) {
		// Throwing now would hide a lock this call holds; a stray temporary file only costs space.
		if (!linked) throw error;
	}
	if (linked !== undefined) return linked;
	try {
		writeExclusive(path, token);
		return true;
	} catch (error) {
		if (errorCode(error) === "EEXIST") return false;
		throw error;
	}
}

type Holder = { readonly state: "gone" | "held" } | { readonly state: "stale"; readonly seen: Stats };

function readHolder(path: string): { readonly seen: Stats; readonly text: string | undefined } | undefined {
	let seen: Stats;
	try {
		seen = statSync(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
	try {
		return { seen, text: readFileSync(path, "utf8") };
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		// Unreadable counts like empty: the age decides.
		return { seen, text: undefined };
	}
}

function inspect(path: string, options: LockOptions): Holder {
	const holder = readHolder(path);
	if (!holder) return { state: "gone" };
	// A clock change or a network file system can date a lock in the future; count that distance as age too.
	const age = Math.abs((options.now ?? Date.now)() - holder.seen.mtimeMs);
	const pid = Number.parseInt(holder.text ?? "", 10);
	if (!Number.isInteger(pid) || pid <= 0) return age < (options.settleMs ?? DEFAULT_SETTLE_MS) ? { state: "held" } : { state: "stale", seen: holder.seen };
	if (options.staleMs !== undefined && age > options.staleMs) return { state: "stale", seen: holder.seen };
	return pidAlive(pid) ? { state: "held" } : { state: "stale", seen: holder.seen };
}

/** Removes the stale lock only if it is still the file that was judged stale. */
function removeStale(path: string, seen: Stats): void {
	try {
		const now = statSync(path);
		if (now.ino === seen.ino && now.mtimeMs === seen.mtimeMs) unlinkSync(path);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

function releaser(path: string, token: string): FileLock {
	return {
		release: () => {
			// A lock taken over as stale belongs to someone else now; leave it.
			try {
				if (readFileSync(path, "utf8") === token) unlinkSync(path);
			} catch (error) {
				if (errorCode(error) !== "ENOENT") throw error;
			}
		},
	};
}

/** Takes the lock at `path`, or returns undefined while a live process holds it. */
export function tryLock(path: string, options: LockOptions = {}): FileLock | undefined {
	const token = `${process.pid} ${randomBytes(6).toString("hex")}`;
	for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
		if (publish(path, token)) return releaser(path, token);
		const holder = inspect(path, options);
		if (holder.state === "held") return undefined;
		if (holder.state === "stale") removeStale(path, holder.seen);
	}
	return undefined;
}

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Runs `work` while holding `${file}.lock`: for one read, change and replace
 * of a small file that Pi processes share. Waits up to `waitMs` (3 s unless
 * given) for the lock, then throws.
 */
export function withFileLock<T>(file: string, work: () => T, waitMs = SHORT_WAIT_MS): T {
	const lock = waitForLock(`${file}.lock`, waitMs, { staleMs: SHORT_STALE_MS, settleMs: SHORT_STALE_MS });
	try {
		return work();
	} finally {
		lock.release();
	}
}

/**
 * Waits up to `waitMs` for the lock, blocking the thread. Only for locks held
 * a few milliseconds, such as one settings write.
 */
export function waitForLock(path: string, waitMs: number, options: LockOptions = {}): FileLock {
	const now = options.now ?? Date.now;
	const deadline = now() + waitMs;
	for (;;) {
		const lock = tryLock(path, options);
		if (lock) return lock;
		if (now() >= deadline) throw new Error(`Another Pi session is saving ${basename(path, ".lock")}. Try again.`);
		sleepSync(10);
	}
}
