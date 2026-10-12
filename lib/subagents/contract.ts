/**
 * What one evaluation of this package may call on objects another one made.
 *
 * Pi evaluates the package again on /reload. A session's subagents outlive
 * that (host.ts), so the new module calls the team, the mail and the tool
 * activity that an older evaluation made, and the older team calls the new
 * module's ports and launcher. These interfaces, the shapes they name, the
 * values both sides match on (message types, live states) and the globalThis
 * slots (host.ts, fresh-models.ts) are that contract, and `HOST_VERSION`
 * names it. Change any of them, or what one of their methods means, and bump
 * it: a module that finds a parked host of another version closes it with
 * that host's own code and starts as a reload did before (children
 * interrupted, then resumed). A contract test pins the declarations to the
 * version, so a change can't slip past. The registry's key and `ParkedHost`
 * never change at all: a module that can't find or close a parked host
 * leaves it to its timeout.
 *
 * Records follow the index's rule (restore.ts): a new field is optional, so
 * code of either side reads a record the other made.
 */
import type { MainContext, OutgoingMessage, PendingItem, Route } from "./deliver.ts";
import type { ModelChoice } from "./models.ts";
import type { SendResult } from "./team.ts";
import type { Watched } from "./tool-activity.ts";
import type { AgentRecord, CheckUpdate, Launcher, SpawnRequest } from "./types.ts";

export const HOST_VERSION = 2;

/** The team, as main's tools, the widget, the inspector and a child's tools use it. */
export interface HostTeam {
	get(name: string): AgentRecord | undefined;
	list(): AgentRecord[];
	live(): AgentRecord[];
	onChange(listener: (record: AgentRecord | null) => void): () => void;
	spawn(request: SpawnRequest): { ok: true; record: AgentRecord } | { ok: false; error: string };
	send(from: string, to: string, text: string, options?: { expectReply?: boolean; signal?: AbortSignal; automatic?: boolean; check?: CheckUpdate }): Promise<SendResult>;
	stop(name: string, options?: { by?: string; reason?: string }): Promise<AgentRecord | undefined>;
	stopping(): boolean;
	under(name: string, ancestor: string): boolean;
	whenDone(name: string): Promise<AgentRecord>;
	detach(name: string): void;
	messages(name: string): readonly unknown[];
	streaming(name: string): unknown;
	tool(name: string, toolName: string): object | undefined;
	claimEdit(name: string, target?: string): string | undefined;
	mayEdit(name: string, root?: string): boolean;
	bashChanged(name: string, paths: readonly string[], root: string): string | undefined;
}

/** Main's mail, as main's own events and the widget use it. */
export interface HostMail {
	pending(): PendingItem[];
	acknowledge(id: string): void;
	reconcile(entries: readonly unknown[]): void;
	retry(): void;
	owed(context: MainContext): boolean;
	answered(entries: readonly unknown[]): void;
	remind(): void;
	waiting(): boolean;
	takeAll(): { messages: OutgoingMessage[]; wakes: boolean };
}

/** Every agent's running edit and bash calls; main's tool events and a child's bash guard record them. */
export interface HostActivity {
	editStart(id: string, path: string): void;
	shellStart(id: string, root: string): void;
	end(id: string): void;
	watch(id: string, root: string): () => Watched;
}

/**
 * Mail to main that a closing host could not hand over: the index keeps it
 * (restore.ts) and the next start of the session posts it, whatever version
 * of this package that start runs.
 */
export interface HeldMail {
	readonly message: OutgoingMessage;
	/** Whether it asks main for a turn. */
	readonly wakes: boolean;
}

/** A custom message for main's session. */
export interface HostMessage {
	readonly customType: string;
	readonly content: string;
	readonly display: boolean;
	readonly details?: unknown;
}

/** The models children may use now, read at each session start. */
export interface ModelScope {
	readonly allowed: readonly ModelChoice[];
	readonly fallbackModel: string | null;
}

/** Everything a host needs from Pi, bound by the module that serves the session. */
export interface HostPorts {
	/** Hands main a message, as `pi.sendMessage`: its mail, or a notice such as the one after a restore. */
	send(message: HostMessage, options: { triggerTurn: boolean; deliverAs?: "steer" }): void;
	/** Where main is for its mail (main-watch.ts). */
	route(): Route;
	notify(message: string, level: "info" | "warning"): void;
	/** A record changed. */
	teamChanged(): void;
	/** The mail changed. */
	mailChanged(): void;
	/** Makes child sessions with the serving module's code. */
	readonly launcher: Launcher;
	models(): ModelScope;
}

/** A session's subagents: the team, its mail, its index and run log, and the lease on its children. */
export interface HostState {
	readonly version: number;
	/** The evaluation of this package that opened it. */
	readonly generation: number;
	readonly team: HostTeam;
	readonly mail: HostMail;
	readonly activity: HostActivity;
	/** The ports as bound now: the serving module's, or ones that hold everything while Pi reloads. */
	readonly ports: HostPorts;
	/** The module that serves the session now binds its ports; throws once the host is closed. */
	rebind(ports: HostPorts): void;
	/**
	 * Pi reloads: launches wait for the next module's launcher, mail to main is
	 * held, notices are queued. Should the host close before a module binds,
	 * its notices go to `log`.
	 */
	park(log?: (message: string) => void): void;
	/** No child works, starts, stops or waits, and all mail has reached main: the host can go without interrupting anything. */
	quiet(): boolean;
	/** Saves the index for the host that replaces this one, and gives it the lease to release. */
	handOver(): () => void;
	/** Lets go of everything once a replacement holds the lease; only when quiet. */
	retire(): Promise<void>;
	/** Announces children an earlier shutdown interrupted, and resumes those the policy allows. */
	restore(reason: string): Promise<void>;
	/** Interrupts every live child, saves the index with the reason and releases the lease. */
	close(reason?: string): Promise<void>;
}

/** A parked host as every version keeps it. These members never change, whatever `HOST_VERSION` says. */
export interface ParkedHost {
	readonly version: number;
	/** Takes the host over: its timeout and exit watch end. */
	claim(): unknown;
	/** Closes it with the code that made it, as a reload did before the handover existed. */
	close(reason: string): Promise<void>;
}
