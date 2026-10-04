/**
 * How the team's messages reach the main session.
 *
 * - A note, a question, or the answer to something main asked wakes main:
 *   read at its next turn boundary while it works, a new turn when it is
 *   idle (see `Route` below). Children send notes
 *   only when they would change what main is doing, so none may wait for a
 *   report. Notes landing together share the turn the first one started.
 * - What the user said to a child directly is recorded for main without
 *   waking it: the user is there and did it on purpose.
 * - Reports wake main too, batched: reports landing within `batchMs` of each
 *   other become one message and one turn. Children main started in the same
 *   turn form a group, and a report waits (up to `groupWaitMs`) for the rest
 *   of its group, so parallel work lands as one message. A child the user
 *   stopped doesn't wake it, nor does one from a run that began with main's
 *   question, answered it and did no more work. That report still shows its
 *   header, so the run's time, cost and tokens are on screen.
 *
 * Everything sent but not yet in the transcript is kept as pending, so the
 * widget can show it queued until Pi appends it.
 *
 * When main can take it decides how mail goes (`Route`). Mail never waits in
 * Pi's steering queue, which Esc clears to put the user's own queued text
 * back in the editor: while main works, a message lands at its next turn
 * boundary instead, and main is kept from settling until it has replied
 * after it (`owed`). While main is idle but compacting, mail waits, since a
 * turn started then would run on the context being summarized. A /compact
 * stops main's turn first, so mail that landed in it gets a reminder that
 * wakes main once the compaction is done (`remind`).
 */
import { noteText, questionText, reminderText, reportText } from "./format.ts";
import type { AgentRecord, MainDelivery } from "./types.ts";

export const MESSAGE_TYPE = "subagent-message";
export const REPORT_TYPE = "subagent-report";
/** How far back a reconcile looks; pending messages are always recent. */
export const RECONCILE_WINDOW = 200;
/** How often held mail checks whether main can take it, between the events that say so. */
const HOLD_RETRY_MS = 250;

/**
 * Where main is, for its mail: `wake` when idle (the mail starts a turn),
 * `queue` while it works (the mail lands at its next turn boundary), `hold`
 * while it is idle but compacting or summarizing a branch.
 */
export type Route = "wake" | "queue" | "hold";

/** Main's context as Pi sees it at a boundary: what is in it, and what lands next. */
export interface MainContext {
	readonly contextMessages: readonly unknown[];
	readonly pendingMessages: readonly unknown[];
}

export interface OutgoingMessage {
	customType: string;
	content: string;
	display: boolean;
	details: MailDetails;
}

export type MailDetails =
	| { id: string; kind: "note" | "question" | "reply"; from: string; text: string }
	| { id: string; kind: "relay"; from: string; to: string; text: string; answered: boolean }
	| { id: string; kind: "report"; reports: ReportSummary[] }
	| { id: string; kind: "reminder"; from: string };

export interface ReportSummary {
	name: string;
	model: string;
	state: AgentRecord["state"];
	startedAt?: number;
	endedAt?: number;
	cost: number;
	toolCalls: number;
	/** Prompt tokens (fresh and cached) and output; absent in sessions saved before it was recorded. */
	tokens?: { input: number; output: number };
	/** The run's answer already reached main as a reply. */
	answered?: true;
	report?: string;
	error?: string;
	/** Why it was stopped when no one asked: a run over its budget. */
	stopReason?: string;
	sessionFile?: string;
}

export interface MainPort {
	send(message: OutgoingMessage, options: { triggerTurn: boolean; deliverAs?: "steer" }): void;
}

export interface PendingItem {
	id: string;
	kind: MailDetails["kind"];
	from: string;
	text: string;
	at: number;
}

export function summarize(record: AgentRecord): ReportSummary {
	const { input, output, cacheRead, cacheWrite } = record.usage;
	const prompt = input + cacheRead + cacheWrite;
	return {
		name: record.name, model: record.model, state: record.state, cost: record.usage.cost, toolCalls: record.toolCalls,
		...(prompt + output > 0 ? { tokens: { input: prompt, output } } : {}),
		...(record.answeredMain ? { answered: true as const } : {}),
		...(record.startedAt !== undefined ? { startedAt: record.startedAt } : {}),
		...(record.endedAt !== undefined ? { endedAt: record.endedAt } : {}),
		...(record.report !== undefined ? { report: record.report } : {}),
		...(record.error !== undefined ? { error: record.error } : {}),
		...(record.stopReason !== undefined ? { stopReason: record.stopReason } : {}),
		...(record.sessionFile !== undefined ? { sessionFile: record.sessionFile } : {}),
	};
}

/** Who sent mail, as a reminder names them: the sender, or every agent whose report it carries. */
function ownerOf(details: MailDetails): string {
	return details.kind === "report" ? details.reports.map((report) => report.name).join(", ") : details.from;
}

/** An assistant message main finished, rather than one that was stopped or failed. */
function isReply(entry: unknown): boolean {
	const e = entry as { type?: string; message?: { role?: string; stopReason?: string } };
	return e.type === "message" && e.message?.role === "assistant" && e.message.stopReason !== "aborted" && e.message.stopReason !== "error";
}

/** The id of a subagent message or report, as Pi holds it; undefined for anything else. */
function mailId(message: unknown): string | undefined {
	const m = message as { role?: string; customType?: string; details?: { id?: unknown } } | undefined;
	const ours = m?.role === "custom" && (m.customType === MESSAGE_TYPE || m.customType === REPORT_TYPE);
	return ours && typeof m.details?.id === "string" ? m.details.id : undefined;
}

export function reportsText(records: readonly AgentRecord[], now: number): string {
	return records.map((record) => reportText(record, now)).join("\n\n---\n\n");
}

export class MainMail {
	private readonly pendingItems = new Map<string, PendingItem>();
	private batch: AgentRecord[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;
	private readonly held = new Map<string, { records: AgentRecord[]; timer: ReturnType<typeof setTimeout> }>();
	private seq = 0;
	private closed = false;
	/** Mail not yet handed to Pi, oldest first; it waits while main can't take it. */
	private outbox: Array<{ message: OutgoingMessage; wakes: boolean }> = [];
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	/** Mail that landed while main worked and that main has not replied after yet: id to who sent it. */
	private readonly owing = new Map<string, string>();
	private readonly route: () => Route;
	private readonly retryMs: number;
	private readonly port: MainPort;
	private readonly batchMs: number;
	private readonly groupWaitMs: number;
	private readonly groupBusy: (group: string, except: string) => boolean;
	private readonly now: () => number;
	private readonly onChange: () => void;

	constructor(options: {
		port: MainPort;
		batchMs: number;
		groupWaitMs?: number;
		/** Whether another member of the group is still working. */
		groupBusy?: (group: string, except: string) => boolean;
		now?: () => number;
		onChange?: () => void;
		/** Where main is now; without it, mail always goes as if main were idle. */
		route?: () => Route;
		retryMs?: number;
	}) {
		this.port = options.port;
		this.route = options.route ?? (() => "wake");
		this.retryMs = options.retryMs ?? HOLD_RETRY_MS;
		this.batchMs = options.batchMs;
		this.groupWaitMs = options.groupWaitMs ?? 0;
		this.groupBusy = options.groupBusy ?? (() => false);
		this.now = options.now ?? Date.now;
		this.onChange = options.onChange ?? (() => undefined);
	}

	deliver(delivery: MainDelivery): void {
		// Children stopped by a shutdown report into a session that is going away.
		if (this.closed) return;
		if (delivery.kind === "report") {
			const { record } = delivery;
			this.remember({ id: `pending-report-${record.name}`, kind: "report", from: record.name, text: "report", at: this.now() });
			const group = record.group;
			if (group && this.groupWaitMs > 0 && this.groupBusy(group, record.name)) {
				const held = this.held.get(group);
				if (held) held.records.push(record);
				else this.held.set(group, { records: [record], timer: setTimeout(() => this.release(group), this.groupWaitMs) });
				return;
			}
			if (group) this.release(group, false);
			this.batch.push(record);
			this.timer ??= setTimeout(() => this.flush(), this.batchMs);
			return;
		}
		const id = this.nextId();
		if (delivery.kind === "relay") {
			const said = delivery.answered ? `The user answered ${delivery.to}'s question directly:` : `The user messaged ${delivery.to} directly:`;
			this.remember({ id, kind: "relay", from: delivery.from, text: `to ${delivery.to}: ${delivery.text}`, at: this.now() });
			this.post({ customType: MESSAGE_TYPE, content: `${said}\n${delivery.text}`, display: true, details: { id, ...delivery } }, false);
			return;
		}
		const content = delivery.kind === "question" ? questionText(delivery.from, delivery.text) : delivery.kind === "reply"
			? `Answer from ${delivery.from}:\n${delivery.text}` : noteText(delivery.from, delivery.text);
		this.remember({ id, kind: delivery.kind, from: delivery.from, text: delivery.text, at: this.now() });
		this.post({ customType: MESSAGE_TYPE, content, display: true, details: { id, kind: delivery.kind, from: delivery.from, text: delivery.text } }, true);
	}

	/** Moves a group's held reports into the batch. */
	private release(group: string, schedule = true): void {
		const held = this.held.get(group);
		if (!held) return;
		clearTimeout(held.timer);
		this.held.delete(group);
		this.batch.push(...held.records);
		if (schedule) this.timer ??= setTimeout(() => this.flush(), this.batchMs);
	}

	/** Sends the batched reports now. */
	flush(): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		const records = this.batch;
		this.batch = [];
		if (records.length === 0) return;
		for (const record of records) this.pendingItems.delete(`pending-report-${record.name}`);
		const id = this.nextId();
		// A stop someone asked for is no news; a run stopped over its budget is.
		const wakes = records.some((record) => (record.state !== "stopped" || record.stopReason !== undefined) && !record.answeredMain);
		this.remember({ id, kind: "report", from: records.map((record) => record.name).join(", "), text: "report", at: this.now() });
		// Every report shows its header; one that only repeats an answer keeps its text folded.
		this.post({ customType: REPORT_TYPE, content: reportsText(records, this.now()), display: true, details: { id, kind: "report", reports: records.map(summarize) } }, wakes);
	}

	/** Whether mail that wakes main waits to be handed over. */
	waiting(): boolean {
		return this.outbox.some((item) => item.wakes);
	}

	/**
	 * Everything not yet handed to Pi, reports still batched or held included,
	 * taken out to be appended at a boundary instead (headless.ts). `wakes` says
	 * whether any of it asks main for a turn.
	 */
	takeAll(): { messages: OutgoingMessage[]; wakes: boolean } {
		for (const group of [...this.held.keys()]) this.release(group, false);
		this.flush();
		const taken = this.outbox.splice(0);
		return { messages: taken.map((item) => item.message), wakes: taken.some((item) => item.wakes) };
	}

	/** Hands Pi what waits, oldest first, for as long as main can take it. */
	retry(): void {
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = null;
		while (this.outbox.length > 0 && !this.closed) {
			const route = this.where();
			if (route === "hold") break;
			const { message, wakes } = this.outbox.shift()!;
			this.dispatch(message, wakes, route);
		}
		if (this.outbox.length > 0 && !this.closed) this.retryTimer = setTimeout(() => this.retry(), this.retryMs);
	}

	/**
	 * Whether main still owes a reply to mail that landed while it worked:
	 * some is still waiting to land, or landed after main's last reply. Main
	 * reads everything before its next reply, so one settles it; mail that is
	 * gone from the context (compacted away) is settled too, so it can't loop.
	 */
	owed(context: MainContext): boolean {
		if (this.owing.size === 0) return false;
		const waiting = new Set(context.pendingMessages.map(mailId));
		const lastReply = context.contextMessages.findLastIndex((message) => (message as { role?: string }).role === "assistant");
		const unread = new Set(context.contextMessages.slice(lastReply + 1).map(mailId));
		for (const id of [...this.owing.keys()]) if (!waiting.has(id) && !unread.has(id)) this.owing.delete(id);
		return this.owing.size > 0;
	}

	/**
	 * Drops owed mail main has replied after, read from the branch as a turn
	 * ends, so a reminder never names mail main already handled. A reply that
	 * was stopped or failed is no reply.
	 */
	answered(entries: readonly unknown[]): void {
		if (this.owing.size === 0) return;
		const recent = entries.slice(-RECONCILE_WINDOW);
		const lastReply = recent.findLastIndex(isReply);
		for (const entry of recent.slice(0, Math.max(0, lastReply))) {
			const e = entry as { type?: string; customType?: string; details?: unknown };
			if (e.type === "custom_message") {
				const id = mailId({ role: "custom", customType: e.customType, details: e.details });
				if (id) this.owing.delete(id);
			}
		}
	}

	/**
	 * Wakes main for mail it still owes a reply after a /compact stopped the
	 * turn the mail landed in; Pi doesn't continue a turn it stopped. Hidden,
	 * since the user already sees the mail it points at, so it is not kept as
	 * pending for the widget either, and sent once.
	 */
	remind(): void {
		if (this.owing.size === 0 || this.closed) return;
		const from = [...new Set(this.owing.values())].join(", ");
		this.owing.clear();
		this.post({ customType: MESSAGE_TYPE, content: reminderText(from), display: false, details: { id: this.nextId(), kind: "reminder", from } }, true);
	}

	/**
	 * Acknowledges every pending id found among recent transcript entries. Pi
	 * appends a message that doesn't wake it without telling extensions, so the
	 * transcript is the only witness.
	 */
	reconcile(entries: readonly unknown[]): void {
		if (this.pendingItems.size === 0) return;
		for (const entry of entries.slice(-RECONCILE_WINDOW)) {
			const e = entry as { type?: string; customType?: string; details?: { id?: unknown } };
			if (e.type === "custom_message" && (e.customType === MESSAGE_TYPE || e.customType === REPORT_TYPE) && typeof e.details?.id === "string") {
				this.acknowledge(e.details.id);
			}
		}
	}

	/** Pi appended the message with this id to the transcript. */
	acknowledge(id: string): void {
		if (this.pendingItems.delete(id)) this.onChange();
	}

	pending(): PendingItem[] {
		return [...this.pendingItems.values()];
	}

	dispose(): void {
		this.closed = true;
		if (this.retryTimer) clearTimeout(this.retryTimer);
		this.retryTimer = null;
		this.outbox = [];
		this.owing.clear();
		for (const held of this.held.values()) clearTimeout(held.timer);
		this.held.clear();
		if (this.timer) clearTimeout(this.timer);
		this.timer = null;
		this.batch = [];
		this.pendingItems.clear();
	}

	private remember(item: PendingItem): void {
		this.pendingItems.set(item.id, item);
		this.onChange();
	}

	/** Queues mail behind anything already waiting, so Pi is handed it in the order it came. */
	private post(message: OutgoingMessage, wakes: boolean): void {
		this.outbox.push({ message, wakes });
		this.retry();
	}

	private where(): Route {
		try {
			return this.route();
		} catch {
			// A stale context after session replacement, the one way asking fails; sending then fails the same way and leaves it pending.
			return "wake";
		}
	}

	private dispatch(message: OutgoingMessage, wakes: boolean, route: "wake" | "queue"): void {
		// Steered mail would sit in the queue Esc clears; mail sent without a turn lands at Pi's next turn boundary.
		const options = route === "wake" && wakes ? { triggerTurn: true, deliverAs: "steer" as const } : { triggerTurn: false };
		if (route === "queue" && wakes) this.owing.set(message.details.id, ownerOf(message.details));
		try {
			this.port.send(message, options);
		} catch {
			// A stale context after session replacement; the item stays visible as pending.
		}
	}

	private nextId(): string {
		return `sa-${this.now().toString(36)}-${(++this.seq).toString(36)}`;
	}
}
