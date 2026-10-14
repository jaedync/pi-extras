/**
 * Auto-pull: when the user sends a message with links, Pull Link reads them
 * before the model starts and adds them to the session as one custom message,
 * so the model needs no pull_link call (and no extra turn) for them. Only what
 * a person types or sends over RPC counts: not extension messages, not a
 * subagent's task.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { isChildSession } from "../child-session.ts";
import { AUTO_TYPE, autoMessage, autoRow, findLinks, MAX_LINKS, type AutoMessage, type LinkResult } from "./auto-message.ts";
import { loadConfig } from "./config.ts";
import type { LinkReader } from "./reader.ts";
import type { LinkConfig } from "./types.ts";

/** The longest the model waits for the links of a message; a slower link is named, and its read goes on. */
export const WAIT_MS = 15_000;
/** A read left running past the wait stops here, so a hung site holds nothing for long. */
export const BACKGROUND_MS = 5 * 60_000;
const USAGE = "Usage: /autopull on|off|status";

export interface AutoPullOptions {
	readonly reader: LinkReader;
	readonly config?: () => LinkConfig;
	readonly waitMs?: number;
	readonly backgroundMs?: number;
}

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function registerAutoPull(pi: ExtensionAPI, options: AutoPullOptions): void {
	const waitMs = options.waitMs ?? WAIT_MS;
	const backgroundMs = options.backgroundMs ?? BACKGROUND_MS;
	// `/autopull` changes only this session, so it is not saved.
	let override: boolean | undefined;
	let session = new AbortController();
	// The message for the prompt that is about to start a run.
	let next: Promise<AutoMessage> | undefined;
	const enabled = () => override ?? (options.config ?? loadConfig)().autoPull;

	const collect = async (urls: readonly string[]): Promise<AutoMessage> => {
		const signal = AbortSignal.any([session.signal, AbortSignal.timeout(backgroundMs)]);
		const reads = urls.slice(0, MAX_LINKS).map((url) => options.reader.readPlain(url, signal).then(
			(read): LinkResult => ({ url, state: read.cached ? "cached" : "read", pulled: read.pulled }),
			(error: unknown): LinkResult => ({ url, state: "failed", error: reason(error) }),
		));
		let timer: ReturnType<typeof setTimeout> | undefined;
		const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), waitMs); });
		const settled = await Promise.all(reads.map((read) => Promise.race([read, late]))).finally(() => clearTimeout(timer));
		const results = settled.map((result, index): LinkResult => result ?? { url: urls[index], state: "reading" });
		return autoMessage([...results, ...urls.slice(MAX_LINKS).map((url): LinkResult => ({ url, state: "skipped" }))]);
	};

	pi.on("input", (event, ctx) => {
		next = undefined;
		if (event.source === "extension" || isChildSession(ctx.sessionManager) || !enabled()) return;
		const urls = findLinks(event.text);
		if (!urls.length) return;
		const message = collect(urls);
		if (!event.streamingBehavior) {
			next = message;
			return;
		}
		// A queued message gets no before_agent_start. Queued as a steer or follow-up too, the result would
		// cost a turn of its own (Pi delivers queued messages one at a time by default). With triggerTurn
		// false Pi adds it at the end of the current turn, which is before the user's message when the reads
		// are done by then, and never starts a turn for it.
		void message.then((built) => pi.sendMessage(built, { triggerTurn: false }), (error: unknown) => ctx.ui.notify(`Auto-pull failed: ${reason(error)}`, "warning"));
	});

	pi.on("before_agent_start", async (event) => {
		// A run that a custom message starts leaves the user's links for the user's own run.
		if ((event as { messageType?: string }).messageType === "custom") return undefined;
		const pending = next;
		next = undefined;
		return pending ? { message: await pending } : undefined;
	});

	pi.on("session_shutdown", () => {
		session.abort(new Error("The session ended."));
		session = new AbortController();
		next = undefined;
		override = undefined;
	});

	if (typeof pi.registerMessageRenderer === "function") {
		pi.registerMessageRenderer(AUTO_TYPE, (message, renderOptions, theme) => {
			const row = autoRow(message.details, theme, renderOptions.expanded);
			return row ? new Text(row, 0, 0) : undefined;
		});
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
