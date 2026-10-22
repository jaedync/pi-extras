/**
 * sleep-watch: the `sleep` processes a running command has started, seen
 * from the outside, so its row can show how far a wait has got even when the
 * text can't say (`sleep $s`, a loop's passes).
 *
 * A command is found by what its processes share. A foreground bash call's
 * shell gets `PI_EXTRAS_RUN` in its environment, which every process under it
 * inherits; Linux shows a process's environment in /proc, macOS does not, so
 * there foreground calls go unwatched. A background job leads its own process
 * group, which both systems show.
 *
 * Scans run twice a second, only while some command is watched. One reads
 * each process's 6-byte `comm` and looks closer only at sleeps: 3 ms for 400
 * processes.
 */

import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import type { LiveSleeps, SeenSleep } from "./sleep-progress.ts";

export const RUN_VARIABLE = "PI_EXTRAS_RUN";

export interface SleepProcess {
	readonly pid: number;
	readonly pgid: number;
	/** When the process started, ms since the epoch. */
	readonly startedAt: number;
	readonly ms: number;
	/** Its `PI_EXTRAS_RUN`, where the system shows it. */
	readonly run?: string;
}

/** Whose sleeps: a foreground call's run, or a background job's process group. */
export type SleepOwner = { readonly run: string } | { readonly pgid: number };

const SCAN_MS = 500;
/** A watch nobody holds stops this long after anyone last asked about it. */
const IDLE_MS = 10_000;
const FIRST_KEPT = 8;
const RECENT_KEPT = 32;
/** Linux reports start times in clock ticks of 1/100 s (USER_HZ) on every architecture Node runs on. */
const TICKS_PER_SECOND = 100;
const UNIT_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const SLEEP_ARG = /^(\d+(?:\.\d+)?)([smhd]?)$/;

/** A sleep's length from its argv, as GNU sleep adds its arguments; none for `infinity` or anything else. */
export function sleepArgsMs(argv: readonly string[]): number | undefined {
	if (argv[0]?.split("/").at(-1) !== "sleep" || argv.length < 2) return undefined;
	let total = 0;
	for (const arg of argv.slice(1)) {
		const match = SLEEP_ARG.exec(arg);
		if (!match) return undefined;
		total += Number.parseFloat(match[1]!) * (UNIT_MS[match[2] || "s"] ?? 1_000);
	}
	return total > 0 ? Math.round(total) : undefined;
}

/** ps's elapsed time, `[[dd-]hh:]mm:ss`, in ms. */
export function parseEtime(text: string): number | undefined {
	const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d{2})$/.exec(text.trim());
	if (!match) return undefined;
	const [days, hours, minutes, seconds] = match.slice(1).map((part) => Number(part ?? 0));
	return (((days! * 24 + hours!) * 60 + minutes!) * 60 + seconds!) * 1_000;
}

const readText = (path: string): string | undefined => {
	try {
		return readFileSync(path, "latin1");
	} catch {
		// Gone since the listing, or another user's: neither is ours to watch.
		return undefined;
	}
};

function bootMs(proc: string): number | undefined {
	const btime = /^btime (\d+)$/m.exec(readText(`${proc}/stat`) ?? "");
	return btime ? Number(btime[1]) * 1_000 : undefined;
}

function linuxSleep(proc: string, pid: number, boot: number): SleepProcess | undefined {
	const ms = sleepArgsMs((readText(`${proc}/${pid}/cmdline`) ?? "").split("\0").filter(Boolean));
	const stat = readText(`${proc}/${pid}/stat`);
	if (ms === undefined || !stat) return undefined;
	// The fields after the command name, which may itself hold spaces or brackets.
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	const pgid = Number(fields[2]);
	const ticks = Number(fields[19]);
	if (!Number.isFinite(pgid) || !Number.isFinite(ticks)) return undefined;
	const run = (readText(`${proc}/${pid}/environ`) ?? "").split("\0").find((entry) => entry.startsWith(`${RUN_VARIABLE}=`))?.slice(RUN_VARIABLE.length + 1);
	return { pid, pgid, startedAt: boot + (ticks / TICKS_PER_SECOND) * 1_000, ms, ...(run ? { run } : {}) };
}

/** The sleeps running now, from /proc. */
export function linuxSleeps(proc = "/proc"): SleepProcess[] {
	const boot = bootMs(proc);
	if (boot === undefined) return [];
	const found: SleepProcess[] = [];
	for (const name of readdirSync(proc)) {
		if (!/^\d+$/.test(name) || readText(`${proc}/${name}/comm`) !== "sleep\n") continue;
		const sleep = linuxSleep(proc, Number(name), boot);
		if (sleep) found.push(sleep);
	}
	return found;
}

/** The sleeps running now, from ps; macOS shows no other process's environment, so no run. */
export function macSleeps(now = Date.now()): Promise<SleepProcess[]> {
	return new Promise((resolve) => {
		execFile("ps", ["-A", "-ww", "-o", "pid=,pgid=,etime=,command="], { timeout: 2_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
			if (error) return resolve([]);
			const found: SleepProcess[] = [];
			for (const line of stdout.split("\n")) {
				const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
				const elapsed = match ? parseEtime(match[3]!) : undefined;
				const ms = match ? sleepArgsMs(match[4]!.trim().split(/\s+/)) : undefined;
				if (match && elapsed !== undefined && ms !== undefined) found.push({ pid: Number(match[1]), pgid: Number(match[2]), startedAt: now - elapsed, ms });
			}
			resolve(found);
		});
	});
}

interface Timers {
	setInterval(fn: () => void, ms: number): unknown;
	clearInterval(handle: unknown): void;
}

interface Watched {
	refs: number;
	askedAt: number;
	count: number;
	/** The sleeps running at the last scan, so each is counted once. */
	seen: ReadonlySet<string>;
	first: SeenSleep[];
	recent: SeenSleep[];
	running?: SeenSleep;
}

const keyOf = (owner: SleepOwner) => ("run" in owner ? `run:${owner.run}` : `pgid:${owner.pgid}`);
const owns = (key: string, sleep: SleepProcess) => key === `pgid:${sleep.pgid}` || (sleep.run !== undefined && key === `run:${sleep.run}`);

export class SleepWatch {
	private readonly list: () => SleepProcess[] | Promise<SleepProcess[]>;
	private readonly now: () => number;
	private readonly timers: Timers;
	private readonly watched = new Map<string, Watched>();
	private handle: unknown;
	private scanning = false;

	constructor(options: { list: () => SleepProcess[] | Promise<SleepProcess[]>; now?: () => number; timers?: Timers }) {
		this.list = options.list;
		this.now = options.now ?? Date.now;
		this.timers = options.timers ?? { setInterval: (fn, ms) => setInterval(fn, ms).unref(), clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout) };
	}

	/** Watches an owner until the returned function is called. */
	watch(owner: SleepOwner): () => void {
		const key = keyOf(owner);
		const entry = this.entry(key);
		entry.refs++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			entry.refs--;
			if (entry.refs > 0) return;
			this.watched.delete(key);
			if (this.watched.size === 0) this.stop();
		};
	}

	/** What an owner's sleeps are so far; asking keeps the owner watched for a while. */
	sleeps(owner: SleepOwner): LiveSleeps | undefined {
		const key = keyOf(owner);
		const known = this.watched.get(key);
		const entry = known ?? this.entry(key);
		entry.askedAt = this.now();
		if (!known || entry.count === 0) return undefined;
		return { count: entry.count, first: [...entry.first], recent: [...entry.recent], ...(entry.running ? { running: entry.running } : {}) };
	}

	private entry(key: string): Watched {
		let entry = this.watched.get(key);
		if (!entry) {
			entry = { refs: 0, askedAt: this.now(), count: 0, seen: new Set(), first: [], recent: [] };
			this.watched.set(key, entry);
		}
		if (this.handle === undefined) this.handle = this.timers.setInterval(() => void this.scan(), SCAN_MS);
		return entry;
	}

	private async scan(): Promise<void> {
		if (this.scanning) return;
		this.scanning = true;
		try {
			const now = this.now();
			for (const [key, entry] of this.watched) if (entry.refs <= 0 && now - entry.askedAt > IDLE_MS) this.watched.delete(key);
			if (this.watched.size === 0) return this.stop();
			const sleeps = await this.list();
			for (const [key, entry] of this.watched) this.record(entry, sleeps.filter((sleep) => owns(key, sleep)));
		} catch {
			// A failed scan only leaves the rows without live progress until the next one.
		} finally {
			this.scanning = false;
		}
	}

	private record(entry: Watched, sleeps: readonly SleepProcess[]): void {
		let running: SeenSleep | undefined;
		const present = new Set<string>();
		for (const sleep of [...sleeps].sort((a, b) => a.startedAt - b.startedAt)) {
			const id = `${sleep.pid}:${Math.round(sleep.startedAt)}`;
			present.add(id);
			if (!entry.seen.has(id)) {
				const seen: SeenSleep = { index: entry.count++, startedAt: sleep.startedAt, ms: sleep.ms };
				if (entry.first.length < FIRST_KEPT) entry.first = [...entry.first, seen];
				entry.recent = [...entry.recent, seen].slice(-RECENT_KEPT);
			}
			running = entry.recent.find((seen) => seen.startedAt === sleep.startedAt) ?? running;
		}
		entry.seen = present;
		entry.running = running;
	}

	private stop(): void {
		if (this.handle !== undefined) this.timers.clearInterval(this.handle);
		this.handle = undefined;
	}
}

const SHARED = Symbol.for("pi-extras.sleep-watch.v1");

/** One watch for every extension in this process, so a job and a call are scanned once together. */
export function sharedSleepWatch(): SleepWatch {
	const host = globalThis as { [SHARED]?: SleepWatch };
	host[SHARED] ??= new SleepWatch({ list: process.platform === "linux" ? () => linuxSleeps() : process.platform === "darwin" ? () => macSleeps() : () => [] });
	return host[SHARED];
}
