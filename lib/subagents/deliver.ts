/**
 * How the team's messages reach the main session.
 *
 * - A note, a question, or the answer to something main asked wakes main:
 *   steered in while it works, a new turn when it is idle. Children send notes
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
 *   band, so the run's time, cost and tokens are on screen.
 *
 * Everything sent but not yet in the transcript is kept as pending, so the
 * widget can show it queued until Pi appends it.
 */
import { noteText, questionText, reportText } from "./format.ts";
import type { AgentRecord, MainDelivery } from "./types.ts";

export const MESSAGE_TYPE = "subagent-message";
export const REPORT_TYPE = "subagent-report";
/** How far back a reconcile looks; pending messages are always recent. */
export const RECONCILE_WINDOW = 200;

export interface OutgoingMessage {
	customType: string;
	content: string;
	display: boolean;
	details: MailDetails;
}

export type MailDetails =
	| { id: string; kind: "note" | "question" | "reply"; from: string; text: string }
	| { id: string; kind: "relay"; from: string; to: string; text: string; answered: boolean }
	| { id: string; kind: "report"; reports: ReportSummary[] };

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
		...(record.sessionFile !== undefined ? { sessionFile: record.sessionFile } : {}),
	};
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
	}) {
		this.port = options.port;
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
			this.send({ customType: MESSAGE_TYPE, content: `${said}\n${delivery.text}`, display: true, details: { id, ...delivery } }, { triggerTurn: false });
			return;
		}
		const content = delivery.kind === "question" ? questionText(delivery.from, delivery.text) : delivery.kind === "reply"
			? `Answer from ${delivery.from}:\n${delivery.text}` : noteText(delivery.from, delivery.text);
		this.remember({ id, kind: delivery.kind, from: delivery.from, text: delivery.text, at: this.now() });
		this.send({ customType: MESSAGE_TYPE, content, display: true, details: { id, kind: delivery.kind, from: delivery.from, text: delivery.text } },
			{ triggerTurn: true, deliverAs: "steer" });
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
		const wakes = records.some((record) => record.state !== "stopped" && !record.answeredMain);
		this.remember({ id, kind: "report", from: records.map((record) => record.name).join(", "), text: "report", at: this.now() });
		// Every report shows its band; one that only repeats an answer keeps its text folded.
		this.send({ customType: REPORT_TYPE, content: reportsText(records, this.now()), display: true, details: { id, kind: "report", reports: records.map(summarize) } },
			wakes ? { triggerTurn: true, deliverAs: "steer" } : { triggerTurn: false });
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

	private send(message: OutgoingMessage, options: { triggerTurn: boolean; deliverAs?: "steer" }): void {
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
