/**
 * The lock Pi takes around each settings.json write: proper-lockfile's
 * protocol with `realpath: false` (pi-coding-agent core/settings-manager.js),
 * which is the directory `settings.json.lock`. Whoever creates it holds the
 * lock; a lock whose mtime is older than 10 s is stale (proper-lockfile's
 * default), and the holder removes it when done.
 *
 * This is the same protocol, not the library: proper-lockfile would add four
 * runtime packages to every pi-extras install, and its sync API still arms
 * mtime timers. A hold here lasts one read and one write, far below the
 * stale time, so no timer is needed. tests/auto-update-settings.test.ts runs
 * it against Pi's own copy of proper-lockfile.
 */
import { mkdirSync, rmdirSync, statSync } from "node:fs";

/** proper-lockfile's default `stale`. */
export const STALE_MS = 10_000;
const DEFAULT_WAIT_MS = 5_000;
const RETRY_MS = 20;

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** True when the lock was taken; false while someone else holds a fresh one. */
function tryTake(lockDir: string, now: number): boolean {
	try {
		mkdirSync(lockDir);
		return true;
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
	}
	let mtime: number;
	try {
		mtime = statSync(lockDir).mtimeMs;
	} catch (error) {
		// Released between the two calls: try again at once.
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
	if (now - mtime <= STALE_MS) return false;
	try {
		rmdirSync(lockDir);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
	return false;
}

export interface SettingsLockOptions {
	readonly waitMs?: number;
	readonly now?: () => number;
}

/** Runs `work` while holding Pi's lock on `settingsFile`. Waits up to `waitMs`, then throws. */
export function withSettingsLock<T>(settingsFile: string, work: () => T, options: SettingsLockOptions = {}): T {
	const lockDir = `${settingsFile}.lock`;
	const now = options.now ?? Date.now;
	const deadline = now() + (options.waitMs ?? DEFAULT_WAIT_MS);
	while (!tryTake(lockDir, now())) {
		if (now() >= deadline) throw new Error("Pi is saving settings.json. Try again later.");
		sleepSync(RETRY_MS);
	}
	try {
		return work();
	} finally {
		try {
			rmdirSync(lockDir);
		} catch (error) {
			// Taken over as stale by someone else: it is theirs now.
			if (errorCode(error) !== "ENOENT") throw error;
		}
	}
}
