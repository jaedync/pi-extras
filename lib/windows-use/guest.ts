/**
 * One Hyper-V guest as windows_use sees it: Windows-MCP inside it, reached
 * through the host, plus the recovery that keeps it usable without the agent
 * or the user stepping in. Before a tool runs, the guest must be running,
 * unlocked and serving; whatever is missing is repaired here:
 *
 * - Windows starting, restarting or installing updates: wait for it
 * - locked and confirmed at the console: sign in there; locked remote sessions need the user
 * - unreachable, installed, no desktop on screen: wait, then ask the user; never assume console sign-in is safe
 * - unreachable with the desktop showing, or never installed: install it
 * - reachable but answering no tool (stalled calls hold every worker): restart it through the guest relay, else from the Run box
 * - a snapshot stalled by Start or its search: restart them and snapshot again
 *
 * With the guest relay installed, calls, session checks and restarts go over
 * a Hyper-V socket, which a VPN in the guest can't cut and which needs no
 * console. The guest's IP route remains the fallback, and installs the relay.
 *
 * Console input requires a fresh report of an active console session, or (for
 * setup/repair when the server is unavailable) a visible console desktop.
 * A remembered remote session only blocks input; it never authorizes recovery.
 */
import type { ToolResult } from "../computer-use/session.ts";
import { textOf, toResult } from "./result.ts";
import { Screen, type Look } from "./screen.ts";
import { hasTaskbar } from "./frame.ts";
import { consoleRefusal, readSession, requireActive, SESSION_CHECK, toSession, type DesktopSession } from "./desktop-session.ts";
import { checkBootstrap, LAUNCHER, NO_OCR, openAdminShell, type Bootstrap } from "./install.ts";
import type { RelayCalls } from "./relay-channel.ts";
import { RELAY_SHA, type ControlReply } from "./relay.ts";
import { readRelayDeployed, relayDeployCommands, type RelayDeployed } from "./relay-deploy.ts";
import { TIMING, type Timing } from "./timing.ts";
import { HOST_TIMEOUT, NOT_SENT, TransportError } from "./transport.ts";
import { CAPTURES, COLD_CAPTURE_MS, COLD_MS, DEFAULT_TOOL_MS, FRONT_WINDOW, hangMessage, QUICK_MS, readFront, RESTART_SERVER, RESTART_SETTLE_MS, RESTART_SHELL_UI, RUN_BOX, SHELL_UI, stallMessage, toolLimit, type FrontWindow } from "./stall.ts";

export interface HostCallOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export interface HostCalls {
	call(method: string, params?: Record<string, unknown>, options?: HostCallOptions): Promise<unknown>;
	/** Starts the host process ahead of its first call. */
	warm?(): void;
}


export const DEFAULT_PORT = 8000;
const PROTOCOL_VERSION = "2025-06-18";
/** Hyper-V states a VM passes through on its way between running, off and saved. */
const IN_BETWEEN = /^(?:shutting down|starting|stopping|resuming|saving|pausing|state \d+)$/;
/** Sign in clicks per repair: a second covers a screen that wasn't ready; more won't help a password. */
const MAX_SIGN_IN_CLICKS = 2;
/** Paced make/break events keep case and symbols intact; a full compressed bootstrap needs minutes. */
const BOOTSTRAP_INPUT_MS = 10 * 60_000;
/** A relay answers a ping in tens of milliseconds; a missing one only times out. */
const RELAY_PING_MS = 5_000;
/** A relay just installed takes a second or two to start Python and listen. */
const RELAY_START_MS = 20_000;
/** The relay's restart ends the task, kills the server, waits 3 s and starts it: each step has 30 s. */
const RELAY_RESTART_MS = 120_000;
const WAKE_CHECK_MS = 20_000;
/**
 * Initialize is answered by the server's HTTP layer, not a tool worker: under a
 * second even while tools stall. Past this the server itself is stuck, and each
 * second is the agent's; a wedge took 72 s to repair with the former 30 s.
 */
const INITIALIZE_MS = 15_000;

interface RelayPing {
	readonly listening: boolean;
	/** Seconds since the relay started; it starts with the signed-in session. */
	readonly uptime: number;
	/** The running script's hash; relays before it report none. */
	readonly script?: string;
}

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
	/** The Hyper-V socket route to the guest relay; without it only the guest's IP route is used. */
	readonly relay?: RelayCalls;
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
	private desktop?: DesktopSession;
	private connected = false;
	private readonly relay?: RelayCalls;
	/** Which route the current connection's calls take. */
	private via: "relay" | "host" = "host";
	/** The relay is installed at most once per install of the server. */
	private relayInstall: "unchecked" | "done" | "failed" = "unchecked";
	/**
	 * The server's own rights, from a check run inside it once per connection.
	 * The relay's rights normally match, but a relay started from the Run key
	 * can't be elevated, and a mismatch there would reinstall the server for nothing.
	 */
	private serverElevated?: boolean;
	private unlockedAt = Number.NEGATIVE_INFINITY;
	/** When the console display was last seen awake. */
	private awakeAt = Number.NEGATIVE_INFINITY;
	/** The relay's last answer to a ping, for its script's version. */
	private lastPing?: RelayPing;
	/** The server's own session, from the in-server check the relay's must agree with. */
	private serverSession?: number;
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
		this.relay = options.relay;
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
			if (!(error instanceof TransportError)) throw error;
			this.forget();
			if (error.timedOut) await this.restartServer(signal);
			else if (!error.unsent) throw error;
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
		const front = await this.frontWindow(signal).catch((error: unknown) => {
			if (CAPTURES.has(name) || signal?.aborted) throw error;
			throw new Error(`${hangMessage(this.vm, name, limit)} Recovery stopped: ${error instanceof Error ? error.message : String(error)}`);
		});
		const restarted = front === "restarted";
		if (!CAPTURES.has(name)) throw new Error(hangMessage(this.vm, name, limit, restarted));
		// Getting the front window brought the guest back (Windows restarted under the capture): look again.
		if (!restarted && this.coldUntil !== coldUntil) return this.captureAgain(name, args, limit, front, signal);
		if (restarted || !front || !SHELL_UI.test(front.process)) throw new Error(stallMessage(this.vm, name, limit, restarted ? undefined : front, restarted));
		requireActive(this.vm, await this.lockCheck(signal));
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
		const relayed = await this.relayRestart(signal, "Windows-MCP stopped answering (a stalled call held it); restarted it through the guest relay");
		if (relayed === "back") return;
		// The Run box would run the same restart, and fail the same way.
		if (relayed === "down") throw cannot("it didn't come back after a restart through the guest relay");
		await this.assertConsole(signal);
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
		await this.assertConsole(signal);
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

	/** Signs in only when a fresh check confirms the desktop is at the console. */
	async login(signal?: AbortSignal): Promise<void> {
		await this.running(signal);
		const state = await this.inspect(signal);
		if (state?.where !== "console" || !state.active) throw consoleRefusal(this.vm, this.where() === "remote");
		await this.reachDesktop(signal, "", true);
		this.recheck();
	}

	/** Installs (or repairs) Windows-MCP, getting to the desktop first. */
	async setup(signal?: AbortSignal): Promise<void> {
		await this.running(signal);
		await this.install(signal);
	}

	/** Last reported location. Retained across failures so disconnects cannot enable console repair. */
	where(): "console" | "remote" | "unknown" { return this.desktop?.where ?? "unknown"; }

	/** Read-only probe: no setup, wake, sign-in, or restart if the server is unavailable. */
	async inspect(signal?: AbortSignal): Promise<DesktopSession | undefined> {
		try {
			if (!this.connected && await this.connect(signal) !== "ok") return await this.relayDesktop(signal);
			return await this.lockCheck(signal);
		} catch (error) {
			if (!(error instanceof TransportError)) throw error;
			this.forget();
			return this.relayDesktop(signal);
		}
	}

	/**
	 * The session from the relay's own WTS query, for when the server can't
	 * answer. Without it a stopped server leaves only the console's picture to
	 * judge by, and a console showing a desktop doesn't mean the user is on it.
	 */
	private async relayDesktop(signal?: AbortSignal): Promise<DesktopSession | undefined> {
		const state = await this.relaySession(signal);
		return state && this.observe({ ...state, elevated: this.serverElevated ?? state.elevated });
	}

	/** A stale console observation never authorizes input; a stale remote one still forbids it. */
	async assertConsole(signal?: AbortSignal): Promise<void> {
		const state = await this.inspect(signal);
		if (this.where() === "remote") throw consoleRefusal(this.vm, true);
		if (state?.where === "console" && state.active) return;
		if (!state) {
			const frame = await this.screen.frame(signal);
			if (frame && hasTaskbar(frame)) return;
		}
		throw consoleRefusal(this.vm, false);
	}

	/** Connected and checked unlocked lately, for helpers that need a foreground-window check. */
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
		// Connected, a VM that went away fails the next call as unsent, which comes back here unconnected.
		if (!this.connected) {
			// Both processes start at once; each takes about a second.
			this.relay?.warm?.();
			this.host.warm?.();
			// A relay that answers shows the VM is running. Status is left out then, not just
			// unawaited: the host runs one call at a time, and the console's next frame would wait.
			const relay = await this.ping(signal);
			const status = relay ? undefined : await this.running(signal);
			const reply = await this.connect(signal, relay ?? null);
			// Listening and silent: restarting it (ensureAnswering) beats waiting on it or reinstalling.
			if (reply === "silent") throw new TransportError(`Windows-MCP on ${this.vm} took the connection and answered nothing`, false, true);
			if (reply === "unreachable") await this.revive(status ?? await this.running(signal), signal);
		}
		// Session moves and disconnects can happen between consecutive calls, even within the old lock TTL.
		await this.unlock(signal);
		// Missing or outdated: put in this relay while a route works, before a VPN can cut the IP one.
		if (this.relay && (this.via === "host" || this.lastPing?.script !== RELAY_SHA)) await this.installRelay(signal);
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
		const relay = await this.ping(signal);
		if (relay) {
			// The relay runs in the signed-in session: no console sign-in or typing is needed.
			// Just after sign-in the logon task may still be starting the server; give it that
			// time. Long after, nothing is starting it, and waiting only delays the restart.
			if (relay.uptime * 1000 < this.timing.logonWaitMs && await this.waitConnect(this.timing.logonWaitMs, signal)) return;
			// Otherwise on to the console's repairs, which the session checks below still guard.
			if (await this.relayRestart(signal, "Windows-MCP wasn't answering; restarted it through the guest relay") === "back") return;
			// Where the desktop is decides whether the console may be touched at all.
			await this.relayDesktop(signal);
		}
		if (this.where() === "remote") {
			if (await this.waitConnect(this.timing.restartWaitMs, signal)) return;
			throw consoleRefusal(this.vm, true);
		}
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
		await this.assertConsole(signal);
		await this.reachDesktop(signal, "", this.connected);
		this.note(`${this.vm}: installing Windows-MCP in the guest (a first install takes a few minutes)`);
		const { pollMs, adminShellMs: openMs, shellReadyMs: readyMs } = this.timing;
		await this.assertConsole(signal);
		await openAdminShell({ host: this.host, vm: this.vm, screen: this.screen, sleep: this.sleep, now: this.now, pollMs, openMs, readyMs }, signal);
		await this.assertConsole(signal);
		const { run } = await this.host.call("setup", { vm: this.vm, port: this.port, launcher: LAUNCHER, elevated: this.elevated }, { signal, timeoutMs: BOOTSTRAP_INPUT_MS }) as { run?: string };
		// Setup wrote a new key, and its bootstrap stopped the relay with the server.
		this.relay?.forget();
		this.relayInstall = "unchecked";
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
	private async reachDesktop(signal?: AbortSignal, reason = "", confirmed = false): Promise<boolean> {
		const deadline = this.now() + this.timing.bootWaitMs;
		let clicks = 0;
		let waited = false;
		for (;;) {
			if (this.where() === "remote") throw consoleRefusal(this.vm, true);
			// The guest may recover into RDP while its unrelated console remains black.
			if (!confirmed && await this.waitConnect(0, signal)) return true;
			if (confirmed) await this.assertConsole(signal);
			const screen = await this.look(signal, confirmed);
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
			if (!confirmed) {
				if (await this.waitConnect(this.timing.logonWaitMs, signal)) return true;
				throw consoleRefusal(this.vm, false);
			}
			if (clicks >= MAX_SIGN_IN_CLICKS) {
				throw new Error(`${this.vm} still shows no desktop after clicking Sign in (the account may need a password). Look with win.console.screenshot({ vm: ${JSON.stringify(this.vm)} }), get to the desktop with win.console.* input, then try again.`);
			}
			await this.assertConsole(signal);
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

	private async look(signal?: AbortSignal, allowInput = false): Promise<Look> {
		return this.screen.look((await this.running(signal)).heartbeat, signal, allowInput);
	}

	private async waitConnect(ms: number, signal?: AbortSignal, initial?: Bootstrap): Promise<boolean> {
		const deadline = this.now() + ms;
		let bootstrap = initial;
		for (;;) {
			const relay = await this.ping(signal);
			if (relay?.listening && await this.connect(signal, relay) === "ok") return true;
			// Without a relay, the IP route. A bootstrap's status is read either way: the old
			// relay answers until setup stops it, and a setup failing before then must be seen.
			if (!relay || bootstrap) {
				const probe = await this.host.call("probe", { vm: this.vm, port: this.port }, { signal }) as { reachable?: boolean; setup?: unknown };
				if (!relay && probe.reachable && await this.connect(signal, null) === "ok") return true;
				if (bootstrap) bootstrap = checkBootstrap(this.vm, this.now(), bootstrap, probe.setup);
			}
			if (this.now() >= deadline) return false;
			await this.sleep(this.timing.pollMs, signal);
		}
	}

	/**
	 * Connects over the relay when it answers, else over the guest's IP, which
	 * then installs the relay. A relay that answers while its server doesn't
	 * listen means the server is down: the IP route couldn't reach it either.
	 */
	private async connect(signal?: AbortSignal, known?: RelayPing | null): Promise<"ok" | "unreachable" | "silent"> {
		this.serverElevated = undefined;
		this.serverSession = undefined;
		// The caller's fresh ping, if it has one: a missing relay costs a connect timeout per ping.
		const relay = known === undefined ? await this.ping(signal) : known ?? undefined;
		if (relay) {
			this.via = "relay";
			if (!relay.listening) { this.connected = false; return "unreachable"; }
			return this.initialize(signal);
		}
		this.via = "host";
		return this.initialize(signal);
	}

	/** The relay's report, or undefined when there's none to reach (not installed, or the guest is down). */
	private async ping(signal?: AbortSignal): Promise<RelayPing | undefined> {
		if (!this.relay) return undefined;
		try {
			const reply = await this.relay.control("ping", { signal, timeoutMs: RELAY_PING_MS });
			this.lastPing = reply.ok && "listening" in reply ? reply : undefined;
		} catch (error) {
			if (signal?.aborted || !(error instanceof TransportError)) throw error;
			this.lastPing = undefined;
		}
		return this.lastPing;
	}

	/**
	 * Restarts the server through the relay, which needs no console. Absent: no
	 * relay could do it, so the caller's other repairs apply. Down: it restarted
	 * and the server still doesn't answer.
	 */
	private async relayRestart(signal: AbortSignal | undefined, what: string): Promise<"absent" | "back" | "down"> {
		if (!this.relay || !(await this.ping(signal))) return "absent";
		let reply: ControlReply;
		try {
			reply = await this.relay.control("restart", { signal, timeoutMs: RELAY_RESTART_MS });
		} catch (error) {
			// A restart that may have run anyway is harmless to run again from the console.
			if (signal?.aborted || !(error instanceof TransportError)) throw error;
			return "absent";
		}
		// End and kill fail harmlessly when nothing runs; only starting the task again matters.
		if (!reply.ok || !("steps" in reply) || !reply.steps.some((step) => step.step === "run" && step.code === 0)) return "absent";
		this.note(`${this.vm}: ${what}`);
		this.forget();
		this.cameBack();
		await this.sleep(RESTART_SETTLE_MS, signal);
		if (await this.waitConnect(this.timing.logonWaitMs, signal)) return "back";
		this.note(`${this.vm}: Windows-MCP didn't come back within ${Math.round(this.timing.logonWaitMs / 1000)} s of that restart`);
		return "down";
	}

	/**
	 * Puts the relay in the guest through the server itself, whenever the IP
	 * route is in use: never installed, or since stopped. A failure leaves the IP
	 * route working, is noted, and isn't tried again until the server is reinstalled.
	 */
	private async installRelay(signal?: AbortSignal): Promise<void> {
		if (!this.relay || this.relayInstall === "failed") return;
		// An older relay answering is replaced over its own route, which works under a VPN.
		const replacing = this.via === "relay";
		this.relayInstall = "failed";
		let deployed: RelayDeployed;
		try {
			let text = "";
			for (const command of relayDeployCommands(replacing)) {
				const result = await this.callTool("PowerShell", { command, timeout: 60 }, signal, QUICK_MS + 60_000);
				text = textOf(result);
				if (result.isError || !/Status Code: 0\s*$/.test(text)) throw new Error(text.replace(/\s+/g, " ").trim().slice(0, 400));
			}
			deployed = readRelayDeployed(text);
		} catch (error) {
			if (signal?.aborted) throw error;
			this.note(`${this.vm}: couldn't install the Hyper-V socket relay (${error instanceof Error ? error.message : String(error)}); Windows-MCP stays reachable only over the guest's network, which a VPN in the guest can cut`);
			return;
		}
		// The relay restarts a moment after the install answers; wait for this script's.
		for (const deadline = this.now() + RELAY_START_MS; (await this.ping(signal))?.script !== RELAY_SHA; await this.sleep(1_000, signal)) {
			if (this.now() >= deadline) {
				this.note(replacing
					? `${this.vm}: updated the Hyper-V socket relay, but the new one didn't answer; calls go on over the route that works`
					: `${this.vm}: installed the Hyper-V socket relay, but it didn't answer; Windows-MCP stays reachable only over the guest's network for now`);
				return;
			}
		}
		this.relayInstall = "done";
		this.via = "relay";
		if (replacing) this.note(`${this.vm}: updated the Hyper-V socket relay to this version of windows_use`);
		else if (deployed.restart === "scheduled") this.note(`${this.vm}: installed a Hyper-V socket relay (${deployed.mode === "task" ? "a logon task" : "started at sign-in"}), so Windows-MCP stays reachable without the guest's network: a VPN in the guest can't cut it off`);
		// Windows-MCP reads the flag at start; the glow it draws otherwise lands in console OCR and slows captures.
		if (deployed.flash === "added") await this.relayRestart(signal, "restarted Windows-MCP once so its orange-red capture flash stays off");
	}

	/**
	 * Checks the server answers with the key we hold; stateless HTTP needs no
	 * session beyond this. Silent: it took the request and never answered.
	 */
	private async initialize(signal?: AbortSignal): Promise<"ok" | "unreachable" | "silent"> {
		try {
			await this.request("initialize", { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "pi-extras windows_use", version: "1" } }, signal, INITIALIZE_MS);
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
		const state = await this.lockCheck(signal);
		requireActive(this.vm, state);
		if (state.where === "console") {
			// Windows turns a display off after a minute idle at the soonest; a frame costs most of a second.
			if (this.now() - this.awakeAt >= WAKE_CHECK_MS) {
				if (await this.screen.wake(signal)) this.note(`${this.vm}: woke the display, which had gone dark`);
				this.awakeAt = this.now();
			}
			if (state.locked && await this.reachDesktop(signal, "was locked; ", true)) this.cameBack();
		}
		if (state.elevated !== this.elevated) {
			await this.matchRights(signal);
			requireActive(this.vm, await this.lockCheck(signal));
		}
		this.unlockedAt = this.now();
	}

	private async lockCheck(signal?: AbortSignal): Promise<DesktopSession> {
		return this.observe(await this.readDesktop(signal));
	}

	private observe(state: DesktopSession): DesktopSession {
		// Only an active console observation can clear an earlier remote-session warning.
		if (state.where === "remote" || state.where === "console" && state.active) this.desktop = state;
		return state;
	}

	/**
	 * The relay reads WTS in milliseconds; a PowerShell check inside the server
	 * takes about half a second, and runs once per connection for the server's rights.
	 */
	private async readDesktop(signal?: AbortSignal): Promise<DesktopSession> {
		if (this.via === "relay" && this.serverElevated !== undefined) {
			const session = await this.relaySession(signal);
			// Only the server's own session counts; otherwise it checks for itself, as without a relay.
			if (session && session.id === this.serverSession) return { ...session, elevated: this.serverElevated };
		}
		const result = await this.callTool("PowerShell", { command: SESSION_CHECK }, signal, QUICK_MS);
		const state = readSession(result.isError ? "" : textOf(result));
		this.serverElevated = state.elevated;
		this.serverSession = state.id;
		return state;
	}

	/** The relay's native WTS query, or undefined when it can't give one. */
	private async relaySession(signal?: AbortSignal): Promise<DesktopSession | undefined> {
		if (!this.relay) return undefined;
		try {
			const reply = await this.relay.control("session", { signal, timeoutMs: RELAY_PING_MS });
			return reply.ok && "session" in reply ? toSession(reply.session) : undefined;
		} catch (error) {
			if (signal?.aborted) throw error;
			// Unreachable, a failed query, or a session it can't vouch for (session 0).
			return undefined;
		}
	}

	/** Reinstalls a server whose rights aren't the ones this session asks for. */
	private async matchRights(signal?: AbortSignal): Promise<void> {
		if (this.where() === "remote") throw new Error(`${this.vm}: Windows-MCP's administrator rights do not match PI_WINDOWS_USE_ELEVATED. Automatic reinstall is disabled in an enhanced/remote session. Match the setting to this server or arrange an explicit repair without moving the desktop.`);
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
			if (this.via === "relay" && this.relay) return await this.relay.mcp(JSON.stringify(message), { signal, timeoutMs }) as Awaited<ReturnType<Guest["send"]>>;
			const answer = await this.host.call("mcp", { vm: this.vm, port: this.port, message: JSON.stringify(message) }, { signal, timeoutMs }) as { messages?: unknown };
			return Array.isArray(answer.messages) ? answer.messages : [];
		} catch (error) {
			if (signal?.aborted || error instanceof TransportError) throw error;
			// Anything the host reports here is between it and the server: unreachable, wrong key, no IP yet.
			const message = error instanceof Error ? error.message : String(error);
			throw new TransportError(message, NOT_SENT.test(message), HOST_TIMEOUT.test(message));
		}
	}
}
