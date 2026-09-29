/**
 * How the team's messages reach the main session.
 *
 * - A note never wakes main. It is appended after main's current turn, or at
 *   once when main is idle, and the model reads it on its next request.
 * - A question, or the answer to something main asked, wakes main: steered in
 *   while it works, a new turn when it is idle.
 * - Reports wake main too, batched: reports landing within `batchMs` of each
 *   other become one message and one turn. A child the user stopped doesn't
 *   wake it.
 *
 * Everything sent but not yet in the transcript is kept as pending, so the
 * widget can show it queued until Pi appends it.
 */
import { noteText, questionText, reportText } from "./format.ts";
import type { AgentRecord, MainDelivery } from "./types.ts";

export const MESSAGE_TYPE = "subagent-message";
export const REPORT_TYPE = "subagent-report";

export interface OutgoingMessage {
	customType: string;
	content: string;
	display: boolean;
	details: MailDetails;
}

export type MailDetails =
	| { id: string; kind: "note" | "question" | "reply"; from: string; text: string }
	| { id: string; kind: "report"; reports: ReportSummary[] };

export interface ReportSummary {
	name: string;
	model: string;
	state: AgentRecord["state"];
	startedAt?: number;
	endedAt?: number;
	cost: number;
	toolCalls: number;
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
	return {
		name: record.name, model: record.model, state: record.state, cost: record.usage.cost, toolCalls: record.toolCalls,
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
	private seq = 0;
	private readonly port: MainPort;
	private readonly batchMs: number;
	private readonly now: () => number;
	private readonly onChange: () => void;

	constructor(options: { port: MainPort; batchMs: number; now?: () => number; onChange?: () => void }) {
		this.port = options.port;
		this.batchMs = options.batchMs;
		this.now = options.now ?? Date.now;
		this.onChange = options.onChange ?? (() => undefined);
	}

	deliver(delivery: MainDelivery): void {
		if (delivery.kind === "report") {
			this.batch.push(delivery.record);
			this.timer ??= setTimeout(() => this.flush(), this.batchMs);
			this.remember({ id: `pending-report-${delivery.record.name}`, kind: "report", from: delivery.record.name, text: "report", at: this.now() });
			return;
		}
		const id = this.nextId();
		const content = delivery.kind === "question" ? questionText(delivery.from, delivery.text) : delivery.kind === "reply"
			? `Answer from ${delivery.from}:\n${delivery.text}` : noteText(delivery.from, delivery.text);
		this.remember({ id, kind: delivery.kind, from: delivery.from, text: delivery.text, at: this.now() });
		this.send({ customType: MESSAGE_TYPE, content, display: true, details: { id, kind: delivery.kind, from: delivery.from, text: delivery.text } },
			delivery.kind === "note" ? { triggerTurn: false } : { triggerTurn: true, deliverAs: "steer" });
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
		const wakes = records.some((record) => record.state !== "stopped");
		this.remember({ id, kind: "report", from: records.map((record) => record.name).join(", "), text: "report", at: this.now() });
		this.send({ customType: REPORT_TYPE, content: reportsText(records, this.now()), display: true, details: { id, kind: "report", reports: records.map(summarize) } },
			wakes ? { triggerTurn: true, deliverAs: "steer" } : { triggerTurn: false });
	}

	/** Pi appended the message with this id to the transcript. */
	acknowledge(id: string): void {
		if (this.pendingItems.delete(id)) this.onChange();
	}

	pending(): PendingItem[] {
		return [...this.pendingItems.values()];
	}

	dispose(): void {
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
