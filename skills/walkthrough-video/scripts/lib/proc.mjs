/**
 * Small process and time helpers shared by capture, setup and gates.
 *
 * Every process wv starts stays in wv's own process group: the tool that runs
 * wv stops it with one SIGKILL to the group, and a child in its own session
 * would outlive that kill with no parent to stop it. HyperFrames starts Chrome
 * and ffmpeg below its child, so wv stops a whole tree itself.
 *
 * A tree entry is a pid plus the start time of that process. The start time is
 * the identity: a pid that a process already left can belong to a new process,
 * and a signal to that new process would stop something wv does not own. One
 * snapshot of the process table is taken immediately before the first signal,
 * so a descendant that its parent reparents during the stop is still in it. A
 * process that left wv's tree before that snapshot is out of scope (see
 * references/troubleshooting.md).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, delimiter, join } from "node:path";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** The walk stops here, so a runaway fork cannot make it unbounded. */
export const MAX_TREE = 5000;

/** The fields after the process name in /proc/<pid>/stat: state, ppid and start time. */
function statRow(text) {
	const close = text.lastIndexOf(")");
	if (close < 0) return null;
	const fields = text.slice(close + 2).trim().split(/\s+/);
	// Field 3 is fields[0], so ppid (field 4) is fields[1] and starttime (field 22) is fields[19].
	const ppid = Number(fields[1]);
	const start = fields[19];
	return Number.isInteger(ppid) && start ? { ppid, start } : null;
}

/** The process table from /proc: one pass, so every parent link comes from the same instant. */
export function linuxReader() {
	const stat = (pid) => {
		try {
			return statRow(readFileSync(`/proc/${pid}/stat`, "utf8"));
		} catch {
			return null;
		}
	};
	return {
		start: (pid) => stat(pid)?.start,
		table() {
			const rows = new Map();
			let names = [];
			try {
				names = readdirSync("/proc");
			} catch {
				// The same contract as the ps reader: a failed read is null, not an empty table.
				return null;
			}
			for (const name of names) {
				if (!/^\d+$/.test(name)) continue;
				const row = stat(Number(name));
				if (row) rows.set(Number(name), row);
			}
			return rows;
		},
		/** The entries whose start time still matches, read one by one: a stop polls this. */
		alive(entries) {
			return entries.filter((entry) => stat(entry.pid)?.start === entry.start);
		},
	};
}

/**
 * The process table from ps, for a host without /proc (macOS): one call for the
 * whole table, one call for a liveness poll. A failed call is "unknown", never
 * "matching": no previous table is reused.
 */
export function psReader({ exec = (args) => spawnSync("ps", args, { encoding: "utf8", timeout: 10000 }) } = {}) {
	const ps = (args) => {
		const result = exec(args);
		const status = result?.status ?? (typeof result === "string" ? 0 : 1);
		if (status === 0 && typeof result?.stdout === "string") return result.stdout;
		// No listed pid exists: ps exits 1 with no output and no message (procps and macOS).
		// That is an empty answer; read as unknown, every stop waited out its deadline.
		if (status === 1 && result?.stdout === "" && result?.stderr === "") return "";
		return null;
	};
	return {
		start(pid) {
			const text = ps(["-p", String(pid), "-o", "pid=,lstart="]);
			const row = text ? /^\s*\d+\s+(.+?)\s*$/m.exec(text) : null;
			return row ? row[1] : undefined;
		},
		table() {
			const rows = new Map();
			const text = ps(["-A", "-o", "pid=,ppid=,lstart="]);
			// A failed read is null, not an empty table: the caller must report its saved roots.
			if (text === null) return null;
			for (const line of text.split("\n")) {
				const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
				if (match) rows.set(Number(match[1]), { ppid: Number(match[2]), start: match[3] });
			}
			return rows;
		},
		alive(entries) {
			if (!entries.length) return [];
			const text = ps(["-p", entries.map((entry) => entry.pid).join(","), "-o", "pid=,lstart="]);
			// A failed ps is unknown, never "all gone": the caller must report the pids, not clean up over them.
			if (text === null) return null;
			const found = new Map();
			for (const line of text.split("\n")) {
				const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
				if (match) found.set(Number(match[1]), match[2]);
			}
			return entries.filter((entry) => found.get(entry.pid) === entry.start);
		},
	};
}

/** The reader for this host. */
export function detectReader() {
	return existsSync("/proc/self/stat") ? linuxReader() : psReader();
}

/**
 * Every process at or below `roots`, each with its start time, from one table.
 * A root is an identity `{pid, start}`: a root whose start time differs, or
 * whose process is gone, is skipped and never signalled. A descendant counts
 * only through a parent link inside the same table. Iterative, so a deep chain
 * cannot overflow the stack; deduplicated; the cap applies before an entry is
 * added, and `truncated` says that the tree was cut.
 * @param {{pid: number, start: string}[]} roots
 * @param {Map<number, {ppid: number, start: string}> | null} table
 */
export function snapshotTree(roots, table) {
	/** @type {{pid: number, start: string}[]} */
	const entries = [];
	// Without a table nothing can be verified, so the saved roots stand as unresolved targets:
	// the identity check before each signal still protects against a reused pid.
	if (!table) return { entries: roots.filter(Boolean), truncated: false };
	const seen = new Set();
	const childrenOf = new Map();
	for (const [pid, row] of table) {
		if (!childrenOf.has(row.ppid)) childrenOf.set(row.ppid, []);
		childrenOf.get(row.ppid).push(pid);
	}
	const queue = [];
	for (const root of roots) {
		if (!root) continue;
		const row = table.get(root.pid);
		if (!row || row.start !== root.start) continue;
		queue.push(root.pid);
	}
	while (queue.length) {
		const pid = queue.shift();
		if (seen.has(pid)) continue;
		if (entries.length >= MAX_TREE) return { entries, truncated: true };
		const row = table.get(pid);
		seen.add(pid);
		if (!row) continue;
		entries.push({ pid, start: row.start });
		for (const child of childrenOf.get(pid) ?? []) if (!seen.has(child)) queue.push(child);
	}
	return { entries, truncated: false };
}

async function waitUntil(done, ms, wait) {
	const until = Date.now() + ms;
	while (!done() && Date.now() < until) await wait(50);
}

/**
 * Signals a snapshot with SIGTERM, waits for the processes to go, then signals
 * the rest with SIGKILL. The identity of a target is checked immediately before
 * each signal, so a pid that another process took over after an earlier signal
 * is left alone. A failed read is "unknown": the stop retries within its
 * deadline and then reports the identities it could not settle.
 *
 * `lstart` has one second of precision, so on macOS a pid that changes owner
 * within the same second is not told apart: identity is best effort there.
 * @param {{entries: {pid: number, start: string}[], truncated?: boolean}[]} snapshots
 * @param {{graceMs?: number, killMs?: number, signal?: (pid: number, name: string) => void, reader?: any, wait?: (ms: number) => Promise<void>, onError?: (error: any, pid: number, name: string) => void, onSignal?: (pid: number, name: string) => void}} [options]
 */
export async function stopTrees(snapshots, { graceMs = 5000, killMs = 2000, signal = process.kill, reader = detectReader(), wait = sleep, onError = () => {}, onSignal = () => {} } = {}) {
	const seen = new Set();
	/** @type {{pid: number, start: string}[]} */
	const entries = [];
	let truncated = false;
	for (const snap of snapshots) {
		if (!snap) continue;
		truncated ||= Boolean(snap.truncated);
		for (const entry of snap.entries) {
			if (seen.has(entry.pid)) continue;
			seen.add(entry.pid);
			entries.push(entry);
		}
	}
	/** The signal that was sent last, for a deadline report. */
	let lastSignal = null;
	const send = (entry, name) => {
		// Immediately before the signal: an earlier signal can have let another process take the pid.
		if (reader.start(entry.pid) !== entry.start) return false;
		try {
			signal(entry.pid, name);
			lastSignal = name;
			onSignal(entry.pid, name);
			return true;
		} catch (error) {
			// ESRCH: the process ended between the check and the signal. Anything else is worth a warning.
			if (error?.code !== "ESRCH") onError(error, entry.pid, name);
			return false;
		}
	};
	/** Polls until none of `targets` is alive, `ms` passes, or the read fails (null = unknown). */
	const settle = async (targets, ms) => {
		const until = Date.now() + ms;
		let alive = reader.alive(targets);
		// An unknown read is retried until the deadline: it is not evidence that the processes are gone.
		while (Date.now() < until && (alive === null || alive.length)) {
			await wait(alive === null ? 100 : 50);
			alive = reader.alive(targets);
		}
		return alive;
	};
	// Children first, so a parent cannot fork a new child on its way out.
	for (const entry of [...entries].reverse()) send(entry, "SIGTERM");
	const afterTerm = await settle(entries, graceMs);
	// With an unknown table every identity is checked again per signal, so an unknown state still escalates safely.
	const stubborn = afterTerm === null ? entries : afterTerm;
	let escalated = false;
	for (const entry of stubborn) if (send(entry, "SIGKILL")) escalated = true;
	if (stubborn.length) await settle(entries, killMs);
	const final = reader.alive(entries);
	return { survivors: final ?? [], unresolved: final === null ? entries : [], truncated, escalated, lastSignal };
}

/** A tracked child and its identity at spawn. */
/** @type {Set<{child: import("node:child_process").ChildProcess, root: {pid: number, start: string} | null}>} */
const children = new Set();

/**
 * Spawns a child in wv's own process group and tracks it with its identity at
 * spawn. There is no polling: one snapshot of the process table is taken right
 * before the first signal, which is the only moment the tree matters.
 */
export function spawnChild(command, args, options = {}) {
	const child = spawn(command, args, options);
	const start = child.pid ? detectReader().start(child.pid) : undefined;
	/** @type {{child: any, root: {pid: number, start: string} | null}} */
	const record = { child, root: child.pid && start ? { pid: child.pid, start } : null };
	children.add(record);
	// Exit, not close: a descendant can hold the pipes open after the child is gone.
	const forget = () => children.delete(record);
	child.once("exit", forget);
	child.once("error", forget);
	return child;
}

/** The tracked children that are still alive. */
export function liveChildPids() {
	return [...children].map((record) => record.child.pid).filter((pid) => Number.isInteger(pid) && pid > 0);
}

/**
 * Stops the trees of every tracked child. One table is read, then the walk
 * starts from each saved root and from wv itself, so a child that is still
 * linked to wv is found even when its saved start time cannot be read.
 */
export async function stopChildTrees(options = {}) {
	const reader = options.reader ?? detectReader();
	const table = reader.table();
	const roots = [...children].map((record) => record.root).filter((root) => root?.start);
	// A failed read (null) leaves only the saved roots, which stopTrees reports as unresolved.
	const self = table?.get(process.pid);
	if (self) roots.push({ pid: process.pid, start: self.start });
	// wv walks from itself to find what is still attached to it, but it never signals itself.
	const snapshot = snapshotTree(roots, table);
	snapshot.entries = snapshot.entries.filter((entry) => entry.pid !== process.pid);
	return stopTrees([snapshot], { ...options, reader });
}

/** Rejects with a named timeout so a hung CDP call does not hang the capture. */
export function withTimeout(promise, ms, what) {
	let timer;
	const timeout = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${what} did not answer within ${Math.round(ms / 1000)} s`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** How long a killed run waits for its stop to finish before it resolves anyway. */
const PIPE_CLOSE_MS = 5000;

/**
 * Waits for `promise` until `ms`, and clears the deadline timer on every path:
 * a leftover five-second timer kept a finished worker alive.
 */
async function bounded(promise, ms, fallback) {
	let timer;
	const deadline = new Promise((resolve) => {
		timer = setTimeout(() => resolve(fallback), ms);
	});
	try {
		return await Promise.race([promise, deadline]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The shared body of run and runStreaming. A timeout stops this command's tree, and
 * the promise settles only after the stop has finished (or its deadline has
 * passed), never on the child's close alone: a cooperative parent can close
 * while a descendant that ignores SIGTERM still runs.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, maxBuffer?: number, stopDeadlineMs?: number, stdio?: any, onLine?: (line: string, stream: string) => void, onError?: (error: any, pid: number, name: string) => void}} [options]
 */
function runProcess(command, args, { cwd, env, timeoutMs = 10 * 60_000, maxBuffer = 64 * 1024 * 1024, stopDeadlineMs = PIPE_CLOSE_MS, stdio = ["ignore", "pipe", "pipe"], onLine, onError } = {}) {
	return new Promise((resolve, reject) => {
		let child;
		try {
			child = spawnChild(command, args, { cwd, env: env ?? process.env, stdio });
		} catch (error) {
			reject(error);
			return;
		}
		const out = [];
		const err = [];
		const split = (sink) => {
			let rest = "";
			return (chunk) => {
				sink.push(chunk);
				if (!onLine) return;
				const parts = (rest + chunk.toString()).split(/\r\n|\r|\n/);
				rest = parts.pop();
				for (const line of parts) if (line.trim()) onLine(line.trim(), "stdout");
			};
		};
		let timedOut = false;
		let stopResult = null;
		let closed = null;
		let settled = false;
		let overCap = false;
		/** The last signal the stop sent, for the case where its deadline wins. */
		const progress = { lastSignal: null };
		const finish = () => {
			// A timeout waits for the stop: the close event can come first.
			if (settled || (timedOut && !stopResult)) return;
			settled = true;
			clearTimeout(timer);
			child.stdout?.destroy();
			child.stderr?.destroy();
			// A timed-out command is never a success, also when its child exits 0 after the signal.
			const code = timedOut ? null : (closed?.code ?? null);
			const signal = closed?.signal ?? stopResult?.signal ?? null;
			resolve({ code, signal, timedOut, overCap, unresolved: stopResult?.unresolved ?? [], stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8") });
		};
		const record = [...children].find((entry) => entry.child === child);
		/** Stops only this command's own tree: a command timeout must not cancel sibling work. */
		const stopOwnTree = async () => {
			const reader = detectReader();
			const snapshot = snapshotTree(record?.root ? [record.root] : [], reader.table());
			const stop = stopTrees([snapshot], {
				graceMs: 3000,
				killMs: 2000,
				reader,
				onError,
				onSignal: (_pid, name) => {
					progress.lastSignal = name;
				},
			}).then((result) => ({ signal: result.escalated ? "SIGKILL" : "SIGTERM", ...result }));
			const done = await bounded(stop, stopDeadlineMs, null);
			// The stop did not finish in time: report what it sent and what it could not settle.
			return (
				done ?? {
					signal: progress.lastSignal ?? "SIGTERM",
					escalated: progress.lastSignal === "SIGKILL",
					unresolved: snapshot.entries,
					survivors: [],
					truncated: snapshot.truncated,
				}
			);
		};
		const timer = setTimeout(() => {
			timedOut = true;
			void (async () => {
				stopResult = await stopOwnTree();
				finish();
			})();
		}, timeoutMs);
		const sinkOf = (sink) => {
			const push = split(sink);
			let retained = 0;
			return (chunk) => {
				// The cap is checked before the append: after an overflow this stream keeps nothing,
				// so a child that writes fast cannot grow memory during its termination grace.
				if (overCap || settled) return;
				if (maxBuffer > 0 && retained + chunk.length > maxBuffer) {
					overCap = true;
					void (async () => {
						timedOut = true;
						stopResult = await stopOwnTree();
						settled = true;
						clearTimeout(timer);
						child.stdout?.destroy();
						child.stderr?.destroy();
						/** @type {Error & {retained?: number}} */
						const error = new Error(`output over ${Math.round(maxBuffer / (1024 * 1024))} MB`);
						// What the buffers really hold: the test asserts it stays near the cap.
						error.retained = out.reduce((n, chunk) => n + chunk.length, 0) + err.reduce((n, chunk) => n + chunk.length, 0);
						reject(error);
					})();
					return;
				}
				retained += chunk.length;
				push(chunk);
			};
		};
		child.stdout?.on("data", sinkOf(out));
		child.stderr?.on("data", sinkOf(err));
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code, signal) => {
			closed = { code, signal };
			finish();
		});
	});
}

/**
 * Runs a command to completion; returns {code, signal, timedOut, unresolved, stdout, stderr}.
 * Never throws on a non-zero exit, but throws when the output passes `maxBuffer`.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, maxBuffer?: number, stopDeadlineMs?: number, stdio?: any, onError?: (error: any, pid: number, name: string) => void}} [options]
 */
export function run(command, args, { cwd, env, timeoutMs = 10 * 60_000, maxBuffer = 64 * 1024 * 1024, stopDeadlineMs = PIPE_CLOSE_MS, stdio = "pipe", onError } = {}) {
	return runProcess(command, args, { cwd, env, timeoutMs, maxBuffer, stopDeadlineMs, stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"], onError });
}

/**
 * Runs a command and hands every output line to `onLine` as it arrives, so a
 * minute-long render can show progress. Stdout and stderr are split on both
 * newlines and carriage returns, because a progress bar rewrites one line.
 * @param {string} command
 * @param {string[]} args
 * @param {{cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number, maxBuffer?: number, stopDeadlineMs?: number, onLine?: (line: string, stream: string) => void, onError?: (error: any, pid: number, name: string) => void}} [options]
 */
export function runStreaming(command, args, { cwd, env, timeoutMs = 60 * 60_000, maxBuffer = 64 * 1024 * 1024, stopDeadlineMs = PIPE_CLOSE_MS, onLine = () => {}, onError } = {}) {
	return runProcess(command, args, { cwd, env, timeoutMs, maxBuffer, stopDeadlineMs, onLine, onError });
}

/**
 * Why a run failed, or null when it did not. A timed-out command is never a
 * success, also when its child exits 0 after the stop: the timeout wins.
 * @param {{code: number | null, signal?: string | null, timedOut?: boolean, stderr?: string}} result
 * @param {number} minutes
 */
export function failed(result, minutes) {
	if (result.timedOut) return `did not finish in ${minutes} min`;
	if (result.code === 0) return null;
	const said = (result.stderr || "").trim().split("\n").slice(-1).join(" ").trim();
	// A silent failure still needs a reason: an empty string would read as success to `if (reason)`.
	if (said) return said;
	if (result.code === null) return `stopped by ${result.signal ?? "a signal"}`;
	return `exit code ${result.code}`;
}

/** Where an installed bin lives, or undefined. */
export function findOnPath(name, env = process.env) {
	for (const dir of (env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		const candidate = join(dir, name);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** Node first, then the rest of PATH: npm scripts need the Node that runs wv. */
export function pathWithNode(env = process.env) {
	return [dirname(process.execPath), ...(env.PATH ?? "").split(delimiter)].filter(Boolean).join(delimiter);
}

export function hasFfmpeg(env = process.env) {
	const probe = spawnSync("ffmpeg", ["-version"], { env, encoding: "utf8", timeout: 5000 });
	return probe.status === 0;
}

/** The telemetry guard that every HyperFrames call must carry. */
// No telemetry, no skill install, no npm update check (a detached fetch) and no self-install.
export const HYPERFRAMES_ENV = { HYPERFRAMES_NO_TELEMETRY: "1", DO_NOT_TRACK: "1", HYPERFRAMES_SKIP_SKILLS: "1", HYPERFRAMES_NO_UPDATE_CHECK: "1", HYPERFRAMES_NO_AUTO_INSTALL: "1" };
