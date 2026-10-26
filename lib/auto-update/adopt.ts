/**
 * The adoption decision for one session, without effects: does this session
 * run the current set, and if not, should it reload, restart, or only say
 * that an update is ready? The extension (extensions/auto-update.ts) reads
 * the inputs and carries out the decision.
 */
import { classify } from "./sources.ts";
import type { UpdateSet, UpdateState } from "./state.ts";

/** Reloads or restarts for one target that still leave the session on another set: then stop and say so. */
export const MAX_ATTEMPTS = 2;
/** No user or agent activity for this long before a session moves. */
export const QUIET_MS = 30_000;

export interface OwnSet {
	readonly piVersion: string;
	/** The real folder of the running Pi. */
	readonly piDir: string;
	/** Store entries this session loaded (settings `packages` sources inside the store). */
	readonly entries: readonly string[];
}

/** What a session compares and records: the target set's Pi and entries, and a short fingerprint. */
export function fingerprint(set: UpdateSet): string {
	return JSON.stringify([set.pi.version, ...Object.values(set.packages).map((release) => release.entry).sort()]);
}

export function piDiffers(own: OwnSet, set: UpdateSet): boolean {
	return own.piVersion !== set.pi.version;
}

export function packagesDiffer(own: OwnSet, set: UpdateSet): boolean {
	const wanted = Object.values(set.packages).map((release) => release.entry).sort();
	const have = [...own.entries].sort();
	return wanted.length !== have.length || wanted.some((entry, index) => entry !== have[index]);
}

/** "pi-extras 0.29.0 -> 0.30.0, Pi 1.4.0 -> 1.4.1": what moving to `set` changes for this session. */
export function changeText(own: OwnSet, state: UpdateState, set: UpdateSet, storeRoot: string): string {
	const known = [state.previous, state.current, set].flatMap((candidate) => (candidate ? Object.values(candidate.packages) : []));
	const ownByKey = new Map(own.entries.map((entry) => {
		const classified = classify(entry, storeRoot);
		return [classified.kind === "store" ? classified.key : entry, entry] as const;
	}));
	const parts: string[] = [];
	if (piDiffers(own, set)) parts.push(`Pi ${own.piVersion} -> ${set.pi.version}`);
	for (const [key, release] of Object.entries(set.packages)) {
		const from = ownByKey.get(key);
		if (from === release.entry) continue;
		const to = release.label ?? release.id;
		const before = known.find((candidate) => candidate.entry === from)?.label;
		const [name, version] = to.split(" ");
		parts.push(before?.split(" ")[0] === name && version ? `${name} ${before.split(" ")[1]} -> ${version}` : to);
	}
	return parts.join(", ") || "packages";
}

export interface AdoptInput {
	readonly own: OwnSet;
	readonly state: UpdateState;
	readonly storeRoot: string;
	readonly adopt: "auto" | "notice";
	readonly mode: string;
	/** The launcher started this process, and the session has a file to resume. */
	readonly canRestart: boolean;
	/** pi-current and settings.json already name `state.current` (the cycle finished its switch). */
	readonly ready: boolean;
	/** Reloads or restarts this session already made for the current target. */
	readonly attempts: number;
}

export type Decision =
	| { readonly kind: "none" }
	| { readonly kind: "wait" }
	| { readonly kind: "reload" | "restart"; readonly target: string; readonly text: string }
	| { readonly kind: "notice"; readonly text: string };

export function decide(input: AdoptInput): Decision {
	const set = input.state.current;
	if (!set) return { kind: "none" };
	const pi = piDiffers(input.own, set);
	if (!pi && !packagesDiffer(input.own, set)) return { kind: "none" };
	const change = changeText(input.own, input.state, set, input.storeRoot);
	if (!input.ready) return { kind: "wait" };
	if (input.attempts >= MAX_ATTEMPTS) return { kind: "notice", text: `${change} is ready, but this session did not move to it. Restart Pi to use it.` };
	if (input.adopt === "notice") return { kind: "notice", text: `${change} ready: ${pi ? "restart Pi" : "use /reload"} to use it` };
	const target = fingerprint(set);
	if (!pi) return { kind: "reload", target, text: `Updating ${change}: reloading` };
	// A restart starts `pi --session <file>`: only the terminal UI can come back that way without losing its client.
	if (input.canRestart && input.mode === "tui") return { kind: "restart", target, text: `Updating ${change}: restarting` };
	return { kind: "notice", text: `Pi ${set.pi.version} ready: restart to use it` };
}

export interface IdleSignals {
	readonly agentIdle: boolean;
	readonly pendingMessages: boolean;
	readonly compacting: boolean;
	readonly promptOpen: boolean;
	/** A pi-extras subagent runs a turn in this process (lib/idle-gc.ts processBusy). */
	readonly subagentRun: boolean;
	/** Shell jobs that have not ended, or subagents that are still live (also when they wait for mail). */
	readonly background: boolean;
	readonly editorEmpty: boolean;
	readonly lastActivityAt: number;
	readonly now: number;
}

/**
 * True when the session may move now. Shell jobs and a subagent team survive
 * a reload (both park their runtime and the next module takes it over) but
 * not a restart, which ends the process, so only a restart waits for them.
 */
export function idleFor(kind: "reload" | "restart", signals: IdleSignals): boolean {
	if (!signals.agentIdle || signals.pendingMessages || signals.compacting || signals.promptOpen || signals.subagentRun) return false;
	if (!signals.editorEmpty || signals.now - signals.lastActivityAt < QUIET_MS) return false;
	return kind === "reload" || !signals.background;
}
