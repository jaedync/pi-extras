/**
 * Limit polls shared by every Pi process of one agent directory. Pi sessions on
 * one machine share one account, and Anthropic rate-limits its usage endpoint
 * per account: processes that each polled on their own clock got 429s, and a
 * new session showed no budget. One file per provider records the newest
 * successful poll and the last try by any process, so the processes poll once
 * between them and a new session shows the last result at once.
 *
 * Writes go through a temporary file and a rename, so a reader sees the old
 * file or the new one. A lost race costs one extra poll, never a wrong value.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LimitEntry } from "./status-plus-logic.ts";

export interface SharedPoll {
	/** When the newest successful poll ended; absent until one succeeds. */
	atMs?: number;
	entries?: LimitEntry[];
	/** The last try by any process, successful or not. */
	triedAtMs: number;
	/** Failed tries since the last success: one backoff for every process. */
	failures: number;
	/** The provider asked to wait until then (Retry-After). */
	retryAtMs?: number;
}

const fileFor = (dir: string, provider: string): string => join(dir, `${provider.replace(/[^a-z0-9._-]/gi, "_")}.json`);
const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isEntry = (value: unknown): value is LimitEntry => !!value && typeof value === "object" && typeof (value as LimitEntry).label === "string";

function valid(value: unknown): value is SharedPoll {
	const poll = value as Partial<SharedPoll> | null;
	if (!poll || typeof poll !== "object" || !isTime(poll.triedAtMs) || !isTime(poll.failures)) return false;
	if (poll.atMs !== undefined && !isTime(poll.atMs)) return false;
	if (poll.retryAtMs !== undefined && !isTime(poll.retryAtMs)) return false;
	return poll.entries === undefined || (Array.isArray(poll.entries) && poll.entries.every(isEntry));
}

/** The shared poll for a provider, or undefined when there is none or the file is not one. */
export function readShared(dir: string, provider: string): SharedPoll | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(fileFor(dir, provider), "utf8"));
		return valid(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

export function writeShared(dir: string, provider: string, poll: SharedPoll): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = fileFor(dir, provider);
	const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(poll), { mode: 0o600 });
		renameSync(temp, file);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/** When this process may poll: one gap after the last try by any process, and not before a wait the provider asked for. */
export function nextPollMs(localTriedMs: number, shared: SharedPoll | undefined, gapMs: number): number {
	return Math.max(Math.max(localTriedMs, shared?.triedAtMs ?? 0) + gapMs, shared?.retryAtMs ?? 0);
}
