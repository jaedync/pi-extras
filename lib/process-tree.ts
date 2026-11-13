/**
 * process-tree: a shell call that leaves no process behind.
 *
 * Pi's own bash operations SIGKILL the shell's process group at a timeout or
 * an abort, and nothing at a normal end. A process that moves to a group of
 * its own (GNU `timeout`, `setsid`, a daemon) escapes that kill and runs on,
 * reparented to PID 1. These operations end every process of the call when
 * the call ends, however it ends: SIGTERM to all, a grace, then SIGKILL.
 *
 * On Linux with a systemd user manager each call runs in a transient scope
 * (`systemd-run --user --scope`). A cgroup holds every descendant, whatever
 * its group, session or parent, so the kill reads the scope's members and
 * ends with `cgroup.kill`. Elsewhere (macOS, no user manager) the kill takes
 * the process group, the session (Linux), the descendants by parent, and the
 * descendants seen by a scan each second while the call ran. That fallback
 * misses a process that left the session and lost its parent between scans.
 */
import { execFile, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants as fsConstants, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import { basename, dirname, join } from "node:path";
import type { Readable } from "node:stream";
import type { ShellOperations } from "./chain/exec.ts";

export interface ShellConfig {
	readonly shell: string;
	readonly args: readonly string[];
	readonly commandTransport?: "argv" | "stdin";
}

export type TreeMode = "auto" | "scope" | "group";

export interface TreeOptions {
	/** SIGTERM, then this long, then SIGKILL. */
	readonly graceMs?: number;
	/** auto: a systemd scope when one can start, else the process group and a scan. */
	readonly mode?: TreeMode;
}

/**
 * Whether pi-extras gives bash and shell-jobs these tree operations. On by
 * default on Linux only; elsewhere Pi's own operations run, as before.
 * PI_TREE_KILL=1 turns them on elsewhere (for a test on macOS; never on
 * Windows, which has no process groups). PI_TREE_KILL=0 turns them off on Linux.
 */
export function treeKillOn(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
	if (platform === "win32") return false;
	if (env.PI_TREE_KILL === "1") return true;
	if (env.PI_TREE_KILL === "0") return false;
	return platform === "linux";
}

export const TREE_GRACE_MS = 3000;
/** How long the kill waits for SIGKILLed processes to go. */
const KILL_WAIT_MS = 2000;
const POLL_MS = 25;
const PS_POLL_MS = 200;
const SCAN_MS = 1000;
const CGROUP_ROOT = "/sys/fs/cgroup";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error ? String(error.code) : undefined;
}

/** A process or file that is gone, or a process that is not ours: the normal end of a race with an exit. */
const GONE = new Set(["ENOENT", "ESRCH", "EPERM", "ENODEV"]);

/** A file's text, or undefined when it is gone; other failures throw. */
export function readIfThere(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (GONE.has(errorCode(error) ?? "")) return undefined;
		throw error;
	}
}

/** Send a signal; a process that is gone or not ours is not an error. */
export function signal(pid: number, name: NodeJS.Signals | 0): boolean {
	try {
		process.kill(pid, name);
		return true;
	} catch (error) {
		if (GONE.has(errorCode(error) ?? "")) return false;
		throw error;
	}
}

// ---------------------------------------------------------------- scopes

/**
 * A transient scope that systemd removes once empty, with no notice on
 * stderr, and the command's `$VAR`s passed to it as written: systemd-run
 * would expand them itself. A systemd older than 254 has no
 * --expand-environment, so the probe fails there and calls use the fallback.
 */
const SCOPE_FLAGS = ["--user", "--scope", "--collect", "--quiet", "--expand-environment=no"];

let sliceDir: string | null | undefined;

/**
 * The cgroup folder that holds this user's transient scopes, or null when no
 * scope can start here. One probe per process, which costs about 10 ms.
 */
export function scopeSlice(): string | null {
	if (sliceDir !== undefined) return sliceDir;
	sliceDir = null;
	if (process.platform !== "linux") return sliceDir;
	// A missing systemd-run is an error in the result, not a throw.
	const probe = spawnSync("systemd-run", [...SCOPE_FLAGS, `--unit=${unitName("pi-probe")}`, "--", "cat", "/proc/self/cgroup"],
		{ encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
	const line = probe.status === 0 && typeof probe.stdout === "string" ? probe.stdout.split("\n").find((text) => text.startsWith("0::")) : undefined;
	if (!line) return sliceDir;
	const slice = join(CGROUP_ROOT, dirname(line.slice(3).trim()));
	if (existsSync(join(slice, "cgroup.procs"))) sliceDir = slice;
	return sliceDir;
}

/** Whether the probe's result is cached; a failed scope start drops it. */
export function scopeProbeCached(): boolean {
	return sliceDir !== undefined;
}

/** Drop the probe's result, after systemd-run could not start a scope: the next call probes again. */
export function forgetScopeProbe(): void {
	sliceDir = undefined;
}

/** Whether a systemd user scope can hold a call here. */
export function scopeSupported(): boolean {
	return scopeSlice() !== null;
}

function unitName(prefix: string): string {
	return `${prefix}-${process.pid}-${randomBytes(6).toString("hex")}`;
}

/**
 * Run in the scope before the command: one byte on fd 3 tells that systemd-run
 * started the scope and the command now starts. fd 3 then closes, so a
 * process of the command cannot hold it. No byte, and fd 3 at its end, tells
 * that systemd-run failed (no user bus, a D-Bus error) and the command did not run.
 */
const STARTED = 'printf x >&3; exec "$@" 3>&-';

export interface Scope {
	/** The command to run in place of `shell args...`, with a pipe on fd 3 (see scopeStarted). */
	readonly argv: readonly string[];
	/** The scope's cgroup folder. */
	readonly dir: string;
}

/** Wrap a command in a new transient scope, or undefined when no scope can start here. */
export function newScope(prefix: string, command: readonly string[]): Scope | undefined {
	const slice = scopeSlice();
	if (slice === null) return undefined;
	const unit = unitName(prefix);
	return { argv: ["systemd-run", ...SCOPE_FLAGS, `--unit=${unit}`, "--", "/bin/sh", "-c", STARTED, "sh", ...command], dir: join(slice, `${unit}.scope`) };
}

/** True when the command of a scope started, false when systemd-run ended first. `pipe` is the child's fd 3. */
export function scopeStarted(pipe: Readable | null | undefined): Promise<boolean> {
	if (!pipe) return Promise.resolve(false);
	return new Promise((resolve) => {
		pipe.once("data", () => resolve(true));
		pipe.once("end", () => resolve(false));
		pipe.once("close", () => resolve(false));
		// A read error reads as no start; the command then runs again in its own group.
		pipe.once("error", () => resolve(false));
		pipe.resume();
	});
}

/** The pids in a scope; empty once the scope is gone. */
export function scopeMembers(dir: string): number[] {
	return (readIfThere(join(dir, "cgroup.procs")) ?? "").split("\n").filter(Boolean).map(Number);
}

/** SIGKILL every process of a scope at once. Synchronous, so an exit handler can call it. */
export function killScopeNow(dir: string): void {
	const file = join(dir, "cgroup.kill");
	// A kernel before 5.14 has no cgroup.kill; a scope that is gone has neither.
	if (existsSync(file)) {
		try {
			writeFileSync(file, "1");
			return;
		} catch (error) {
			if (!GONE.has(errorCode(error) ?? "")) throw error;
		}
	}
	for (const pid of scopeMembers(dir)) signal(pid, "SIGKILL");
}

/** How long an emptied scope may stay before it is stopped by hand. */
const REAP_MS = 1000;

/**
 * Stop a scope that is empty but still there. When its first process dies
 * before systemd takes it in (a kill in the first milliseconds), systemd never
 * sees the scope empty, and the scope stays active with no process. With
 * `now`, the stop starts at once, detached, for the exit of this process.
 */
export function reapScope(dir: string, now = false): void {
	const stop = () => {
		if (!existsSync(dir) || scopeMembers(dir).length > 0) return;
		const child = spawn("systemctl", ["--user", "stop", "--no-block", basename(dir)], { stdio: "ignore", detached: now });
		// No systemctl: the empty scope stays until the user manager ends, and holds no process.
		child.on("error", (error) => process.emitWarning(`process-tree: could not stop the empty scope ${basename(dir)}: ${error.message}`));
		child.unref();
	};
	if (now) { stop(); return; }
	setTimeout(stop, REAP_MS).unref?.();
}


// ---------------------------------------------------------------- the scan

interface Proc { readonly pid: number; readonly ppid: number; readonly pgid: number; readonly sid: number | null; readonly start: string; readonly name: string }

/** Every process: from /proc on Linux, from ps elsewhere. */
async function processes(): Promise<Proc[]> {
	return process.platform === "linux" ? procProcesses() : psProcesses();
}

/** Every process, from /proc; synchronous, for an exit handler too. */
function procProcesses(): Proc[] {
	const found: Proc[] = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		// Undefined when it ended while it was read.
		const stat = readIfThere(`/proc/${name}/stat`);
		if (stat === undefined) continue;
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		// After the name: state ppid pgrp session ... starttime is field 22, the 20th here.
		if (fields[0] === "Z" || fields[0] === "X") continue;
		const comm = stat.slice(stat.indexOf("(") + 1, stat.lastIndexOf(")"));
		found.push({ pid: Number(name), ppid: Number(fields[1]), pgid: Number(fields[2]), sid: Number(fields[3]), start: fields[19] ?? "", name: comm });
	}
	return found;
}

/** Every process, from ps: macOS has no /proc. No ps, or a failed one, gives none, and the group kill still runs. */
async function psProcesses(): Promise<Proc[]> {
	const stdout = await new Promise<string>((resolve) => {
		execFile("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart=,comm="], { encoding: "utf8", timeout: 5000 }, (error, out) => resolve(error ? "" : out));
	});
	return stdout.split("\n").flatMap((line) => {
		const parts = line.trim().split(/\s+/);
		// lstart is five words, as in "Fri Nov 13 03:05:43 2026"; comm is the rest.
		const [pid, ppid, pgid, state] = parts;
		const start = parts.slice(4, 9);
		if (start.length < 5 || state === undefined || state.startsWith("Z")) return [];
		return [{ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), sid: null, start: start.join(" "), name: basename(parts.slice(9).join(" ")) }];
	});
}

/**
 * The processes of a call whose shell is `root`: its group, its session (the
 * shell leads both, as Node's `detached` starts it), the descendants of these
 * by parent, and the ones `known` holds that still have the same start time.
 */
function treeOf(root: number, known: Map<number, string>, all: readonly Proc[]): Proc[] {
	const byParent = new Map<number, Proc[]>();
	for (const proc of all) byParent.set(proc.ppid, [...(byParent.get(proc.ppid) ?? []), proc]);
	const members = new Map<number, Proc>();
	const queue = all.filter((proc) => proc.pid === root || proc.pgid === root || proc.sid === root || known.get(proc.pid) === proc.start);
	for (let proc = queue.pop(); proc !== undefined; proc = queue.pop()) {
		if (members.has(proc.pid) || proc.pid === process.pid || proc.pid <= 1) continue;
		members.set(proc.pid, proc);
		queue.push(...(byParent.get(proc.pid) ?? []));
	}
	return [...members.values()];
}

// ---------------------------------------------------------------- one call's tree

/**
 * Every tree not yet ended, for the exit net, on the process: Pi loads an
 * extension again at each /reload, and each load must not add a listener.
 */
interface ExitNet { readonly live: Set<{ killNow(): void }>; installed: boolean }
const EXIT_NET = Symbol.for("pi-extras.process-tree.exit-net.v1");

function exitNet(): ExitNet {
	const holder = globalThis as { [EXIT_NET]?: ExitNet };
	const net = holder[EXIT_NET] ??= { live: new Set(), installed: false };
	if (!net.installed) {
		net.installed = true;
		process.on("exit", () => {
			for (const tree of net.live) tree.killNow();
		});
	}
	return net;
}

/** A process that the end of a call ended. */
export interface Ended { readonly pid: number; readonly name: string }

/** What the end of a call did: the processes it ended, and how many it could not end. */
export interface EndResult { readonly ended: readonly Ended[]; readonly left: number }

const NAMES_SHOWN = 5;

function listed(processes: readonly Ended[]): string {
	const names = processes.slice(0, NAMES_SHOWN).map((proc) => proc.pid < 0 ? `process group ${-proc.pid}` : `${proc.name} (pid ${proc.pid})`);
	const more = processes.length - names.length;
	return more > 0 ? `${names.join(", ")} and ${more} more` : names.join(", ");
}

/** The line that tells the model what the normal end of a call ended, or undefined when it ended nothing. */
export function endNotice(result: EndResult): string | undefined {
	const lines: string[] = [];
	const count = result.ended.length;
	if (count > 0) {
		lines.push(`[Ended ${count} background ${count === 1 ? "process" : "processes"} when the call ended: ${listed(result.ended)}. ` +
			"To keep a process, start it as a shell job or with `systemd-run --user --unit=<name>`.]");
	}
	if (result.left > 0) lines.push(`[${result.left} ${result.left === 1 ? "process" : "processes"} of the call did not end after SIGKILL.]`);
	return lines.length > 0 ? lines.join("\n") : undefined;
}

/** The processes that one spawned command started, and how to end them all. */
export class Tree {
	private readonly known = new Map<number, string>();
	private readonly names = new Map<number, string>();
	private scanTimer: ReturnType<typeof setInterval> | undefined;

	readonly root: number;
	readonly scope: string | undefined;

	constructor(root: number, scope: string | undefined) {
		this.root = root;
		this.scope = scope;
		exitNet().live.add(this);
		if (!scope) {
			this.scanTimer = setInterval(() => this.tick(), SCAN_MS);
			this.scanTimer.unref?.();
		}
	}

	private scanning = false;
	private rootExited = false;

	/**
	 * The shell has ended. In a scope, its group then gets no more signals: the
	 * scope holds every process that is left, and the shell's pid may be reused.
	 */
	markExited(): void {
		this.rootExited = true;
	}

	/** In a scope, whether the shell's group may still hold a process that the scope does not. */
	private groupCounts(): boolean {
		return !this.scope || !this.rootExited;
	}

	private async scan(): Promise<Proc[]> {
		const members = treeOf(this.root, this.known, await processes());
		for (const proc of members) {
			this.known.set(proc.pid, proc.start);
			this.names.set(proc.pid, proc.name);
		}
		return members;
	}

	/** One scan at a time from the timer; a slow ps must not pile up. */
	private tick(): void {
		if (this.scanning) return;
		this.scanning = true;
		this.scan().finally(() => { this.scanning = false; }).catch((error: unknown) => process.emitWarning(`process-tree: a scan failed: ${String(error)}`));
	}

	/** The pids of the tree that are alive now. */
	async members(): Promise<number[]> {
		if (this.scope) {
			const inScope = scopeMembers(this.scope);
			// Before systemd-run moves the shell into its scope, the group holds it.
			return inScope.length > 0 || !this.groupCounts() ? inScope : this.groupMembers();
		}
		return (await this.scan()).map((proc) => proc.pid);
	}

	private groupMembers(): number[] {
		return signal(-this.root, 0) ? [-this.root] : [];
	}

	private async send(name: NodeJS.Signals): Promise<void> {
		for (const pid of await this.members()) signal(pid, name);
		// The group too: a process can be in it before it is in the scope.
		if (this.groupCounts()) signal(-this.root, name);
	}

	private async drained(ms: number): Promise<boolean> {
		const deadline = Date.now() + ms;
		for (;;) {
			if ((await this.members()).length === 0) return true;
			if (Date.now() >= deadline) return false;
			// ps costs more than a read of /proc or of a cgroup.
			await sleep(this.scope || process.platform === "linux" ? POLL_MS : PS_POLL_MS);
		}
	}

	/** The name of a live member: from /proc on Linux, else from the last scan. */
	private named(pid: number): Ended {
		if (pid < 0) return { pid, name: "" };
		const comm = process.platform === "linux" ? readIfThere(`/proc/${pid}/comm`)?.trim() : undefined;
		return { pid, name: comm ?? this.names.get(pid) ?? "?" };
	}

	/** SIGTERM, a grace, then SIGKILL. Gives the processes it found, and how many it could not end. */
	async end(graceMs: number): Promise<EndResult> {
		try {
			const found = await this.members();
			if (found.length === 0) return { ended: [], left: 0 };
			// Names first: a process that ends has none to read.
			const ended = found.map((pid) => this.named(pid));
			await this.send("SIGTERM");
			if (await this.drained(graceMs)) return { ended, left: 0 };
			if (this.scope) killScopeNow(this.scope);
			await this.send("SIGKILL");
			if (await this.drained(KILL_WAIT_MS)) return { ended, left: 0 };
			return { ended, left: (await this.members()).length };
		} finally {
			if (this.scope) reapScope(this.scope);
			this.dispose();
		}
	}

	/** SIGKILL all at once, for the exit of this process. */
	killNow(): void {
		if (this.scope) { killScopeNow(this.scope); reapScope(this.scope, true); }
		// /proc tells a known pid from a later process with the same number; ps at exit would be too slow, so macOS has the group only.
		else if (process.platform === "linux") for (const proc of treeOf(this.root, this.known, procProcesses())) signal(proc.pid, "SIGKILL");
		if (this.groupCounts()) signal(-this.root, "SIGKILL");
	}

	dispose(): void {
		if (this.scanTimer) clearInterval(this.scanTimer);
		this.scanTimer = undefined;
		exitNet().live.delete(this);
	}
}

// ---------------------------------------------------------------- the bash operations

/** Pi's limit for a timer (lib bash.js MAX_TIMEOUT_MS): a longer timeout would fire at once. */
const MAX_TIMEOUT_MS = 2_147_483_647;
/** How long the output may still arrive after the end, after its last chunk. */
const TAIL_IDLE_MS = 100;

/** Pi's own check of a timeout, with Pi's own errors (bash.js resolveTimeoutMs). */
function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) throw new Error("Invalid timeout: must be a finite number of seconds");
	const ms = timeout * 1000;
	if (ms > MAX_TIMEOUT_MS) throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_MS / 1000} seconds`);
	return ms;
}

interface Call {
	readonly command: string;
	readonly cwd: string;
	readonly shell: ShellConfig;
	readonly onData: (chunk: Buffer) => void;
	readonly abort: AbortSignal | undefined;
	readonly timeout: number | undefined;
	readonly deadline: number | undefined;
	readonly env: NodeJS.ProcessEnv | undefined;
	readonly graceMs: number;
}

/** The scope did not start, and the command did not run. */
const NO_SCOPE = Symbol("no scope");

/**
 * Bash operations as Pi's local backend runs them (detached shell, output
 * streamed, Pi's errors), with one change: when the call ends, by its exit,
 * its timeout or an abort, every process it started ends too. At a normal
 * end, a line in the output names the processes that the end ended.
 */
export function treeShellOperations(resolveShell: () => ShellConfig, options: TreeOptions = {}): ShellOperations {
	const graceMs = options.graceMs ?? TREE_GRACE_MS;
	const mode = options.mode ?? "auto";
	return {
		async exec(command, cwd, { onData, signal: abort, timeout, env }) {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (abort?.aborted) throw new Error("aborted");
			const shell = resolveShell();
			try {
				await access(cwd, fsConstants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
			}
			const call: Call = { command, cwd, shell, onData, abort, timeout, deadline: timeoutMs === undefined ? undefined : Date.now() + timeoutMs, env, graceMs };
			if (mode !== "group") {
				const scope = newScope("pi-bash", shellArgv(shell, command));
				if (scope) {
					const result = await runCall(call, scope);
					if (result !== NO_SCOPE) return result;
					// systemd-run could not start the scope this time: the command runs in its own group, and the next call probes again.
					forgetScopeProbe();
				}
				if (mode === "scope") throw new Error("No systemd user scope can start here.");
			}
			const result = await runCall(call, undefined);
			if (result === NO_SCOPE) throw new Error(`${shell.shell} did not start`);
			return result;
		},
	};
}

function shellArgv(shell: ShellConfig, command: string): string[] {
	return [shell.shell, ...shell.args, ...(shell.commandTransport === "stdin" ? [] : [command])];
}

/** One run of a call: in a scope, or in the shell's own group with a scan. */
async function runCall(call: Call, scope: Scope | undefined): Promise<{ exitCode: number | null } | typeof NO_SCOPE> {
	const { shell, abort, onData } = call;
	const fromStdin = shell.commandTransport === "stdin";
	const argv = shellArgv(shell, call.command);
	const [file = shell.shell, ...args] = scope?.argv ?? argv;
	const child = spawn(file, args, {
		cwd: call.cwd,
		detached: true,
		env: call.env ?? process.env,
		stdio: scope ? [fromStdin ? "pipe" : "ignore", "pipe", "pipe", "pipe"] : [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
	});
	if (fromStdin) {
		child.stdin?.on("error", () => { /* The shell may exit before it reads all. */ });
		child.stdin?.end(call.command);
	}
	let failure: Error | undefined;
	const spawned = new Promise<void>((resolve, reject) => {
		child.once("spawn", resolve);
		child.once("error", reject);
	});
	// A later error (a signal Node could not send) must not end Pi; the call reports it if it has no exit code.
	child.on("error", (error) => { failure ??= error; });
	const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
		child.once("exit", (code, name) => resolve({ code, signal: name }));
	});
	const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
	const startPipe = scope ? child.stdio[3] as Readable | null : undefined;
	const begun = scope ? scopeStarted(startPipe) : Promise.resolve(true);
	// Until the scope's command starts, output is systemd-run's own, and it is dropped if the scope fails.
	let held: Buffer[] | undefined = scope ? [] : undefined;
	let lastByte = 0x0a;
	let onTail: (() => void) | undefined;
	const deliver = (chunk: Buffer) => {
		if (held) { held.push(chunk); return; }
		if (chunk.length > 0) lastByte = chunk[chunk.length - 1] ?? lastByte;
		onData(chunk);
		onTail?.();
	};
	child.stdout?.on("data", deliver);
	child.stderr?.on("data", deliver);
	try {
		await spawned;
	} catch (error) {
		// No systemd-run here now: the command runs in its own group.
		if (scope) return NO_SCOPE;
		throw error;
	}
	if (child.pid === undefined) throw new Error(`${shell.shell} reported no process id`);
	const tree = new Tree(child.pid, scope?.dir);
	void exited.then(() => tree.markExited());
	let reason: "timeout" | "aborted" | undefined;
	let stop!: () => void;
	const stopped = new Promise<void>((resolve) => { stop = resolve; });
	const end = (why: "timeout" | "aborted") => { reason ??= why; stop(); };
	const onAbort = () => end("aborted");
	const timer = call.deadline === undefined ? undefined : setTimeout(() => end("timeout"), Math.max(0, call.deadline - Date.now()));
	abort?.addEventListener("abort", onAbort, { once: true });
	// An abort while the shell started fired before the listener was there.
	if (abort?.aborted) onAbort();
	try {
		if (scope) {
			const started = await Promise.race([begun, stopped.then(() => true)]);
			if (!started) {
				// systemd-run ended before the command started: nothing of the command ran.
				await Promise.race([exited, sleep(KILL_WAIT_MS)]);
				await tree.end(call.graceMs);
				return NO_SCOPE;
			}
			const chunks = held ?? [];
			held = undefined;
			for (const chunk of chunks) deliver(chunk);
		}
		const first = await Promise.race([exited.then((result) => ({ result })), stopped.then(() => undefined)]);
		// The shell ended or the call must stop: either way, nothing of it stays.
		const ending = await tree.end(call.graceMs);
		const result = first?.result ?? await Promise.race([exited, sleep(KILL_WAIT_MS).then(() => ({ code: null, signal: null }))]);
		await tail(closed, (rearm) => { onTail = rearm; });
		onTail = undefined;
		child.stdout?.destroy();
		child.stderr?.destroy();
		startPipe?.destroy();
		if (reason === "aborted" || abort?.aborted) throw new Error("aborted");
		if (reason === "timeout") throw new Error(`timeout:${call.timeout}`);
		if (result.code === null && result.signal === null && failure) throw failure;
		const notice = endNotice(ending);
		if (notice) onData(Buffer.from(`${lastByte === 0x0a ? "" : "\n"}${notice}\n`));
		return { exitCode: result.code ?? (result.signal ? 128 + (osConstants.signals[result.signal] ?? 0) : 1) };
	} finally {
		if (timer) clearTimeout(timer);
		abort?.removeEventListener("abort", onAbort);
		tree.dispose();
	}
}

/**
 * Wait for the output written before the end: until the pipes close, or
 * TAIL_IDLE_MS after the last chunk, as Pi waits (child-process.js), and no
 * longer than KILL_WAIT_MS, since a lost process may hold a pipe.
 */
function tail(closed: Promise<void>, watch: (rearm: () => void) => void): Promise<void> {
	return new Promise((resolve) => {
		let idle: ReturnType<typeof setTimeout> | undefined;
		const done = () => {
			if (idle) clearTimeout(idle);
			clearTimeout(cap);
			resolve();
		};
		const cap = setTimeout(done, KILL_WAIT_MS);
		const rearm = () => {
			if (idle) clearTimeout(idle);
			idle = setTimeout(done, TAIL_IDLE_MS);
		};
		watch(rearm);
		rearm();
		void closed.then(done);
	});
}
