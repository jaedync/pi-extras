/** Local leases include process birth time so PID reuse cannot strand a saved roster. */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INCOMPLETE_GRACE_MS = 5_000;
const REAPER_GRACE_MS = 5 * 60_000;
/** The owner stops its children and saves the roster before it lets the lease go. */
const TAKEOVER_WAIT_MS = 10_000;
const TAKEOVER_POLL_MS = 50;
/** After the lease is free: how long Pi may take to restore its terminal and exit, or stop on that restore. */
const TAKEOVER_SETTLE_MS = 3_000;
interface Owner { pid?: number; token?: string; host?: string; started?: string; birthFormat?: string }

/** What a live owner is doing; `ps` can't see another host's. */
export type OwnerState = "running" | "suspended" | "elsewhere";

/** A live parent holds the lease: which one, what it is doing, and how to free it. */
export class LeaseHeld extends Error {
	readonly dir: string;
	readonly pid: number | undefined;
	readonly state: OwnerState;
	constructor(dir: string, owner: Owner, state: OwnerState) {
		super(`${heldWords(owner, state)} Lock: ${join(dir, ".owner")}. If no parent owns it, remove that lock directory and retry.`);
		this.name = "LeaseHeld";
		this.dir = dir;
		this.pid = owner.pid;
		this.state = state;
	}
}

function heldWords({ pid, host }: Owner, state: OwnerState): string {
	const owned = `Subagents are already owned by process ${pid}`;
	if (state === "elsewhere") return `${owned} on ${host}. Close that parent before resuming here.`;
	// Ctrl-Z leaves the parent alive, so its lease stays held until it runs again or ends.
	if (state === "suspended") return `${owned}, which is suspended (Ctrl-Z). Run fg in its terminal to go on there. To end it, run kill -TERM ${pid}; kill -CONT ${pid}, or /subagents takeover here.`;
	return `${owned}, which is still running. Close that parent before resuming here, or run /subagents takeover to end it.`;
}

/** `ps` state letters: T or t is stopped (Ctrl-Z or a debugger), Z has exited but is not yet reaped. Empty if gone. */
function psState(pid: number): string {
	if (process.platform === "win32") return "";
	try { return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", timeout: 1_000, stdio: ["ignore", "pipe", "ignore"] }).trim(); }
	catch { return ""; }
}
const stopped = (pid: number) => /^[Tt]/.test(psState(pid));
function ownerState(owner: Owner): OwnerState {
	if (owner.host && owner.host !== hostname()) return "elsewhere";
	return typeof owner.pid === "number" && stopped(owner.pid) ? "suspended" : "running";
}

function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
function birth(pid: number): string | undefined {
	if (process.platform === "win32") return undefined;
	try { return execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 1_000, stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, TZ: "UTC", LC_ALL: "C" } }).trim() || undefined; }
	catch { return undefined; }
}
function stale(owner: Owner): boolean {
	if (owner.host && owner.host !== hostname()) return false;
	if (typeof owner.pid !== "number" || !Number.isInteger(owner.pid) || owner.pid <= 0) return true;
	// A zombie has exited; only its parent has not reaped it yet.
	if (!alive(owner.pid) || psState(owner.pid).startsWith("Z")) return true;
	// Older leases used the caller's timezone; a mismatch cannot prove that their process died.
	const started = owner.started && owner.birthFormat === "utc-c" ? birth(owner.pid) : undefined;
	return !!started && started !== owner.started;
}

export function acquireParent(dir: string): () => void {
	mkdirSync(dir, { recursive: true });
	const lock = join(dir, ".owner");
	const file = join(lock, "owner.json");
	const token = randomUUID();
	const blocked = (message: string) => new Error(`${message} Lock: ${lock}. If no parent owns it, remove that lock directory and retry.`);
	const read = (): Owner => JSON.parse(readFileSync(file, "utf8"));
	const claim = () => {
		mkdirSync(lock);
		writeFileSync(file, JSON.stringify({ pid: process.pid, token, host: hostname(), started: birth(process.pid), birthFormat: "utc-c" }), { mode: 0o600 });
	};
	try { claim(); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		let owner: Owner = {};
		try { owner = read(); }
		catch { if (Date.now() - statSync(lock).mtimeMs < INCOMPLETE_GRACE_MS) throw blocked("Subagents are already opening in another process."); }
		if (!stale(owner)) throw new LeaseHeld(dir, owner, ownerState(owner));
		const reaping = join(lock, "reaping");
		try { mkdirSync(reaping); }
		catch {
			if (Date.now() - statSync(reaping).mtimeMs < REAPER_GRACE_MS) throw blocked("Another process is recovering this subagent roster.");
			rmSync(reaping, { recursive: true });
			mkdirSync(reaping);
		}
		let current: Owner = {};
		try { current = read(); } catch { current = {}; }
		if (!stale(current)) {
			rmSync(reaping, { recursive: true });
			throw new LeaseHeld(dir, current, ownerState(current));
		}
		rmSync(lock, { recursive: true });
		claim();
	}
	return () => {
		let owner: Owner;
		try { owner = read(); }
		catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
		if (owner.token === token) rmSync(lock, { recursive: true });
	};
}

export type Takeover = { readonly ok: true; readonly pid?: number; readonly notice?: string } | { readonly ok: false; readonly error: string };

export interface TakeoverOptions {
	readonly waitMs?: number;
	/** Asked before any signal is sent; false cancels. */
	readonly confirm?: (owner: { readonly pid: number; readonly state: OwnerState }) => Promise<boolean>;
}

function readOwner(file: string): Owner | undefined {
	try { return JSON.parse(readFileSync(file, "utf8")) as Owner; }
	catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : {}; }
}

/**
 * Ends the parent that holds `dir`'s lease, so this one can open the roster:
 * only on this host, never this process, never past SIGTERM. Resolves once
 * the lease is free, or reports why it is not.
 */
export async function takeOverParent(dir: string, options: TakeoverOptions = {}): Promise<Takeover> {
	const file = join(dir, ".owner", "owner.json");
	const owner = readOwner(file);
	if (!owner) return { ok: true };
	if (owner.host && owner.host !== hostname()) return { ok: false, error: `Process ${owner.pid} on ${owner.host} owns this session's subagents. Quit it there; takeover works only on the same host.` };
	if (stale(owner)) return { ok: true };
	const pid = owner.pid!;
	if (pid === process.pid) return { ok: false, error: "Another session in this Pi process owns these subagents. Close that session; takeover never ends this Pi process." };
	if (process.platform === "win32") return { ok: false, error: `Takeover needs POSIX signals. Close process ${pid} yourself.` };
	try { process.kill(pid, 0); }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EPERM") return { ok: false, error: `Process ${pid} belongs to another user, so this Pi can't end it.` };
		return { ok: true };
	}
	if (options.confirm && !(await options.confirm({ pid, state: ownerState(owner) }))) {
		return { ok: false, error: `Takeover cancelled. Process ${pid} still owns this session's subagents.` };
	}
	try {
		process.kill(pid, "SIGTERM");
		// A stopped process acts on SIGTERM only once it runs again.
		process.kill(pid, "SIGCONT");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
	// Wait for the lease, not the exit: Pi lets it go in session_shutdown, then may stop again on its
	// terminal restore, as a background process that sets raw mode gets SIGTTOU.
	const released = () => {
		const now = readOwner(file);
		return !now || now.token !== owner.token || stale(now);
	};
	const waitMs = options.waitMs ?? TAKEOVER_WAIT_MS;
	for (const start = Date.now(); !released(); await new Promise((resolve) => setTimeout(resolve, TAKEOVER_POLL_MS))) {
		if (Date.now() - start < waitMs) continue;
		if (stopped(pid)) return { ok: false, error: `Process ${pid} stopped again before it let the subagents go. Run fg in its terminal so that it can quit, then run /subagents takeover again.` };
		return { ok: false, error: `Process ${pid} did not quit within ${Math.round(waitMs / 1000)} s of SIGTERM, and takeover sends no stronger signal. Quit that Pi yourself, then run /subagents takeover again.` };
	}
	// Pi restores its terminal after it lets the lease go, and from the background that restore stops it again.
	const settling = (state: string) => state !== "" && !/^[TtZ]/.test(state);
	for (const start = Date.now(); settling(psState(pid)) && Date.now() - start < TAKEOVER_SETTLE_MS;) {
		await new Promise((resolve) => setTimeout(resolve, TAKEOVER_POLL_MS));
	}
	return stopped(pid)
		? { ok: true, pid, notice: `Process ${pid} let the subagents go but is still suspended. Run fg in its terminal so that it can quit.` }
		: { ok: true, pid };
}
