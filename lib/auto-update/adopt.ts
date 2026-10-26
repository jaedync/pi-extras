/**
 * The adoption decision for one session, without effects: does this session
 * run the current set, and if not, should it reload, restart, or only say
 * that an update is ready? The extension (extensions/auto-update.ts) reads
 * the inputs and carries out the decision.
 */
import { classify, storeRelease } from "./sources.ts";
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

/**
 * The version that a store entry shows, from its release id: an npm id is
 * the version, a git id is `<version>-<commit>` or `head-<commit>`. For an
 * entry whose set is no longer in the state (the session missed a cycle).
 */
function storeVersion(entry: string | undefined, storeRoot: string): string | undefined {
	const found = entry === undefined ? undefined : storeRelease(entry, storeRoot);
	if (!found) return undefined;
	if (!found.key.startsWith("git-")) return found.id;
	return found.id.startsWith("head-") ? found.id.slice("head-".length) : found.id.replace(/-[0-9a-f]{7}$/, "");
}

/** "pi-extras 0.29.0 → 0.30.0, Pi 1.4.0 → 1.4.1": what moving to `set` changes for this session. */
export function changeText(own: OwnSet, state: UpdateState, set: UpdateSet, storeRoot: string): string {
	const known = [state.previous, state.current, set].flatMap((candidate) => (candidate ? Object.values(candidate.packages) : []));
	const ownByKey = new Map(own.entries.map((entry) => {
		const classified = classify(entry, storeRoot);
		return [classified.kind === "store" ? classified.key : entry, entry] as const;
	}));
	const parts: string[] = [];
	if (piDiffers(own, set)) parts.push(`Pi ${own.piVersion} → ${set.pi.version}`);
	for (const [key, release] of Object.entries(set.packages)) {
		const from = ownByKey.get(key);
		if (from === release.entry) continue;
		const to = release.label ?? release.id;
		const [name, version] = to.split(" ");
		const label = known.find((candidate) => candidate.entry === from)?.label?.split(" ");
		const before = label?.[0] === name ? label[1] : storeVersion(from, storeRoot);
		parts.push(before && version ? `${name} ${before} → ${version}` : to);
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
	| { readonly kind: "reload" | "restart"; readonly target: string; readonly text: string; readonly change: string }
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
	if (!pi) return { kind: "reload", target, change, text: `Updating ${change}: reloading` };
	// A restart starts `pi --session <file>`: only the terminal UI can come back that way without losing its client.
	if (input.canRestart && input.mode === "tui") return { kind: "restart", target, change, text: `Updating ${change}: restarting` };
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
	/** A user `!` or `!!` command runs (see userBashRunning). A reload or restart would cut it off. */
	readonly userBash: boolean;
	readonly lastActivityAt: number;
	readonly now: number;
}

/**
 * True when the session may move now. Shell jobs and a subagent team survive
 * a reload (both park their runtime and the next module takes it over) but
 * not a restart, which ends the process, so only a restart waits for them.
 */
export function idleFor(kind: "reload" | "restart", signals: IdleSignals): boolean {
	if (!signals.agentIdle || signals.pendingMessages || signals.compacting || signals.promptOpen || signals.subagentRun || signals.userBash) return false;
	if (!signals.editorEmpty || signals.now - signals.lastActivityAt < QUIET_MS) return false;
	return kind === "reload" || !signals.background;
}

/** A user command that has not ended after this long counts as ended: its end signal was lost (another extension ran it, or it failed early). */
export const USER_BASH_MAX_MS = 60 * 60_000;

export interface BashStart {
	readonly command: string;
	readonly at: number;
}

type BranchEntry = { readonly type: string; readonly message?: unknown };

/**
 * Pi 1.4 fires `user_bash` only when a `!` command starts, and its isIdle()
 * ignores a running command. The end is the `bashExecution` message that Pi
 * appends to the branch when the command finishes: one such entry with the
 * same command, at or after the start, ends one start.
 */
export function userBashRunning(starts: readonly BashStart[], branch: readonly BranchEntry[], now: number): boolean {
	const ends = branch.flatMap((entry) => {
		const message = entry.type === "message" ? (entry.message as { role?: unknown; command?: unknown; timestamp?: unknown } | undefined) : undefined;
		return message?.role === "bashExecution" && typeof message.command === "string" && typeof message.timestamp === "number" ? [{ command: message.command, at: message.timestamp }] : [];
	});
	const used = new Set<number>();
	// Oldest start first, so each takes the earliest end after it.
	return [...starts].sort((a, b) => a.at - b.at).some((start) => {
		const end = ends.findIndex((candidate, index) => !used.has(index) && candidate.command === start.command && candidate.at >= start.at);
		if (end >= 0) used.add(end);
		return end < 0 && now - start.at < USER_BASH_MAX_MS;
	});
}

/**
 * The part of Pi's TUI that tells where the keyboard focus is. pi-tui's `TUI`
 * interface has `hasOverlay`; its `TuiBase` class adds `getFocusedComponent`
 * and (protected in the types, a plain method at run time) `isOverlayFocused`.
 */
export interface FocusView {
	hasOverlay(): boolean;
	getFocusedComponent?(): unknown;
	isOverlayFocused?(): boolean;
}

/**
 * True while a built-in selector (`/model`, `/settings`, `/resume`, `/tree`)
 * or an overlay that captures the keyboard is open. Pi fires no event for
 * these, but each one takes the focus from the editor, and only pi-tui's
 * Editor (and editors built on it) has `getText`. A `nonCapturing` overlay
 * (a status panel) leaves the focus in the editor, so it does not count. No
 * focus at all says nothing; then the quiet time decides.
 */
export function selectorOpen(tui: FocusView | undefined): boolean {
	if (!tui) return false;
	try {
		if (typeof tui.isOverlayFocused === "function" && tui.isOverlayFocused()) return true;
		// A TUI that tells nothing about focus: any visible overlay counts, the safe side.
		if (typeof tui.getFocusedComponent !== "function") return tui.hasOverlay();
		const focused = tui.getFocusedComponent() as { getText?: unknown } | null | undefined;
		return focused !== null && focused !== undefined && typeof focused.getText !== "function";
	} catch {
		// A TUI that stopped: it shows nothing a reload could take away.
		return false;
	}
}
