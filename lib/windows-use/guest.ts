/**
 * One Hyper-V guest as windows_use sees it: Windows-MCP inside it, reached
 * through the host, plus the recovery that keeps it usable without the agent
 * or the user stepping in. Before a tool runs, the guest must be running,
 * unlocked and serving; whatever is missing is repaired here:
 *
 * - Windows starting, restarting or installing updates: wait for it
 * - locked (server answers, LogonUI runs in its session, no desktop on screen): sign in at the console
 * - unreachable, installed, no desktop on screen: sign in, the logon task starts it
 * - unreachable with the desktop showing, or never installed: install it
 *
 * The console is only clicked when no taskbar shows even after pressing the
 * Windows key, which brings up Start and the taskbar over any unlocked desktop,
 * full-screen apps included, and does nothing on lock and sign-in screens; and
 * only when the screen isn't busy. So an unlocked desktop is never clicked blind.
 */
import type { ToolResult } from "../computer-use/session.ts";
import { hasTaskbar, isDark, readFrame, type Frame } from "./frame.ts";
import { toResult } from "./result.ts";

export interface HostCallOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export interface HostCalls {
	call(method: string, params?: Record<string, unknown>, options?: HostCallOptions): Promise<unknown>;
}

interface Timing {
	/** How long an unlocked verdict holds before the next tool call checks again. */
	readonly lockTtlMs: number;
	/** Wait for the server after signing in: the logon task has to start it. */
	readonly logonWaitMs: number;
	/** Wait for a server that may just be starting on an unlocked desktop. */
	readonly restartWaitMs: number;
	/** Wait for a first install: uv, Python and Windows-MCP download. */
	readonly installWaitMs: number;
	/** Wait for the typed bootstrap to report that it started; past it, typing went astray. */
	readonly bootstrapStartMs: number;
	/** Pause after clicking Sign in before looking at the screen again. */
	readonly signInSettleMs: number;
	/** Pause after pressing the Windows key for Start and the taskbar to appear. */
	readonly startMenuMs: number;
	/** Wait for Windows to finish starting: a restart that installs updates takes minutes. */
	readonly bootWaitMs: number;
	/** Windows started this recently: its logon task may still be starting the server. */
	readonly recentBootMs: number;
	readonly pollMs: number;
}

const TIMING: Timing = {
	lockTtlMs: 30_000,
	logonWaitMs: 90_000,
	restartWaitMs: 15_000,
	installWaitMs: 15 * 60_000,
	bootstrapStartMs: 120_000,
	signInSettleMs: 10_000,
	startMenuMs: 1_500,
	bootWaitMs: 15 * 60_000,
	recentBootMs: 5 * 60_000,
	pollMs: 3_000,
};

export const DEFAULT_PORT = 8000;
const PROTOCOL_VERSION = "2025-06-18";
/**
 * The line typed into the guest's elevated PowerShell: it unpacks and runs the
 * gzip+base64 bootstrap the host substitutes for __PAYLOAD__. It lives here,
 * not in host.ps1, because antivirus delays scripts that contain it.
 */
export const LAUNCHER = "$b='__PAYLOAD__';$g=New-Object IO.Compression.GZipStream((New-Object IO.MemoryStream(,[Convert]::FromBase64String($b))),[IO.Compression.CompressionMode]::Decompress);iex (New-Object IO.StreamReader($g)).ReadToEnd()";
/**
 * Only a LogonUI in the server's own session means this desktop is locked: a
 * pending enhanced-session connection runs one in a session of its own.
 */
const LOCK_CHECK = "$me = (Get-Process -Id $PID).SessionId; if (Get-Process LogonUI -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $me }) { 'locked' } else { 'unlocked' }";
/** A thumbnail this wide is plenty to find the taskbar, and quick to fetch. */
const TASKBAR_FRAME_WIDTH = 320;
/** Sign in clicks per repair: a second covers a screen that wasn't ready; more won't help a password. */
const MAX_SIGN_IN_CLICKS = 2;
/**
 * Console errors while a VM changes state: devices and screen vanish for a
 * moment mid-restart, and input is refused as "invalid state" (32775) or
 * "system not available" (32777). If the VM was saved or turned off instead,
 * the next status check says so.
 */
const RESETTING = /not found on '|GetVirtualSystemThumbnailImage failed|failed with code 3277[57]\b/;
/** Longest a single Windows-MCP call may take; PowerShell calls can set their own timeout below it. */
const TOOL_TIMEOUT_MS = 10 * 60_000;

export interface GuestOptions {
	readonly host: HostCalls;
	readonly vm: string;
	readonly port?: number;
	/** Told what recovery did, for the agent to read with the result. */
	readonly note?: (text: string) => void;
	readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	readonly now?: () => number;
	readonly timing?: Partial<Timing>;
}

interface Status {
	readonly running: boolean;
	readonly state: string;
	readonly installed: boolean;
	/** Whether Windows answers Hyper-V's heartbeat; null when that integration service is off. */
	readonly heartbeat?: boolean | null;
	/** Seconds since Windows last started; Hyper-V resets it on every restart. */
	readonly uptime?: number | null;
}

export const wait = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
	if (signal?.aborted) return reject(new Error("windows_use call cancelled"));
	const timer = setTimeout(resolve, ms);
	signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("windows_use call cancelled")); }, { once: true });
});

export class Guest {
	readonly vm: string;
	private readonly host: HostCalls;
	private readonly port: number;
	private readonly note: (text: string) => void;
	private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	private readonly now: () => number;
	private readonly timing: Timing;
	private connected = false;
	private unlockedAt = Number.NEGATIVE_INFINITY;
	private nextId = 1;

	constructor(options: GuestOptions) {
		this.vm = options.vm;
		this.host = options.host;
		this.port = options.port ?? DEFAULT_PORT;
		this.note = options.note ?? (() => {});
		this.sleep = options.sleep ?? wait;
		this.now = options.now ?? (() => Date.now());
		this.timing = { ...TIMING, ...options.timing };
	}

	/**
	 * Runs a Windows-MCP tool, repairing the guest first. A call that never
	 * reached the server is repaired and sent once more; one whose connection
	 * dropped mid-way may have run, so it is not repeated.
	 */
	async tool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
		await this.ensure(signal);
		try {
			return await this.callTool(name, args, signal);
		} catch (error) {
			if (!(error instanceof TransportError)) throw error;
			this.forget();
			if (!error.unsent) throw new Error(`The connection to Windows-MCP on ${this.vm} dropped during ${name}, so it may have run; it was not repeated. The next call reconnects. (${error.message})`);
			await this.ensure(signal);
			return this.callTool(name, args, signal);
		}
	}

	/** Signs in at the console, whatever the screen shows. */
	async login(signal?: AbortSignal): Promise<void> {
		await this.running(signal);
		await this.host.call("login", { vm: this.vm }, { signal });
		this.unlockedAt = Number.NEGATIVE_INFINITY;
		this.note(`${this.vm}: clicked Sign in at the console`);
	}

	/** Installs (or repairs) Windows-MCP, getting to the desktop first. */
	async setup(signal?: AbortSignal): Promise<void> {
		await this.running(signal);
		await this.install(signal);
	}

	/** Checks the lock again before the next tool call; the connection stays. */
	recheck(): void {
		this.unlockedAt = Number.NEGATIVE_INFINITY;
	}

	forget(): void {
		this.connected = false;
		this.unlockedAt = Number.NEGATIVE_INFINITY;
	}

	private async ensure(signal?: AbortSignal): Promise<void> {
		if (this.connected && this.now() - this.unlockedAt < this.timing.lockTtlMs) return;
		const status = await this.running(signal);
		if (!this.connected && !(await this.connect(signal))) await this.revive(status, signal);
		if (this.now() - this.unlockedAt >= this.timing.lockTtlMs) await this.unlock(signal);
	}

	private async running(signal?: AbortSignal): Promise<Status> {
		const status = await this.host.call("status", { vm: this.vm }, { signal }) as Status;
		if (!status.running) throw new Error(`${this.vm} is ${status.state}, not running. Start it with win.start({ vm: ${JSON.stringify(this.vm)} }) if that is intended.`);
		return status;
	}

	/** The server is unreachable: get to the desktop, give the logon task its time, else reinstall. */
	private async revive(status: Status, signal?: AbortSignal): Promise<void> {
		if (status.installed) {
			// After a logon, or a start that signed itself in, the task starts the server; give it time.
			const fresh = await this.reachDesktop(signal) || await this.bootedRecently(signal);
			if (await this.waitConnect(fresh ? this.timing.logonWaitMs : this.timing.restartWaitMs, signal)) return;
			// The desktop can linger as Windows begins to restart. If it restarted since, the logon task brings the server back.
			if (!fresh && (await this.reachDesktop(signal) || await this.bootedRecently(signal)) && await this.waitConnect(this.timing.logonWaitMs, signal)) return;
		}
		await this.install(signal);
	}

	private async install(signal?: AbortSignal): Promise<void> {
		await this.reachDesktop(signal);
		this.note(`${this.vm}: installing Windows-MCP in the guest (a first install takes a few minutes)`);
		const { run } = await this.host.call("setup", { vm: this.vm, port: this.port, launcher: LAUNCHER }, { signal, timeoutMs: 5 * 60_000 }) as { run?: string };
		const bootstrap = run ? { run, startBy: this.now() + this.timing.bootstrapStartMs, started: false } : undefined;
		if (!(await this.waitConnect(this.timing.installWaitMs, signal, bootstrap))) {
			throw new Error(`Windows-MCP did not come up on ${this.vm}. The guest's PowerShell window shows why: win.console.screenshot({ vm: ${JSON.stringify(this.vm)} }).`);
		}
		this.note(`${this.vm}: Windows-MCP is ready`);
	}

	/**
	 * Gets the console to an unlocked desktop. Waits while Windows is busy, and
	 * clicks Sign in only on a screen that is neither busy nor a desktop, at most
	 * twice. Returns whether a logon just happened (it waited or clicked), after
	 * which the logon task needs time to start the server.
	 */
	private async reachDesktop(signal?: AbortSignal, reason = ""): Promise<boolean> {
		const deadline = this.now() + this.timing.bootWaitMs;
		let clicks = 0;
		let waited = false;
		for (;;) {
			const screen = await this.look(signal);
			if (screen === "desktop") return waited || clicks > 0;
			if (screen === "busy") {
				if (this.now() >= deadline) {
					throw new Error(`${this.vm} did not finish starting within ${Math.round(this.timing.bootWaitMs / 60_000)} minutes (its screen stays dark, or Windows sends no heartbeat). Look with win.console.screenshot({ vm: ${JSON.stringify(this.vm)} }).`);
				}
				if (!waited) this.note(`${this.vm}: waiting for Windows to finish starting (boot, restart or updates)`);
				waited = true;
				await this.sleep(this.timing.pollMs, signal);
				continue;
			}
			if (clicks >= MAX_SIGN_IN_CLICKS) {
				throw new Error(`${this.vm} still shows no desktop after clicking Sign in (the account may need a password). Look with win.console.screenshot({ vm: ${JSON.stringify(this.vm)} }), get to the desktop with win.console.* input, then try again.`);
			}
			if (await this.consoleInput("login", {}, signal)) {
				clicks++;
				this.note(`${this.vm}: ${reason}signed in at the console`);
				await this.sleep(this.timing.signInSettleMs, signal);
			}
		}
	}

	/** Whether Windows started within the last few minutes, going by Hyper-V's uptime. */
	private async bootedRecently(signal?: AbortSignal): Promise<boolean> {
		const { uptime } = await this.running(signal);
		return typeof uptime === "number" && uptime * 1000 < this.timing.recentBootMs;
	}

	/**
	 * What the console shows. Busy: Windows is starting, restarting or installing
	 * updates, seen as no heartbeat, a nearly black screen even after a key
	 * (which also wakes a sleeping display), or devices missing mid-reset.
	 * Other: neither, such as the lock or sign-in screen.
	 */
	private async look(signal?: AbortSignal): Promise<"desktop" | "busy" | "other"> {
		if ((await this.running(signal)).heartbeat === false) return "busy";
		let first = await this.frame(signal);
		if (first && hasTaskbar(first)) return "desktop";
		if (!first || isDark(first)) {
			// A sleeping display is black too. Wake it with a key that does nothing by
			// itself, so the Esc below only ever follows a Start menu it opened.
			if (!(await this.consoleInput("key", { keys: "shift" }, signal))) return "busy";
			await this.sleep(this.timing.startMenuMs, signal);
			first = await this.frame(signal);
			if (first && hasTaskbar(first)) return "desktop";
		}
		if (!(await this.consoleInput("key", { keys: "win" }, signal))) return "busy";
		await this.sleep(this.timing.startMenuMs, signal);
		const second = await this.frame(signal);
		if (!second) return "busy";
		if (hasTaskbar(second)) {
			// Start opened over whatever was in front; close it so it is as the user left it.
			await this.consoleInput("key", { keys: "esc" }, signal);
			return "desktop";
		}
		return isDark(second) ? "busy" : "other";
	}

	/** A small console frame, or undefined while the VM resets. */
	private async frame(signal?: AbortSignal): Promise<Frame | undefined> {
		try {
			return readFrame(await this.host.call("frame", { vm: this.vm, width: TASKBAR_FRAME_WIDTH }, { signal }));
		} catch (error) {
			if (error instanceof Error && RESETTING.test(error.message)) return undefined;
			throw error;
		}
	}

	/** Console input that a VM resetting mid-restart can't take; returns whether it went in. */
	private async consoleInput(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<boolean> {
		try {
			await this.host.call(method, { vm: this.vm, ...params }, { signal });
			return true;
		} catch (error) {
			if (error instanceof Error && RESETTING.test(error.message)) return false;
			throw error;
		}
	}

	private async waitConnect(ms: number, signal?: AbortSignal, initial?: Bootstrap): Promise<boolean> {
		const deadline = this.now() + ms;
		let bootstrap = initial;
		for (;;) {
			const probe = await this.host.call("probe", { vm: this.vm, port: this.port }, { signal }) as { reachable?: boolean; setup?: unknown };
			if (probe.reachable && await this.connect(signal)) return true;
			if (bootstrap) bootstrap = this.checkBootstrap(bootstrap, probe.setup);
			if (this.now() >= deadline) return false;
			await this.sleep(this.timing.pollMs, signal);
		}
	}

	/**
	 * Reads the bootstrap's progress, which the guest publishes over Hyper-V
	 * key-value exchange as "<run> <status>". A status from an earlier run is
	 * ignored, so a leftover success or failure can't be misread.
	 */
	private checkBootstrap(bootstrap: Bootstrap, published: unknown): Bootstrap {
		const prefix = `${bootstrap.run} `;
		if (typeof published === "string" && published.startsWith(prefix)) {
			const status = published.slice(prefix.length);
			if (status.startsWith("FAIL ")) {
				throw new Error(`Installing Windows-MCP on ${this.vm} failed in the guest: ${status.slice(5)}. Its PowerShell window stays open with the details: win.console.screenshot({ vm: ${JSON.stringify(this.vm)} }). Fix the cause, then call win.setup.`);
			}
			return { ...bootstrap, started: true };
		}
		if (!bootstrap.started && this.now() >= bootstrap.startBy) {
			throw new Error(`The Windows-MCP installer never started on ${this.vm}: the bootstrap typed into an elevated PowerShell from Start search didn't run. Look with win.console.screenshot({ vm: ${JSON.stringify(this.vm)} }), close stray windows, then call win.setup.`);
		}
		return bootstrap;
	}

	/** Checks the server answers with the key we hold; stateless HTTP needs no session beyond this. */
	private async connect(signal?: AbortSignal): Promise<boolean> {
		try {
			await this.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "pi-extras windows_use", version: "1" } }, signal);
			await this.send({ jsonrpc: "2.0", method: "notifications/initialized" }, signal);
			this.connected = true;
			return true;
		} catch (error) {
			if (!isTransport(error)) throw error;
			this.connected = false;
			return false;
		}
	}

	private async unlock(signal?: AbortSignal): Promise<void> {
		// The guest's word alone never triggers a click: reachDesktop clicks only when the console agrees.
		if (await this.locked(signal)) await this.reachDesktop(signal, "was locked; ");
		this.unlockedAt = this.now();
	}

	private async locked(signal?: AbortSignal): Promise<boolean> {
		const result = await this.callTool("PowerShell", { command: LOCK_CHECK }, signal);
		return /\blocked\b/.test(result.content.map((block) => block.type === "text" ? block.text : "").join("\n"));
	}

	private async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
		return toResult(await this.request("tools/call", { name, arguments: args }, signal));
	}

	private async request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
		const id = this.nextId++;
		const messages = await this.send({ jsonrpc: "2.0", id, method, params }, signal);
		const reply = messages.find((message) => message.id === id);
		if (!reply) throw new TransportError(`Windows-MCP on ${this.vm} did not answer ${method}`);
		if (reply.error) throw new Error(String(reply.error.message ?? `${method} failed`));
		return reply.result;
	}

	private async send(message: object, signal?: AbortSignal): Promise<{ id?: unknown; result?: unknown; error?: { message?: unknown } }[]> {
		try {
			const answer = await this.host.call("mcp", { vm: this.vm, port: this.port, message: JSON.stringify(message) }, { signal, timeoutMs: TOOL_TIMEOUT_MS }) as { messages?: unknown };
			return Array.isArray(answer.messages) ? answer.messages : [];
		} catch (error) {
			if (signal?.aborted) throw error;
			// Anything the host reports here is between it and the server: unreachable, wrong key, no IP yet.
			const message = error instanceof Error ? error.message : String(error);
			throw new TransportError(message, NOT_SENT.test(message));
		}
	}
}

interface Bootstrap {
	readonly run: string;
	readonly startBy: number;
	readonly started: boolean;
}

/** Host errors that prove a request never reached the server, so sending it again is safe. */
const NOT_SENT = /^(cannot reach Windows-MCP|VM '.*' has no IPv4 address|Windows-MCP is not set up)/;

class TransportError extends Error {
	/** True only when the request provably never reached the server. */
	readonly unsent: boolean;

	constructor(message: string, unsent = false) {
		super(message);
		this.unsent = unsent;
	}
}

const isTransport = (error: unknown) => error instanceof TransportError;
