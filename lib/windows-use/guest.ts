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
 * - reachable but answering no tool (stalled calls hold every worker): restart it from the Run box
 * - a snapshot stalled by Start or its search: restart them and snapshot again
 *
 * The console is only clicked when no taskbar shows even after pressing the
 * Windows key, which brings up Start and the taskbar over any unlocked desktop,
 * full-screen apps included, and does nothing on lock and sign-in screens; and
 * only when the screen isn't busy. So an unlocked desktop is never clicked blind.
 */
import type { ToolResult } from "../computer-use/session.ts";
import { textOf, toResult } from "./result.ts";
import { Screen, type Look } from "./screen.ts";
import { checkBootstrap, LAUNCHER, NO_OCR, openAdminShell, type Bootstrap } from "./install.ts";
import { TIMING, type Timing } from "./timing.ts";
import { HOST_TIMEOUT, NOT_SENT, TransportError } from "./transport.ts";
import { CAPTURES, COLD_CAPTURE_MS, COLD_MS, DEFAULT_TOOL_MS, FRONT_WINDOW, hangMessage, QUICK_MS, readFront, RESTART_SERVER, RESTART_SETTLE_MS, RESTART_SHELL_UI, RUN_BOX, SHELL_UI, stallMessage, toolLimit, type FrontWindow } from "./stall.ts";

export interface HostCallOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export interface HostCalls {
	call(method: string, params?: Record<string, unknown>, options?: HostCallOptions): Promise<unknown>;
}


export const DEFAULT_PORT = 8000;
const PROTOCOL_VERSION = "2025-06-18";
/**
 * Only a LogonUI in the server's own session means this desktop is locked: a
 * pending enhanced-session connection runs one in a session of its own. The
 * PowerShell it runs in has the server's rights, which it reports as well.
 */
const LOCK_CHECK = "$me = (Get-Process -Id $PID).SessionId; $lock = if (Get-Process LogonUI -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $me }) { 'locked' } else { 'unlocked' }; $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator); \"$lock $(if ($admin) { 'elevated' } else { 'limited' })\"";
/** Hyper-V states a VM passes through on its way between running, off and saved. */
const IN_BETWEEN = /^(?:shutting down|starting|stopping|resuming|saving|pausing|state \d+)$/;
/** Sign in clicks per repair: a second covers a screen that wasn't ready; more won't help a password. */
const MAX_SIGN_IN_CLICKS = 2;

export interface GuestOptions {
	readonly host: HostCalls;
	readonly vm: string;
	readonly port?: number;
	/** Told what recovery did, for the agent to read with the result. */
	readonly note?: (text: string) => void;
	readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	readonly now?: () => number;
	readonly timing?: Partial<Timing>;
	/** Windows-MCP should run with administrator rights (PI_WINDOWS_USE_ELEVATED); a server installed otherwise is reinstalled. */
	readonly elevated?: boolean;
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
	private readonly screen: Screen;
	private readonly elevated: boolean;
	/** A server with other rights than asked is reinstalled once; if that doesn't take, it is left as it is. */
	private rights: "unchecked" | "reinstalled" | "settled" = "unchecked";
	private connected = false;
	private unlockedAt = Number.NEGATIVE_INFINITY;
	/** Until then the guest has just come back (restart, sign-in, new server), and captures get longer. */
	private coldUntil = Number.NEGATIVE_INFINITY;
	private nextId = 1;

	constructor(options: GuestOptions) {
		this.vm = options.vm;
		this.host = options.host;
		this.port = options.port ?? DEFAULT_PORT;
		this.note = options.note ?? (() => {});
		this.sleep = options.sleep ?? wait;
		this.now = options.now ?? (() => Date.now());
		this.timing = { ...TIMING, ...options.timing };
		this.elevated = options.elevated === true;
		this.screen = new Screen({ host: this.host, vm: this.vm, sleep: this.sleep, settleMs: this.timing.startMenuMs });
	}

	/**
	 * Runs a Windows-MCP tool, repairing the guest first. A call that never
	 * reached the server is repaired and sent once more; one whose connection
	 * dropped mid-way may have run, so it is not repeated. A server that
	 * answers nothing is restarted first.
	 */
	async tool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
		await this.ensureAnswering(signal);
		try {
			return await this.callTool(name, args, signal);
		} catch (error) {
			if (!(error instanceof TransportError)) throw error;
			this.forget();
			if (error.timedOut) return this.afterStall(name, args, signal);
			if (!error.unsent) throw new Error(`The connection to Windows-MCP on ${this.vm} dropped during ${name}, so it may have run; it was not repeated. The next call reconnects. (${error.message})`);
			await this.ensure(signal);
			return this.callTool(name, args, signal);
		}
	}

	/** ensure(), restarting a server whose lock check, a moment's PowerShell, gets no answer. */
	private async ensureAnswering(signal?: AbortSignal): Promise<void> {
		try {
			await this.ensure(signal);
		} catch (error) {
			if (!(error instanceof TransportError && error.timedOut)) throw error;
			await this.restartServer(signal);
			await this.ensure(signal);
		}
	}

	/**
	 * A call got no answer. Whatever it was, a server that answers nothing now
	 * is restarted. A capture stalled by Start or its search, which Windows
	 * restarts on demand, gets them restarted and runs again; any other is
	 * reported with the window that stalled it.
	 */
	private async afterStall(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult> {
		const limit = this.limit(name, args);
		const coldUntil = this.coldUntil;
		const front = await this.frontWindow(signal);
		const restarted = front === "restarted";
		if (!CAPTURES.has(name)) throw new Error(hangMessage(this.vm, name, limit, restarted));
		// Getting the front window brought the guest back (Windows restarted under the capture): look again.
		if (!restarted && this.coldUntil !== coldUntil) return this.captureAgain(name, args, limit, front, signal);
		if (restarted || !front || !SHELL_UI.test(front.process)) throw new Error(stallMessage(this.vm, name, limit, restarted ? undefined : front, restarted));
		await this.callTool("PowerShell", { command: RESTART_SHELL_UI }, signal, QUICK_MS);
		this.note(`${this.vm}: Start or its search stopped answering UI Automation and stalled ${name}; restarted them (Windows brings them back when next opened)`);
		await this.sleep(this.timing.startMenuMs, signal);
		return this.captureAgain(name, args, limit, front, signal);
	}

	/** A capture's one retry after recovery; a second stall is reported. */
	private async captureAgain(name: string, args: Record<string, unknown>, limit: number, front: FrontWindow | undefined, signal?: AbortSignal): Promise<ToolResult> {
		try {
			return await this.callTool(name, args, signal);
		} catch (error) {
			if (!(error instanceof TransportError && error.timedOut)) throw error;
			this.forget();
			throw new Error(stallMessage(this.vm, name, limit, front));
		}
	}

	/** The window in front, if the guest can say; "restarted" if the server answered nothing and was restarted. */
	private async frontWindow(signal?: AbortSignal): Promise<FrontWindow | "restarted" | undefined> {
		try {
			await this.ensure(signal);
			return readFront(textOf(await this.callTool("PowerShell", { command: FRONT_WINDOW }, signal, QUICK_MS)));
		} catch (error) {
			if (!(error instanceof TransportError && error.timedOut)) throw error;
			await this.restartServer(signal);
			return "restarted";
		}
	}

	/**
	 * Restarts a server that answers nothing, from the console's Run box, as the
	 * signed-in user. The Run box is read before anything is typed, so a command
	 * never lands in another window; without OCR to read it, nothing is typed.
	 */
	private async restartServer(signal?: AbortSignal): Promise<void> {
		this.forget();
		const vm = JSON.stringify(this.vm);
		const cannot = (why: string) => new Error(`Windows-MCP on ${this.vm} stopped answering (a stalled call holds it), and ${why}. Reinstalling restarts it: win.setup({ vm: ${vm} }).`);
		if (!(await this.screen.input("key", { keys: "win+r" }, signal))) throw cannot("the console took no input");
		let open = false;
		for (let read = 0; read < 3 && !open; read++) {
			await this.sleep(this.timing.startMenuMs, signal);
			try {
				open = RUN_BOX.test(await this.screen.text(signal));
			} catch (error) {
				if (!(error instanceof Error && NO_OCR.test(error.message))) throw error;
				throw cannot("without Windows OCR the console's Run box can't be checked before typing into it");
			}
		}
		if (!open) throw cannot("the console's Run box didn't open to restart it from");
		await this.screen.input("type", { text: `${RESTART_SERVER}\n` }, signal);
		this.note(`${this.vm}: Windows-MCP stopped answering (a stalled call held it); restarted it from the console's Run box`);
		this.cameBack();
		await this.sleep(RESTART_SETTLE_MS, signal);
		if (!(await this.waitConnect(this.timing.logonWaitMs, signal))) throw cannot("it didn't come back after a restart");
	}

	/** Windows-MCP's tools as it lists them, with their input schemas. */
	async tools(signal?: AbortSignal): Promise<{ name?: unknown; inputSchema?: { properties?: Record<string, unknown>; required?: readonly unknown[] } }[]> {
		await this.ensureAnswering(signal);
		const listed = await this.request("tools/list", {}, signal, QUICK_MS) as { tools?: unknown };
		return Array.isArray(listed?.tools) ? listed.tools : [];
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

	/** Connected and checked unlocked lately, so a tool call runs without repairs first. */
	ready(): boolean {
		return this.connected && this.now() - this.unlockedAt < this.timing.lockTtlMs;
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
		if (!this.connected) {
			const reply = await this.connect(signal);
			// Listening and silent: restarting it (ensureAnswering) beats waiting on it or reinstalling.
			if (reply === "silent") throw new TransportError(`Windows-MCP on ${this.vm} took the connection and answered nothing`, false, true);
			if (reply === "unreachable") await this.revive(status, signal);
		}
		if (this.now() - this.unlockedAt >= this.timing.lockTtlMs) await this.unlock(signal);
	}

	/**
	 * The VM's status, once it is running. Hyper-V shows a restart inside
	 * Windows as shutting down, then starting; those are waited out, as they
	 * may end with it running again.
	 */
	private async running(signal?: AbortSignal): Promise<Status> {
		const deadline = this.now() + this.timing.transitionWaitMs;
		let status = await this.host.call("status", { vm: this.vm }, { signal }) as Status;
		for (let noted = false; !status.running && IN_BETWEEN.test(status.state) && this.now() < deadline; noted = true) {
			if (!noted) this.note(`${this.vm}: waiting while Hyper-V shows the VM ${status.state} (a restart inside Windows passes through it)`);
			await this.sleep(this.timing.pollMs, signal);
			status = await this.host.call("status", { vm: this.vm }, { signal }) as Status;
		}
		if (!status.running) throw new Error(`${this.vm} is ${status.state}, not running. Start it with win.start({ vm: ${JSON.stringify(this.vm)} }) if that is intended.`);
		return status;
	}

	/** The server is unreachable: get to the desktop, give the logon task its time, else reinstall. */
	private async revive(status: Status, signal?: AbortSignal): Promise<void> {
		this.cameBack();
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
		const { pollMs, adminShellMs: openMs, shellReadyMs: readyMs } = this.timing;
		await openAdminShell({ host: this.host, vm: this.vm, screen: this.screen, sleep: this.sleep, now: this.now, pollMs, openMs, readyMs }, signal);
		const { run } = await this.host.call("setup", { vm: this.vm, port: this.port, launcher: LAUNCHER, elevated: this.elevated }, { signal, timeoutMs: 5 * 60_000 }) as { run?: string };
		const bootstrap = run ? { run, startBy: this.now() + this.timing.bootstrapStartMs, started: false } : undefined;
		if (!(await this.waitConnect(this.timing.installWaitMs, signal, bootstrap))) {
			throw new Error(`Windows-MCP did not come up on ${this.vm}. The guest's PowerShell window shows why: win.console.screenshot({ vm: ${JSON.stringify(this.vm)} }).`);
		}
		this.note(`${this.vm}: Windows-MCP is ready`);
		this.cameBack();
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
			if (await this.screen.input("login", {}, signal)) {
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

	private async look(signal?: AbortSignal): Promise<Look> {
		return this.screen.look((await this.running(signal)).heartbeat, signal);
	}

	private async waitConnect(ms: number, signal?: AbortSignal, initial?: Bootstrap): Promise<boolean> {
		const deadline = this.now() + ms;
		let bootstrap = initial;
		for (;;) {
			const probe = await this.host.call("probe", { vm: this.vm, port: this.port }, { signal }) as { reachable?: boolean; setup?: unknown };
			if (probe.reachable && await this.connect(signal) === "ok") return true;
			if (bootstrap) bootstrap = checkBootstrap(this.vm, this.now(), bootstrap, probe.setup);
			if (this.now() >= deadline) return false;
			await this.sleep(this.timing.pollMs, signal);
		}
	}

	/**
	 * Checks the server answers with the key we hold; stateless HTTP needs no
	 * session beyond this. Silent: it took the request and never answered.
	 */
	private async connect(signal?: AbortSignal): Promise<"ok" | "unreachable" | "silent"> {
		try {
			await this.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "pi-extras windows_use", version: "1" } }, signal, QUICK_MS);
			await this.send({ jsonrpc: "2.0", method: "notifications/initialized" }, signal, QUICK_MS);
			this.connected = true;
			return "ok";
		} catch (error) {
			if (!(error instanceof TransportError)) throw error;
			this.connected = false;
			return error.timedOut ? "silent" : "unreachable";
		}
	}

	private async unlock(signal?: AbortSignal): Promise<void> {
		if (await this.screen.wake(signal)) this.note(`${this.vm}: woke the display, which had gone dark`);
		const { locked, elevated } = await this.lockCheck(signal);
		// The guest's word alone never triggers a click: reachDesktop clicks only when the console agrees.
		if (locked && await this.reachDesktop(signal, "was locked; ")) this.cameBack();
		this.unlockedAt = this.now();
		if (elevated !== undefined && elevated !== this.elevated) await this.matchRights(signal);
	}

	private async lockCheck(signal?: AbortSignal): Promise<{ locked: boolean; elevated?: boolean }> {
		const text = textOf(await this.callTool("PowerShell", { command: LOCK_CHECK }, signal, QUICK_MS));
		const rights = /\b(elevated|limited)\b/.exec(text)?.[1];
		return { locked: /\blocked\b/.test(text), elevated: rights === undefined ? undefined : rights === "elevated" };
	}

	/** Reinstalls a server whose rights aren't the ones this session asks for. */
	private async matchRights(signal?: AbortSignal): Promise<void> {
		if (this.rights === "settled") return;
		if (this.rights === "reinstalled") {
			this.rights = "settled";
			this.note(`${this.vm}: Windows-MCP still runs ${this.elevated ? "without" : "with"} administrator rights: the guest user may not be an administrator. Left as it is.`);
			return;
		}
		this.rights = "reinstalled";
		this.note(this.elevated
			? `${this.vm}: Windows-MCP ran without administrator rights, and PI_WINDOWS_USE_ELEVATED asks for them: reinstalling it with them`
			: `${this.vm}: Windows-MCP ran with administrator rights, which PI_WINDOWS_USE_ELEVATED doesn't ask for: reinstalling it without them`);
		await this.install(signal);
	}

	private cameBack(): void {
		this.coldUntil = this.now() + COLD_MS;
	}

	private limit(name: string, args: Record<string, unknown>): number {
		return CAPTURES.has(name) && this.now() < this.coldUntil ? COLD_CAPTURE_MS : toolLimit(name, args);
	}

	private async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal, limitMs = this.limit(name, args)): Promise<ToolResult> {
		return toResult(await this.request("tools/call", { name, arguments: args }, signal, limitMs));
	}

	private async request(method: string, params: unknown, signal?: AbortSignal, timeoutMs = DEFAULT_TOOL_MS): Promise<unknown> {
		const id = this.nextId++;
		const messages = await this.send({ jsonrpc: "2.0", id, method, params }, signal, timeoutMs);
		const reply = messages.find((message) => message.id === id);
		if (!reply) throw new TransportError(`Windows-MCP on ${this.vm} did not answer ${method}`);
		if (reply.error) throw new Error(String(reply.error.message ?? `${method} failed`));
		return reply.result;
	}

	private async send(message: object, signal?: AbortSignal, timeoutMs = DEFAULT_TOOL_MS): Promise<{ id?: unknown; result?: unknown; error?: { message?: unknown } }[]> {
		try {
			const answer = await this.host.call("mcp", { vm: this.vm, port: this.port, message: JSON.stringify(message) }, { signal, timeoutMs }) as { messages?: unknown };
			return Array.isArray(answer.messages) ? answer.messages : [];
		} catch (error) {
			if (signal?.aborted) throw error;
			// Anything the host reports here is between it and the server: unreachable, wrong key, no IP yet.
			const message = error instanceof Error ? error.message : String(error);
			throw new TransportError(message, NOT_SENT.test(message), HOST_TIMEOUT.test(message));
		}
	}
}
