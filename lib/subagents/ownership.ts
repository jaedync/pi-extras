/** Local leases include process birth time so PID reuse cannot strand a saved roster. */
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const INCOMPLETE_GRACE_MS = 5_000;
const REAPER_GRACE_MS = 5 * 60_000;
interface Owner { pid?: number; token?: string; host?: string; started?: string; birthFormat?: string }

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
	if (!alive(owner.pid)) return true;
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
		if (!stale(owner)) throw blocked(`Subagents are already owned by process ${owner.pid}. Close that parent before resuming here.`);
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
			throw blocked(`Subagents are already owned by process ${current.pid}.`);
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
