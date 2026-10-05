/** Durable roster separate from Pi's transcript, which may not contain a spawn result yet. */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, openSync, fsyncSync, closeSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { isReserved, nameFor } from "./names.ts";
import { isThinking } from "./models.ts";
import { latestReportFile, reportFilePath } from "./reports.ts";
import { LIVE_STATES, NO_USAGE, type AgentRecord } from "./types.ts";
import { validWorktree } from "./worktree.ts";

const STATES = new Set([...LIVE_STATES, "idle", "failed", "stopped", "interrupted"]);
const DIRECTORY_WARNING_LIMIT = 64;
const warnedDirectories = new Set<string>();

function directoryWarning(dir: string, error: unknown, warn: (message: string) => void): void {
	if (warnedDirectories.has(dir)) return;
	warnedDirectories.add(dir);
	if (warnedDirectories.size > DIRECTORY_WARNING_LIMIT) warnedDirectories.delete(warnedDirectories.values().next().value!);
	warn(`subagents: could not inspect ${dir}: ${(error as Error).message}. Using saved child records and run counts.`);
}

function directoryFiles(dir: string, warn: (message: string) => void): string[] {
	try { return readdirSync(dir); }
	catch (error) { directoryWarning(dir, error, warn); return []; }
}

interface Part { type?: string; text?: string; id?: string; name?: string; arguments?: Record<string, unknown> }
interface Message {
	role?: string; stopReason?: string; content?: string | Part[]; provider?: string; model?: string;
	toolCallId?: string; toolName?: string; details?: Record<string, unknown>;
}
interface Entry { type?: string; timestamp?: string; provider?: string; modelId?: string; message?: Message }

const textContent = (content: Message["content"]): string => typeof content === "string" ? content
	: Array.isArray(content) ? content.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n") : "";

interface IndexData {
	version: 1;
	parentSession: string;
	cwd: string;
	records: AgentRecord[];
	shutdown?: string;
	shutdownOwner?: string;
	workspaceNotice?: string;
}

const strings = (value: unknown): boolean => value === undefined || (Array.isArray(value) && value.every((item) => typeof item === "string"));

function validRecord(value: unknown): value is AgentRecord {
	if (!value || typeof value !== "object") return false;
	const r = value as AgentRecord;
	return typeof r.name === "string" && /^[a-z0-9][a-z0-9-]*$/.test(r.name) && !isReserved(r.name)
		&& typeof r.parent === "string" && Number.isInteger(r.depth) && r.depth >= 1 && r.depth <= 4
		&& typeof r.task === "string" && typeof r.model === "string" && STATES.has(r.state)
		&& (r.activity === null || typeof r.activity === "string")
		&& typeof r.readOnly === "boolean" && typeof r.fork === "boolean" && typeof r.blocking === "boolean"
		&& Number.isFinite(r.createdAt) && Number.isInteger(r.runs) && r.runs >= 0
		&& Number.isInteger(r.toolCalls) && r.toolCalls >= 0 && !!r.usage
		&& [r.usage.input, r.usage.output, r.usage.cacheRead, r.usage.cacheWrite, r.usage.cost].every((value) => Number.isFinite(value) && value >= 0)
		&& (r.startedAt === undefined || Number.isFinite(r.startedAt)) && (r.endedAt === undefined || Number.isFinite(r.endedAt))
		&& (r.sessionFile === undefined || typeof r.sessionFile === "string")
		&& (r.worktree === undefined || validWorktree(r.worktree))
		&& (r.worktreeReport === undefined || typeof r.worktreeReport === "string")
		&& (r.thinking === undefined || isThinking(r.thinking))
		&& (r.interruptedBy === undefined || ["reload", "signal", "quit"].includes(r.interruptedBy))
		&& (r.interruptionId === undefined || typeof r.interruptionId === "string")
		&& (r.interruptedOwner === undefined || typeof r.interruptedOwner === "string")
		&& (r.interruptionAnnounced === undefined || typeof r.interruptionAnnounced === "boolean")
		&& (r.autoResumeAttempts === undefined || (Number.isInteger(r.autoResumeAttempts) && r.autoResumeAttempts >= 0))
		&& (r.lastActivityAt === undefined || Number.isFinite(r.lastActivityAt))
		&& (r.restoreError === undefined || typeof r.restoreError === "string")
		&& (r.launchFailures === undefined || (Number.isInteger(r.launchFailures) && r.launchFailures >= 0))
		&& (r.launchError === undefined || typeof r.launchError === "string")
		&& [r.maxMinutes, r.maxCost].every((limit) => limit === undefined || (typeof limit === "number" && Number.isFinite(limit) && limit > 0))
		&& (r.stopReason === undefined || typeof r.stopReason === "string")
		&& strings(r.inbox) && strings(r.owed) && strings(r.unread) && strings(r.tools);
}

export class ChildIndex {
	readonly file: string;
	private data: IndexData;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private lastWrite = 0;
	private signature = "";

	readonly dir: string;
	readonly parentSession: string;

	constructor(dir: string, parentSession: string, cwd: string) {
		this.dir = dir;
		this.parentSession = parentSession;
		this.file = join(dir, "index.json");
		this.data = { version: 1, parentSession, cwd, records: [] };
	}

	load(warn: (message: string) => void): AgentRecord[] {
		if (existsSync(this.dir)) for (const file of directoryFiles(this.dir, warn)) {
			if (file.startsWith("index.json.") && file.endsWith(".tmp")) rmSync(join(this.dir, file), { force: true });
		}
		if (!existsSync(this.file)) return [];
		const data = JSON.parse(readFileSync(this.file, "utf8")) as IndexData;
		if (data.parentSession !== this.parentSession) throw new Error("Child index belongs to another parent session.");
		if (data.version !== 1 || typeof data.cwd !== "string" || !Array.isArray(data.records) || !data.records.every(validRecord)
			|| new Set(data.records.map((r) => r.name)).size !== data.records.length) throw new Error("Invalid child index.");
		const byName = new Map(data.records.map((r) => [r.name, r]));
		if (data.records.some((r) => r.parent === "main" ? r.depth !== 1 : byName.get(r.parent)?.depth !== r.depth - 1)) throw new Error("Invalid child parent or depth.");
		if (data.records.some((r) => r.sessionFile && dirname(resolve(r.sessionFile)) !== resolve(this.dir))) throw new Error("Invalid child session path.");
		this.data = data;
		return data.records.map((r) => ({ ...r, usage: { ...r.usage } }));
	}

	update(records: readonly AgentRecord[], onError: (error: unknown) => void): void {
		const signature = this.stateSignature(records);
		if (signature !== this.signature || Date.now() - this.lastWrite >= 5_000) return this.save(records);
		if (this.timer) clearTimeout(this.timer);
		this.timer = setTimeout(() => { try { this.save(records); } catch (error) { onError(error); } }, 5_000 - (Date.now() - this.lastWrite));
		this.timer.unref?.();
	}

	private stateSignature(records: readonly AgentRecord[]): string {
		return JSON.stringify(records.map(({ activity: _activity, lastActivityAt: _at, toolCalls: _calls, usage: _usage, contextTokens: _tokens, contextWindow: _window, ...state }) => state));
	}

	save(records: readonly AgentRecord[], shutdown?: string, shutdownOwner?: string): void {
		if (this.timer) clearTimeout(this.timer);
		this.timer = undefined;
		const { shutdown: _previousShutdown, shutdownOwner: _previousOwner, ...previous } = this.data;
		const data: IndexData = { ...previous, records: records.map((record) => {
			const { reportFile: _reportFile, ...durable } = record as AgentRecord & { reportFile?: string };
			return durable;
		}), ...(shutdown ? { shutdown, shutdownOwner } : {}) };
		mkdirSync(this.dir, { recursive: true });
		const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
		try {
			const fd = openSync(temporary, "wx", 0o600);
			try { writeFileSync(fd, `${JSON.stringify(data)}\n`); fsyncSync(fd); }
			finally { closeSync(fd); }
			renameSync(temporary, this.file);
			this.data = data;
			this.signature = this.stateSignature(records);
			this.lastWrite = Date.now();
		} finally { rmSync(temporary, { force: true }); }
	}

	markWorkspaceNotice(cwd: string): boolean {
		if (this.data.workspaceNotice === cwd) return false;
		this.data = { ...this.data, workspaceNotice: cwd };
		return true;
	}
	get shutdown(): string | undefined { return this.data.shutdown; }
	get shutdownOwner(): string | undefined { return this.data.shutdownOwner; }
	get cwd(): string { return this.data.cwd; }
}

/** Reports are immutable per run. Old indexes must not reuse an already-written run number. */
export function reportRunFloor(sessionFile: string | undefined, runs: number, warn: (message: string) => void, latest = latestReportFile): number {
	if (!sessionFile || !existsSync(dirname(sessionFile))) return runs;
	try {
		const file = latest(sessionFile);
		const match = file?.match(/\.run-(\d+)\.report\.md$/);
		const run = match ? Number(match[1]) : 0;
		return file && Number.isSafeInteger(run) && run >= 1 && resolve(file) === resolve(reportFilePath(sessionFile, run)) ? Math.max(runs, run) : runs;
	} catch (error) { directoryWarning(dirname(sessionFile), error, warn); return runs; }
}

/** A team's descendants share one root directory, but retain their immediate parent names. */
export function recoverRoster(known: readonly AgentRecord[], dir: string, readBranch: (file: string) => readonly unknown[], warn: (message: string) => void): AgentRecord[] {
	const records = new Map(known.map((record) => [record.name, record]));
	const processed = new Set<string>();
	for (const record of records.values()) {
		if (!record.sessionFile || !existsSync(record.sessionFile)) {
			records.set(record.name, restoreRecord(record, [], warn));
			continue;
		}
		if (processed.has(record.sessionFile)) continue;
		processed.add(record.sessionFile);
		let entries: readonly unknown[];
		try { entries = readBranch(record.sessionFile); }
		catch (error) { records.set(record.name, { ...restoreRecord(record, [], warn), restoreError: (error as Error).message }); continue; }
		records.set(record.name, restoreRecord({ ...record, restoreError: undefined }, entries, warn));
		if (record.depth >= 4) continue;
		for (const child of legacyRecords(entries, dir, record.name, record.depth + 1, readBranch, warn)) {
			if (!records.has(child.name)) records.set(child.name, child);
		}
	}
	const restored = [...records.values()].map((record) => ({ ...record, restored: true, runs: reportRunFloor(record.sessionFile, record.runs, warn) }));
	return [...restored, ...discoverOrphans(dir, restored, readBranch, warn)];
}

/** Unindexed transcripts remain inspectable, even when the old parent never wrote a tool result. */
export function discoverOrphans(dir: string, known: readonly AgentRecord[], readBranch: (file: string) => readonly unknown[], warn: (message: string) => void): AgentRecord[] {
	if (!existsSync(dir)) return [];
	const paths = new Set(known.map((r) => r.sessionFile));
	const names = new Set(known.map((r) => r.name));
	return directoryFiles(dir, warn).filter((file) => file.endsWith(".jsonl") && !paths.has(join(dir, file))).sort().flatMap((file) => {
		const sessionFile = join(dir, file);
		let entries: readonly Entry[];
		try { entries = readBranch(sessionFile) as readonly Entry[]; }
		catch { return []; }
		const messages = entries.flatMap((e) => e.type === "message" && e.message ? [e.message] : []);
		const first = messages.find((m) => m.role === "user");
		const task = textContent(first?.content) || "Recovered child session";
		const modelChange = entries.slice().reverse().find((e) => e.type === "model_change");
		const assistant = messages.slice().reverse().find((m) => m.role === "assistant");
		const model = modelChange ? `${modelChange.provider}/${modelChange.modelId}` : assistant?.provider && assistant?.model ? `${assistant.provider}/${assistant.model}` : "unknown/unknown";
		const hint = file.match(/Z_(.+)_[a-f0-9-]+\.jsonl$/)?.[1] ?? file.replace(/\.jsonl$/, "");
		const name = nameFor(hint, task, (candidate) => names.has(candidate));
		names.add(name);
		return restoreRecord({ name, parent: "main", depth: 1, task, model, readOnly: true, fork: false, blocking: false,
			state: "idle", createdAt: Date.parse(entries[0]?.timestamp ?? "") || Date.now(), activity: "recovered from disk",
			toolCalls: 0, usage: NO_USAGE, runs: 1, sessionFile, orphaned: true }, entries, warn);
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
export function restoreRecord(record: AgentRecord, entries: readonly unknown[], warn: (message: string) => void): AgentRecord {
	const messages = entries.flatMap((entry) => (entry as Entry).message ? [(entry as Entry).message!] : []);
	const last = messages.at(-1);
	const assistant = messages.slice().reverse().find((message) => message.role === "assistant");
	const pending = new Set<string | undefined>();
	for (const message of messages) {
		if (message.role === "user") pending.clear();
		if (message.role === "assistant" && Array.isArray(message.content)) for (const part of message.content) if (part?.type === "toolCall") pending.add(part.id);
		if (message.role === "toolResult") pending.delete(message.toolCallId);
	}
	const interrupted = record.state !== "stopped" && record.state !== "failed" && (pending.size > 0 || LIVE_STATES.has(record.state) || record.state === "interrupted" || assistant?.stopReason === "aborted"
		|| (last && last.role !== "assistant") || assistant?.stopReason === "toolUse");
	const report = textContent(assistant?.content) || record.report;
	const hardKill = LIVE_STATES.has(record.state);
	const at = [...entries].reverse().map((entry) => Date.parse((entry as Entry).timestamp ?? "")).find(Number.isFinite);
	return { ...record, restored: true, blocking: false, state: interrupted ? "interrupted" : record.state, runs: reportRunFloor(record.sessionFile, record.runs, warn),
		...(report ? { report } : {}), ...(interrupted ? { endedAt: record.endedAt ?? at ?? record.lastActivityAt ?? record.startedAt ?? record.createdAt } : {}),
		...(hardKill && record.autoResumeAttempts !== undefined ? { interruptedBy: "signal", interruptionId: randomUUID(), interruptionAnnounced: false } as const : {}) };
}

/** Only the active parent branch can claim legacy children. Forks must not inherit them. */
export function legacyRecords(entries: readonly unknown[], dir: string, parent: string, depth: number, readBranch: ((file: string) => readonly unknown[]) | undefined, warn: (message: string) => void): AgentRecord[] {
	const calls = new Map<string, Record<string, unknown>>();
	const records: AgentRecord[] = [];
	for (const raw of entries) {
		const entry = raw as Entry;
		const message = entry.message;
		if (entry.type !== "message" || !message) continue;
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) if (part?.type === "toolCall" && part.name === "subagent" && typeof part.id === "string") calls.set(part.id, part.arguments ?? {});
		}
		if (message.role !== "toolResult" || message.toolName !== "subagent" || typeof message.toolCallId !== "string") continue;
		const args = calls.get(message.toolCallId);
		const details = message.details;
		if (!args || typeof args.task !== "string" || typeof details?.name !== "string" || typeof details.model !== "string"
			|| typeof details.sessionFile !== "string" || dirname(resolve(details.sessionFile)) !== resolve(dir)) continue;
		records.push({ name: details.name, parent, depth, model: details.model, task: args.task, readOnly: args.readOnly === true,
			fork: args.context === "fork", blocking: false, state: "idle", createdAt: Date.parse(entry.timestamp ?? "") || Date.now(),
			activity: null, runs: 1, toolCalls: 0, usage: NO_USAGE, sessionFile: details.sessionFile,
			...(validWorktree(details.worktree) ? { worktree: { ...details.worktree } } : {}),
			...(isThinking(details.thinking) ? { thinking: details.thinking } : isThinking(args.thinking) ? { thinking: args.thinking } : {}),
		});
		calls.delete(message.toolCallId);
	}
	if (readBranch && calls.size > 0) for (const orphan of discoverOrphans(dir, records, readBranch, warn)) {
		const matches = [...calls.values()].filter((call) => typeof call.task === "string" && (orphan.task === call.task.trim() || orphan.task.startsWith(`${call.task.trim()}\n\n`)));
		if (matches.length !== 1) continue;
		const args = matches[0]!;
		records.push({ ...orphan, parent, depth, task: (args.task as string).trim(), readOnly: args.readOnly === true, fork: args.context === "fork", orphaned: false,
			...(isThinking(args.thinking) ? { thinking: args.thinking } : {}) });
	}
	return records;
}
