/** Durable roster separate from Pi's transcript, which may not contain a spawn result yet. */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { nameFor } from "./names.ts";
import { isThinking } from "./models.ts";
import { LIVE_STATES, NO_USAGE, type AgentRecord } from "./types.ts";

const STATES = new Set([...LIVE_STATES, "idle", "failed", "stopped", "interrupted"]);

interface IndexData {
	version: 1;
	parentSession: string;
	cwd: string;
	records: AgentRecord[];
	shutdown?: string;
}

function validRecord(value: unknown): value is AgentRecord {
	if (!value || typeof value !== "object") return false;
	const r = value as AgentRecord;
	return typeof r.name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(r.name) && r.name !== "main"
		&& typeof r.parent === "string" && Number.isInteger(r.depth) && r.depth >= 1 && r.depth <= 4
		&& typeof r.task === "string" && typeof r.model === "string" && STATES.has(r.state)
		&& typeof r.readOnly === "boolean" && typeof r.fork === "boolean" && typeof r.blocking === "boolean"
		&& Number.isFinite(r.createdAt) && Number.isInteger(r.runs) && r.runs >= 0
		&& Number.isInteger(r.toolCalls) && r.toolCalls >= 0 && !!r.usage && Number.isFinite(r.usage.cost)
		&& (r.sessionFile === undefined || typeof r.sessionFile === "string")
		&& (r.thinking === undefined || isThinking(r.thinking));
}

export class ChildIndex {
	readonly file: string;
	private data: IndexData;

	readonly dir: string;
	readonly parentSession: string;

	constructor(dir: string, parentSession: string, cwd: string) {
		this.dir = dir;
		this.parentSession = parentSession;
		this.file = join(dir, "index.json");
		this.data = { version: 1, parentSession, cwd, records: [] };
	}

	load(): AgentRecord[] {
		if (!existsSync(this.file)) return [];
		const data = JSON.parse(readFileSync(this.file, "utf8")) as IndexData;
		if (data.parentSession !== this.parentSession) throw new Error("Child index belongs to another parent session.");
		if (data.version !== 1 || typeof data.cwd !== "string" || !Array.isArray(data.records) || !data.records.every(validRecord)
			|| new Set(data.records.map((r) => r.name)).size !== data.records.length) throw new Error("Invalid child index.");
		if (data.records.some((r) => r.sessionFile && dirname(resolve(r.sessionFile)) !== resolve(this.dir))) throw new Error("Invalid child session path.");
		this.data = data;
		return data.records.map((r) => ({ ...r, usage: { ...r.usage } }));
	}

	save(records: readonly AgentRecord[], shutdown?: string): void {
		const { shutdown: _previousShutdown, ...previous } = this.data;
		const data: IndexData = { ...previous, records: [...records], ...(shutdown ? { shutdown } : {}) };
		mkdirSync(this.dir, { recursive: true });
		const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temporary, `${JSON.stringify(data)}\n`, { mode: 0o600 });
			renameSync(temporary, this.file);
			this.data = data;
		} finally { rmSync(temporary, { force: true }); }
	}

	get shutdown(): string | undefined { return this.data.shutdown; }
	get cwd(): string { return this.data.cwd; }
}

/** Unindexed transcripts remain inspectable, even when the old parent never wrote a tool result. */
export function discoverOrphans(dir: string, known: readonly AgentRecord[], readBranch: (file: string) => readonly unknown[]): AgentRecord[] {
	if (!existsSync(dir)) return [];
	const paths = new Set(known.map((r) => r.sessionFile));
	const names = new Set(known.map((r) => r.name));
	return readdirSync(dir).filter((file) => file.endsWith(".jsonl") && !paths.has(join(dir, file))).sort().map((file) => {
		const sessionFile = join(dir, file);
		const entries = readBranch(sessionFile) as readonly any[];
		const messages = entries.filter((e) => e.type === "message").map((e) => e.message);
		const first = messages.find((m) => m.role === "user");
		const task = Array.isArray(first?.content) ? first.content.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n") : "Recovered child session";
		const modelChange = entries.slice().reverse().find((e) => e.type === "model_change");
		const assistant = messages.slice().reverse().find((m) => m.role === "assistant");
		const model = modelChange ? `${modelChange.provider}/${modelChange.modelId}` : assistant?.provider && assistant?.model ? `${assistant.provider}/${assistant.model}` : "unknown/unknown";
		const hint = file.match(/Z_(.+)_[a-f0-9-]+\.jsonl$/)?.[1] ?? file.replace(/\.jsonl$/, "");
		const name = nameFor(hint, task, (candidate) => names.has(candidate));
		names.add(name);
		return restoreRecord({ name, parent: "main", depth: 1, task, model, readOnly: true, fork: false, blocking: false,
			state: "idle", createdAt: Date.parse(entries[0]?.timestamp ?? "") || Date.now(), activity: "recovered from disk",
			toolCalls: 0, usage: NO_USAGE, runs: 1, sessionFile, orphaned: true }, entries);
	});
}

export function shouldResume(reason: string, policy: "reload" | "always" | "notify"): boolean {
	return policy === "always" || (policy === "reload" && reason === "reload");
}

export function restorationNotice(records: readonly AgentRecord[], resumed: boolean, reason: string): string {
	const line = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 300);
	const summary = records.map((r) => `${r.name}: task ${line(r.task)}; last activity ${line(r.activity ?? r.state)}`).join("\n");
	return `Subagents interrupted by ${reason}. ${resumed ? "Auto-resuming" : "Not resumed"}:\n${summary}\n`
		+ (resumed ? "Their last tool calls may not have completed. Each child will verify before continuing."
			: 'Resume with message({ to: "<name>", text: "Continue" }) or /subagents resume <name>. Do not wait for their reports until resumed.');
}

/** Pi's active branch, not abandoned tool calls, determines whether the last run finished. */
export function restoreRecord(record: AgentRecord, entries: readonly unknown[]): AgentRecord {
	const messages = entries.map((entry) => (entry as { message?: any }).message).filter(Boolean);
	const last = messages.at(-1);
	const assistant = messages.slice().reverse().find((message) => message.role === "assistant");
	const interrupted = LIVE_STATES.has(record.state) || record.state === "interrupted" || assistant?.stopReason === "aborted"
		|| (last && last.role !== "assistant") || assistant?.stopReason === "toolUse";
	const report = Array.isArray(assistant?.content) ? assistant.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") : record.report;
	return { ...record, restored: true, blocking: false, state: interrupted ? "interrupted" : record.state,
		...(report ? { report } : {}), ...(interrupted ? { endedAt: record.endedAt ?? Date.now() } : {}) };
}

/** Only the active parent branch can claim legacy children. Forks must not inherit them. */
export function legacyRecords(entries: readonly unknown[], dir: string, parent: string, depth: number): AgentRecord[] {
	const calls = new Map<string, Record<string, unknown>>();
	const records: AgentRecord[] = [];
	for (const raw of entries) {
		const entry = raw as { type?: string; timestamp?: string; message?: any };
		const message = entry.message;
		if (entry.type !== "message" || !message) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) if (part.type === "toolCall" && part.name === "subagent") calls.set(part.id, part.arguments ?? {});
		}
		if (message.role !== "toolResult" || message.toolName !== "subagent") continue;
		const args = calls.get(message.toolCallId);
		const details = message.details;
		if (!args || typeof args.task !== "string" || typeof details?.name !== "string" || typeof details.model !== "string"
			|| typeof details.sessionFile !== "string" || dirname(resolve(details.sessionFile)) !== resolve(dir)) continue;
		records.push({ name: details.name, parent, depth, model: details.model, task: args.task, readOnly: args.readOnly === true,
			fork: args.context === "fork", blocking: false, state: "idle", createdAt: Date.parse(entry.timestamp ?? "") || Date.now(),
			activity: null, runs: 1, toolCalls: 0, usage: NO_USAGE, sessionFile: details.sessionFile,
			...(isThinking(details.thinking) ? { thinking: details.thinking } : isThinking(args.thinking) ? { thinking: args.thinking } : {}),
		});
	}
	return records;
}
