/**
 * The sessions a team holds open for its children, and what each one's
 * current run has said.
 *
 * A session is released once its child ends: at once when it failed or was
 * stopped, after a quiet spell when it finished, since a follow-up often
 * comes quickly. A message to a released child relaunches it from its
 * session file with its context, so a long session's memory stays bounded.
 * A session the launcher says a launch now would not make (new code after a
 * /reload, an edited input, stamp.ts) goes at the child's next pause, so its
 * next run starts on what is current; a running child moves to a new session
 * at its next turn boundary instead (swap.ts).
 */
import type { AgentRecord, ChildHandle, Launcher } from "./types.ts";

/** A follow-up to a report usually comes within a minute or two; after that a relaunch costs less than holding the session. */
export const IDLE_RELEASE_MS = 120_000;

interface ReplyLike { role?: unknown; stopReason?: unknown; content?: unknown }

const textOf = (entry: ReplyLike): string => {
	const content = entry.content;
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content.filter((part) => (part as { type?: unknown }).type === "text")
		.map((part) => (part as { text?: unknown }).text ?? "").join("").trim();
};

/** A reply that ended its turn with text and no tool call, so it can be a report. */
const finalReply = (entry: ReplyLike): boolean => entry.role === "assistant"
	&& !["aborted", "error", "length"].includes(String(entry.stopReason ?? ""))
	&& !(Array.isArray(entry.content) && entry.content.some((part) => (part as { type?: unknown }).type === "toolCall"));

export interface SessionOptions {
	readonly launcher: Launcher;
	/** How long a finished child keeps its session; default IDLE_RELEASE_MS. */
	readonly idleReleaseMs?: number;
	/** Whether `name` is still idle when its quiet spell is over. */
	readonly idle: (name: string) => boolean;
	readonly warn: (message: string) => void;
}

export class OpenSessions {
	private readonly handles = new Map<string, ChildHandle>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Pi rebuilds shorter message lists on compaction, but retains message identities. */
	private readonly runStarts = new Map<string, ReadonlySet<unknown>>();
	private readonly options: SessionOptions;

	constructor(options: SessionOptions) {
		this.options = options;
	}

	get(name: string): ChildHandle | undefined {
		return this.handles.get(name);
	}

	all(): ChildHandle[] {
		return [...this.handles.values()];
	}

	hold(name: string, handle: ChildHandle): void {
		this.handles.set(name, handle);
	}

	/** A new run keeps the session it is about to use; what the session says from here on is the run's. */
	startRun(name: string, handle: ChildHandle): void {
		this.keep(name);
		this.runStarts.set(name, new Set(handle.messages()));
	}

	endRun(name: string): void {
		this.runStarts.delete(name);
	}

	runMessages(name: string): readonly unknown[] {
		const start = this.runStarts.get(name);
		return this.handles.get(name)?.messages().filter((message) => !start?.has(message)) ?? [];
	}

	/**
	 * The run's last answer, as text; none before it starts or when it said nothing.
	 * When a final reply is longer than the last one, the report keeps the longest
	 * first and each later reply under a note, so a short reply can't hide it.
	 */
	runText(name: string): string | undefined {
		if (!this.runStarts.has(name)) return undefined;
		const messages = this.runMessages(name);
		let at = -1;
		for (let i = messages.length - 1; i >= 0 && at < 0; i -= 1) {
			const entry = messages[i] as ReplyLike;
			if (entry.role !== "assistant") continue;
			if (entry.stopReason === "aborted" && Array.isArray(entry.content) && entry.content.length === 0) continue;
			at = i;
		}
		if (at < 0) return undefined;
		const text = textOf(messages[at] as ReplyLike);
		if (!text) return undefined;
		const replies = messages.flatMap((message, index) => {
			const entry = message as ReplyLike;
			const said = finalReply(entry) ? textOf(entry) : "";
			return said ? [{ index, said }] : [];
		});
		// A tie goes to the later reply, so the last one stays the report as it did before.
		const full = replies.reduce<(typeof replies)[number] | undefined>((best, one) => (!best || one.said.length >= best.said.length ? one : best), undefined);
		if (!full || full.index === replies.at(-1)!.index) return text;
		const notes = replies.filter((one) => one.index > full.index).map((one) => `Later note from ${name}:\n${one.said}`);
		return [full.said, ...notes].join("\n\n");
	}

	/**
	 * Whether the child's last response made only a `message` call. Its other
	 * calls may finish before the message is sent (sequential execution) or run
	 * inside another tool, so neither shows up as work after it.
	 */
	onlyMessageCall(name: string): boolean {
		const calls = this.lastCalls(name);
		return calls.length === 1 && (calls[0] as { name?: unknown }).name === "message";
	}

	/** The tool calls of the child's last response; none when it only wrote text. */
	lastCalls(name: string): readonly unknown[] {
		const messages = this.handles.get(name)?.messages() ?? [];
		const last = [...messages].reverse().find((message) => (message as { role?: unknown }).role === "assistant") as { content?: unknown } | undefined;
		return Array.isArray(last?.content) ? last.content.filter((part) => (part as { type?: unknown }).type === "toolCall") : [];
	}

	/** A run ended in `state`: its session goes now, after a quiet spell, or stays for a child still at work. */
	ended(name: string, state: AgentRecord["state"]): void {
		if (!this.handles.has(name)) return;
		if (state === "failed" || state === "stopped") return void this.release(name);
		if (state !== "idle") return;
		if (this.stale(name)) return void this.release(name);
		this.keep(name);
		const timer = setTimeout(() => {
			this.timers.delete(name);
			if (this.options.idle(name)) void this.release(name);
		}, this.options.idleReleaseMs ?? IDLE_RELEASE_MS);
		timer.unref?.();
		this.timers.set(name, timer);
	}

	/** Whether `name` holds a session a launch now would not make (types.ts `Launcher.current`). */
	stale(name: string): boolean {
		const handle = this.handles.get(name);
		return handle !== undefined && !(this.options.launcher.current?.(handle) ?? true);
	}

	/** Whether `name` holds a session on code older than a launch now would run (types.ts `Launcher.codeCurrent`). */
	newCode(name: string): boolean {
		const handle = this.handles.get(name);
		return handle !== undefined && !(this.options.launcher.codeCurrent?.(handle) ?? true);
	}

	async release(name: string): Promise<void> {
		const handle = this.handles.get(name);
		if (!handle) return;
		this.handles.delete(name);
		this.keep(name);
		try { await handle.dispose(); }
		catch (error) { this.options.warn(`subagents: releasing ${name}'s session failed: ${(error as Error).message}`); }
	}

	/** For a team that closes: no session goes on a timer any more; it lets them all go itself. */
	stopTimers(): void {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
	}

	clear(): void {
		this.handles.clear();
	}

	private keep(name: string): void {
		const timer = this.timers.get(name);
		if (timer) clearTimeout(timer);
		this.timers.delete(name);
	}
}
