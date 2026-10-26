/**
 * Auto-pull: when the user sends a message with links, Pull Link reads them
 * before the model starts and adds them to the session as one custom message,
 * so the model needs no pull_link call (and no extra turn) for them. Only what
 * a person types or sends over RPC counts: not extension messages, not a
 * subagent's task.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isChildSession } from "../child-session.ts";
import { watchMotion } from "../extras-config.ts";
import { AUTO_TYPE, autoMessage, findLinks, MAX_LINKS, MAX_NAMED_SKIPPED, type AutoMessage, type LinkResult } from "./auto-message.ts";
import { createAutoRenderer, waitWidget, type WaitLink, type WaitState } from "./auto-view.ts";
import { loadConfig } from "./config.ts";
import { AUTO_READ_MS, isConversation, type LinkReader } from "./reader.ts";
import type { LinkConfig } from "./types.ts";

/** The longest the model waits for the links of a message; a slower link is named, and its read goes on. */
export const WAIT_MS = 15_000;
/** The wait for a message with an X or Bluesky link: the conversation's read limit, and time for its first request. */
export const CONVERSATION_WAIT_MS = AUTO_READ_MS + 5_000;

/** How long the model waits for the links that a message reads. */
export function waitLimit(urls: readonly string[]): number {
	return urls.slice(0, MAX_LINKS).some(isConversation) ? CONVERSATION_WAIT_MS : WAIT_MS;
}
/** A read left running past the wait stops here, so a hung site holds nothing for long. */
export const BACKGROUND_MS = 5 * 60_000;
const USAGE = "Usage: /autopull on|off|status";
const STATUS_KEY = "pull-link-auto";
const STATUS_TEXT = "Pull Link: reading the links in your message…";

export interface AutoPullOptions {
	readonly reader: LinkReader;
	readonly config?: () => LinkConfig;
	readonly waitMs?: number;
	readonly backgroundMs?: number;
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The reads of one message: the message they make, and their state as they go, for the wait widget. */
interface Pending {
	readonly message: Promise<AutoMessage>;
	readonly wait: WaitState;
}

export function registerAutoPull(pi: ExtensionAPI, options: AutoPullOptions): void {
	const backgroundMs = options.backgroundMs ?? BACKGROUND_MS;
	// `/autopull` changes only this session, so it is not saved.
	let override: boolean | undefined;
	let session = new AbortController();
	// The message for the prompt that is about to start a run.
	let next: Pending | undefined;
	const enabled = () => override ?? (options.config ?? loadConfig)().autoPull;
	const motion = watchMotion(pi.events);

	const collect = (urls: readonly string[]): Pending => {
		const startedAt = Date.now();
		const waitMs = options.waitMs ?? waitLimit(urls);
		const signal = AbortSignal.any([session.signal, AbortSignal.timeout(backgroundMs)]);
		let states: readonly WaitLink[] = urls.slice(0, MAX_LINKS).map((url) => ({ url, state: "reading" }));
		const settle = (index: number, result: LinkResult) => {
			states = states.map((item, at) => (at === index ? { url: item.url, state: result.state, platform: "pulled" in result ? result.pulled.platform : undefined } : item));
			return result;
		};
		const reads = urls.slice(0, MAX_LINKS).map((url, index) => options.reader.readPlain(url, signal).then(
			(read): LinkResult => settle(index, { url, state: read.cached ? "cached" : "read", pulled: read.pulled }),
			(error: unknown): LinkResult => settle(index, { url, state: "failed", error: reason(error) }),
		));
		const build = async (): Promise<AutoMessage> => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), waitMs); });
			const settled = await Promise.all(reads.map((read) => Promise.race([read, late]))).finally(() => clearTimeout(timer));
			const results = settled.map((result, index): LinkResult => result ?? { url: urls[index], state: "reading" });
			// A pasted list can hold hundreds of links: a few are named, the rest only counted.
			const named = urls.slice(MAX_LINKS, MAX_LINKS + MAX_NAMED_SKIPPED).map((url): LinkResult => ({ url, state: "skipped" }));
			return autoMessage([...results, ...named], Math.max(0, urls.length - MAX_LINKS - MAX_NAMED_SKIPPED), Date.now() - startedAt);
		};
		return { message: build(), wait: { links: () => states, startedAt, limitMs: waitMs } };
	};

	/** Pi shows the user's message only when the run starts, so the wait says what it is for: a band in the TUI, a status elsewhere. */
	const showWait = (ctx: ExtensionContext, wait: WaitState): (() => void) => {
		if (ctx.hasUI && ctx.mode === "tui" && typeof ctx.ui.setWidget === "function") {
			ctx.ui.setWidget(STATUS_KEY, waitWidget(wait, motion));
			return () => ctx.ui.setWidget(STATUS_KEY, undefined);
		}
		ctx.ui.setStatus?.(STATUS_KEY, STATUS_TEXT);
		return () => ctx.ui.setStatus?.(STATUS_KEY, undefined);
	};

	/**
	 * A queued message gets no before_agent_start. Queued as a steer or follow-up too, the result would
	 * cost a turn of its own (Pi delivers queued messages one at a time by default). With triggerTurn
	 * false Pi adds it at the end of the current turn, which is before the user's message when the reads
	 * are done by then, and never starts a turn for it.
	 */
	const deliverLater = (message: Promise<AutoMessage>) => {
		const own = session.signal;
		message.then((built) => {
			// After shutdown the reads failed only because the session ended, and its API throws.
			if (own.aborted) return;
			try {
				pi.sendMessage(built, { triggerTurn: false });
			} catch {
				// The session went away between the check and the send; there is nothing to deliver to.
			}
		}).catch(() => undefined);
	};

	pi.on("input", (event, ctx) => {
		// A queued message never starts a run, so it must not take or drop the links of the prompt about to start one.
		if (!event.streamingBehavior) next = undefined;
		if (event.source === "extension" || isChildSession(ctx.sessionManager) || !enabled()) return;
		const urls = findLinks(event.text);
		if (!urls.length) return;
		const pending = collect(urls);
		if (event.streamingBehavior) {
			deliverLater(pending.message);
			return;
		}
		// A prompt that fails before its run (no model, no login) never awaits this.
		pending.message.catch(() => undefined);
		next = pending;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		// A run that a custom message starts leaves the user's links for the user's own run.
		if ((event as { messageType?: string }).messageType === "custom") return undefined;
		const pending = next;
		next = undefined;
		if (!pending) return undefined;
		const hide = showWait(ctx, pending.wait);
		try {
			return { message: await pending.message };
		} finally {
			hide();
		}
	});

	pi.on("session_shutdown", () => {
		session.abort(new Error("The session ended."));
		session = new AbortController();
		next = undefined;
		override = undefined;
	});

	if (typeof pi.registerMessageRenderer === "function") {
		pi.registerMessageRenderer(AUTO_TYPE, createAutoRenderer());
	}

	pi.registerCommand("autopull", {
		description: "Read the links in your messages before the model starts: on, off or status (this session only)",
		getArgumentCompletions: (prefix) => {
			const items = ["on", "off", "status"].filter((value) => value.startsWith(prefix.trim().toLowerCase())).map((value) => ({ value, label: value }));
			return items.length ? items : null;
		},
		handler: async (args, ctx: ExtensionContext) => {
			const word = args.trim().toLowerCase();
			if (word === "on" || word === "off") override = word === "on";
			else if (word !== "" && word !== "status") {
				ctx.ui.notify(USAGE, "warning");
				return;
			}
			const state = enabled() ? "on" : "off";
			const scope = override === undefined ? "from linkContext.autoPull" : "for this session";
			ctx.ui.notify(`Auto-pull is ${state} ${scope}.`, "info");
		},
	});
}
