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
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { constants as osConstants } from "node:os";
import { basename, dirname, join } from "node:path";
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

/** Whether a systemd user scope can hold a call here. */
export function scopeSupported(): boolean {
	return scopeSlice() !== null;
}

function unitName(prefix: string): string {
	return `${prefix}-${process.pid}-${randomBytes(6).toString("hex")}`;
}

export interface Scope {
	/** The command to run in place of `shell args...`. */
	readonly argv: readonly string[];
	/** The scope's cgroup folder. */
	readonly dir: string;
}

/** Wrap a command in a new transient scope, or undefined when no scope can start here. */
export function newScope(prefix: string, command: readonly string[]): Scope | undefined {
	const slice = scopeSlice();
	if (slice === null) return undefined;
	const unit = unitName(prefix);
	return { argv: ["systemd-run", ...SCOPE_FLAGS, `--unit=${unit}`, "--", ...command], dir: join(slice, `${unit}.scope`) };
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

interface Proc { readonly pid: number; readonly ppid: number; readonly pgid: number; readonly sid: number | null; readonly start: string }

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
		found.push({ pid: Number(name), ppid: Number(fields[1]), pgid: Number(fields[2]), sid: Number(fields[3]), start: fields[19] ?? "" });
	}
	return found;
}

/** Every process, from ps: macOS has no /proc. No ps, or a failed one, gives none, and the group kill still runs. */
async function psProcesses(): Promise<Proc[]> {
	const stdout = await new Promise<string>((resolve) => {
		execFile("ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="], { encoding: "utf8", timeout: 5000 }, (error, out) => resolve(error ? "" : out));
	});
	return stdout.split("\n").flatMap((line) => {
		const parts = line.trim().split(/\s+/);
		const [pid, ppid, pgid, state, ...start] = parts;
		if (start.length === 0 || state === undefined || state.startsWith("Z")) return [];
		return [{ pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), sid: null, start: start.join(" ") }];
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

/** Every tree not yet ended, for the exit net. */
const liveTrees = new Set<Tree>();
let exitNet = false;

function installExitNet(): void {
	if (exitNet) return;
	exitNet = true;
	process.on("exit", () => {
		for (const tree of liveTrees) tree.killNow();
	});
}

/** The processes that one spawned command started, and how to end them all. */
export class Tree {
	private readonly known = new Map<number, string>();
	private scanTimer: ReturnType<typeof setInterval> | undefined;

	readonly root: number;
	readonly scope: string | undefined;

	constructor(root: number, scope: string | undefined) {
		this.root = root;
		this.scope = scope;
		liveTrees.add(this);
		installExitNet();
		if (!scope) {
			this.scanTimer = setInterval(() => this.tick(), SCAN_MS);
			this.scanTimer.unref?.();
		}
	}

	private scanning = false;

	private async scan(): Promise<Proc[]> {
		const members = treeOf(this.root, this.known, await processes());
		for (const proc of members) this.known.set(proc.pid, proc.start);
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
			return inScope.length > 0 ? inScope : this.groupMembers();
		}
		return (await this.scan()).map((proc) => proc.pid);
	}

	private groupMembers(): number[] {
		return signal(-this.root, 0) ? [-this.root] : [];
	}

	private async send(name: NodeJS.Signals): Promise<void> {
		for (const pid of await this.members()) signal(pid, name);
		// The group too: a process can be in it before it is in the scope.
		signal(-this.root, name);
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

	/** SIGTERM, a grace, then SIGKILL. True when no process of the tree is left. */
	async end(graceMs: number): Promise<boolean> {
		try {
			if ((await this.members()).length === 0) return true;
			await this.send("SIGTERM");
			if (await this.drained(graceMs)) return true;
			if (this.scope) killScopeNow(this.scope);
			await this.send("SIGKILL");
			return await this.drained(KILL_WAIT_MS);
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
		signal(-this.root, "SIGKILL");
	}

	dispose(): void {
		if (this.scanTimer) clearInterval(this.scanTimer);
		this.scanTimer = undefined;
		liveTrees.delete(this);
	}
}

// ---------------------------------------------------------------- the bash operations

/**
 * Bash operations as Pi's local backend runs them (detached shell, output
 * streamed, `timeout:<s>` and `aborted` errors), with one change: when the
 * call ends, by its exit, its timeout or an abort, every process it started ends too.
 */
export function treeShellOperations(resolveShell: () => ShellConfig, options: TreeOptions = {}): ShellOperations {
	const graceMs = options.graceMs ?? TREE_GRACE_MS;
	const mode = options.mode ?? "auto";
	return {
		async exec(command, cwd, { onData, signal: abort, timeout, env }) {
			if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0)) throw new Error("Invalid timeout: must be a finite number of seconds");
			if (abort?.aborted) throw new Error("aborted");
			const shell = resolveShell();
			const fromStdin = shell.commandTransport === "stdin";
			const argv = [shell.shell, ...shell.args, ...(fromStdin ? [] : [command])];
			const scope = mode === "group" ? undefined : newScope("pi-bash", argv);
			if (mode === "scope" && !scope) throw new Error("No systemd user scope can start here.");
			const [file = shell.shell, ...args] = scope?.argv ?? argv;
			const child = spawn(file, args, {
				cwd,
				detached: true,
				env: env ?? process.env,
				stdio: [fromStdin ? "pipe" : "ignore", "pipe", "pipe"],
			});
			if (fromStdin) {
				child.stdin?.on("error", () => { /* The shell may exit before it reads all. */ });
				child.stdin?.end(command);
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
			child.stdout?.on("data", onData);
			child.stderr?.on("data", onData);
			await spawned;
			if (child.pid === undefined) throw new Error(`${shell.shell} reported no process id`);
			const tree = new Tree(child.pid, scope?.dir);
			let reason: "timeout" | "aborted" | undefined;
			let stop!: () => void;
			const stopped = new Promise<void>((resolve) => { stop = resolve; });
			const end = (why: "timeout" | "aborted") => { reason ??= why; stop(); };
			const onAbort = () => end("aborted");
			const timer = timeout === undefined ? undefined : setTimeout(() => end("timeout"), timeout * 1000);
			abort?.addEventListener("abort", onAbort, { once: true });
			// An abort while the shell started fired before the listener was there.
			if (abort?.aborted) onAbort();
			try {
				const first = await Promise.race([exited.then((result) => ({ result })), stopped.then(() => undefined)]);
				// The shell ended or the call must stop: either way, nothing of it stays.
				await tree.end(graceMs);
				const result = first?.result ?? await Promise.race([exited, sleep(KILL_WAIT_MS).then(() => ({ code: null, signal: null }))]);
				// Output written before the end still arrives; a pipe that a lost process holds does not hold the call.
				await Promise.race([closed, sleep(100)]);
				child.stdout?.destroy();
				child.stderr?.destroy();
				if (reason === "aborted" || abort?.aborted) throw new Error("aborted");
				if (reason === "timeout") throw new Error(`timeout:${timeout}`);
				if (result.code === null && result.signal === null && failure) throw failure;
				return { exitCode: result.code ?? (result.signal ? 128 + (osConstants.signals[result.signal] ?? 0) : 1) };
			} finally {
				if (timer) clearTimeout(timer);
				abort?.removeEventListener("abort", onAbort);
				tree.dispose();
			}
		},
	};
}
