/** Recover only children linked by subagent protocol evidence, never session-wide
 * UUID/prose searches. Results, workflow inventory and notifications are aliases
 * for the same run/index; native sessions take precedence over artifact copies. */
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { evidenceFiles, evidenceJson, evidenceLines } from "./status-plus-evidence.ts";
import type { BranchEntry } from "./status-plus-transcript.ts";

type RecordValue = Record<string, any>;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const validRun = (value: unknown): value is string => typeof value === "string" && new RegExp(`^${UUID}$`, "i").test(value);
const object = (value: unknown): RecordValue | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
const containers = ["results", "children", "childRuns", "childOutputs", "workflowChildren", "steps", "runs", "result", "workflow", "implementation", "reviews"];

export interface ChildEvidence {
	key: string;
	runId?: string;
	index: number;
	workflowAlias?: string;
	inline?: RecordValue;
	meta?: RecordValue;
	metadataPaths: Set<string>;
	sessionFiles: Set<string>;
	transcriptPaths: Set<string>;
	entries: BranchEntry[];
}

/** Normalize native session and normalized artifact messages without treating
 * synthetic initial_prompt + message_end or tool_start as extra requests. */
function transcriptEntries(lines: unknown[], hasNativePrompt = false): BranchEntry[] {
	const records = lines.map(object).filter((r): r is RecordValue => !!r);
	const hasUserEnd = records.some(r => r.recordType === "message" && r.sourceEventType !== "initial_prompt" && r.message?.role === "user");
	const header = records.find(r => r.type === "session");
	// Pi forkFrom/createBranchedSession stamp a new header but retain copied row
	// timestamps. Exclude that history, including old child-discovery results.
	const forkedAt = header?.parentSession ? Date.parse(header.timestamp) : NaN;
	return records.flatMap(record => {
		if (Number.isFinite(forkedAt) && Date.parse(record.timestamp) < forkedAt) return [];
		if (record.recordType) {
			if (record.recordType !== "message" || !object(record.message)) return [];
			if (record.sourceEventType === "initial_prompt" && (hasUserEnd || hasNativePrompt)) return [];
			return [{ type: "message", timestamp: record.timestamp, message: record.message } as BranchEntry];
		}
		return record.type ? [record as BranchEntry] : [];
	});
}

export class ChildEvidenceCollector {
	private readonly children = new Map<string, ChildEvidence>();
	private readonly runs = new Set<string>();
	private readonly workflowAliases = new Map<string, string>();
	private readonly roots = new Set<string>();
	private readonly artifactDirs = new Set<string>();
	private readonly asyncDirs = new Set<string>();
	private readonly visited = new Set<string>();
	private readonly expanded = new Set<string>();
	private budget = 512;
	private readonly ioBudget = { bytes: 64 * 1024 * 1024 };

	constructor(sessionDir: string, sessionFile?: string) {
		this.artifactDirs.add(join(sessionDir, "subagent-artifacts"));
		if (sessionFile) this.roots.add(sessionFile.replace(/\.jsonl$/, ""));
	}

	private path(value: unknown): string | undefined {
		// Recorded paths are absolute in Pi; don't resolve relative paths against
		// the footer's cwd (which may be unrelated after resume).
		return typeof value === "string" && isAbsolute(value) ? resolve(value) : undefined;
	}

	private child(key: string, runId?: string, index = 0): ChildEvidence {
		let child = this.children.get(key);
		if (!child) {
			child = { key, runId, index, metadataPaths: new Set(), sessionFiles: new Set(), transcriptPaths: new Set(), entries: [] };
			this.children.set(key, child);
		}
		return child;
	}

	scanDetails(value: unknown, identity: string, inheritedRun?: string, depth = 0): void {
		if (depth > 12) return;
		if (Array.isArray(value)) {
			value.forEach((item, index) => this.scanDetails(item, `${identity}:${index}`, inheritedRun, depth + 1));
			return;
		}
		const record = object(value);
		if (!record) return;
		const metadataPath = this.path(record.artifactPaths?.metadataPath);
		const filename = metadataPath && basename(metadataPath).match(new RegExp(`^(${UUID})_.*?(?:_(\\d+))?_meta\\.json$`, "i"));
		const runId = validRun(record.runId) ? record.runId.toLowerCase() : filename ? filename[1].toLowerCase() : inheritedRun;
		if (runId) this.runs.add(runId);
		const workflowRun = validRun(record.workflowRunId) ? record.workflowRunId : runId;
		if (workflowRun && Array.isArray(record.children)) {
			for (const child of record.children) {
				const key = child?.childId ?? child?.workflowKey ?? child?.key;
				if (typeof key === "string" && validRun(child?.runId)) this.workflowAliases.set(`${workflowRun}:${key}`, child.runId.toLowerCase());
			}
		}
		const asyncDir = this.path(record.asyncDir);
		if (asyncDir) this.asyncDirs.add(asyncDir);
		const sessionFile = this.path(record.sessionFile);
		const transcriptPath = this.path(record.transcriptPath ?? record.artifactPaths?.transcriptPath);
		const index = typeof record.index === "number" ? record.index : typeof record.childIndex === "number" ? record.childIndex : filename?.[2] ? Number(filename[2]) : typeof record.step === "number" ? record.step : 0;
		if (record.agent && (record.usage || record.messages || sessionFile || transcriptPath || metadataPath) || sessionFile || transcriptPath) {
			const workflowAlias = runId && typeof record.workflowKey === "string" && !filename && !record.runId ? `${runId}:${record.workflowKey}` : undefined;
			const child = this.child(workflowAlias ? `workflow:${workflowAlias}:${index}` : runId ? `${runId}:${index}` : metadataPath ?? sessionFile ?? identity, runId, index);
			if (workflowAlias) child.workflowAlias = workflowAlias;
			if (record.usage || record.messages) child.inline = record;
			if (metadataPath) child.metadataPaths.add(metadataPath);
			if (sessionFile) child.sessionFiles.add(sessionFile);
			if (transcriptPath) child.transcriptPaths.add(transcriptPath);
		}
		for (const key of containers) if (record[key]) this.scanDetails(record[key], `${identity}:${key}`, runId, depth + 1);
	}

	private scanReturn(value: unknown, identity: string, depth = 0): void {
		if (depth > 12 || !value || typeof value !== "object") return;
		const record = object(value);
		if (record && validRun(record.runId)) this.scanDetails(record, identity);
		for (const [key, item] of Object.entries(value)) {
			if (["output", "finalOutput", "content", "messages", "task"].includes(key)) continue;
			this.scanReturn(item, `${identity}:${key}`, depth + 1);
		}
	}

	scanBranch(entries: BranchEntry[], origin: string): void {
		entries.forEach((entry, index) => {
			const message = entry.message as RecordValue | undefined;
			if (entry.type === "message" && message?.role === "toolResult" && ["subagent", "subagent_wait", "subagent_status", "subagent_result"].includes(message.toolName)) {
				this.scanDetails(message.details, `${origin}:${message.toolCallId ?? entry.id ?? index}`);
			}
			if (entry.type === "custom_message" && entry.customType === "subagent-notify") {
				this.scanDetails(entry.details, `${origin}:notify:${index}`);
				const text = typeof entry.content === "string" ? entry.content : Array.isArray(entry.content) ? entry.content.map((b: any) => b.text ?? "").join("\n") : "";
				// Workflow Return is machine JSON, but output strings inside it are prose.
				const returned = text.indexOf("Return: ");
				if (returned >= 0) {
					try { this.scanReturn(JSON.parse(text.slice(returned + 8)), `${origin}:return:${index}`); } catch { /* truncated notification */ }
				}
				const header = returned >= 0 ? text.slice(0, returned) : text;
				for (const line of header.split("\n")) {
					const run = line.match(new RegExp(`^(?:run[: ]+|Workflow run: |Reconciled detached child: )(${UUID})(?: finished)?$`, "i"));
					if (run) this.runs.add(run[1].toLowerCase());
					if (line.startsWith("Child runs: ")) {
						for (const part of line.slice(12).split(", ")) {
							const child = part.match(new RegExp(`^(?:[^=]+=)?(${UUID})(?: \\([^)]*\\))?$`, "i"));
							if (child) this.runs.add(child[1].toLowerCase());
						}
					}
					if (line.startsWith("Session file: ") && line.endsWith(".jsonl")) this.scanDetails({ sessionFile: line.slice(14) }, `${origin}:session:${index}`);
				}
			}
		});
	}

	private read(path: string, lines = false): any {
		if (this.budget-- <= 0) return;
		return lines ? evidenceLines(path, this.ioBudget) : evidenceJson(path, this.ioBudget);
	}

	private files(path: string): string[] {
		return this.budget-- > 0 ? evidenceFiles(path) : [];
	}

	private discoverRun(runId: string): void {
		for (const root of this.roots) {
			const key = `${root}:${runId}`;
			if (this.expanded.has(key)) continue;
			this.expanded.add(key);
			const dir = join(root, runId);
			for (const name of this.files(dir)) {
				const match = name.match(/^run-(\d+)$/);
				if (!match) continue;
				const child = this.child(`${runId}:${match[1]}`, runId, Number(match[1]));
				for (const file of this.files(join(dir, name))) if (file.endsWith(".jsonl")) child.sessionFiles.add(join(dir, name, file));
			}
		}
		for (const dir of this.artifactDirs) {
			const key = `${dir}:${runId}`;
			if (this.expanded.has(key)) continue;
			this.expanded.add(key);
			for (const file of this.files(dir)) {
				const match = file.match(new RegExp(`^${runId}_.*?(?:_(\\d+))?_(meta\\.json|transcript\\.jsonl)$`, "i"));
				if (!match) continue;
				const index = Number(match[1] ?? 0);
				const child = this.child(`${runId}:${index}`, runId, index);
				(match[2] === "meta.json" ? child.metadataPaths : child.transcriptPaths).add(join(dir, file));
			}
		}
	}

	private reconcileWorkflowAliases(): void {
		for (const child of [...this.children.values()]) {
			const runId = child.workflowAlias && this.workflowAliases.get(child.workflowAlias);
			if (!runId || runId === child.runId) continue;
			const target = this.child(`${runId}:${child.index}`, runId, child.index);
			target.inline = child.inline ?? target.inline;
			for (const field of ["metadataPaths", "sessionFiles", "transcriptPaths"] as const) for (const path of child[field]) target[field].add(path);
			target.entries.push(...child.entries);
			this.children.delete(child.key);
		}
	}

	resolve(): ChildEvidence[] {
		// A work queue handles nested children and cycles; all reads are bounded.
		for (let pass = 0; pass < 12 && this.budget > 0; pass++) {
			const before = this.visited.size + this.expanded.size;
			for (const dir of this.asyncDirs) {
				if (this.visited.has(dir)) continue;
				this.visited.add(dir);
				for (const file of ["status.json", "workflow-result.json"]) this.scanDetails(this.read(join(dir, file)), dir);
			}
			this.reconcileWorkflowAliases();
			for (const runId of this.runs) this.discoverRun(runId);
			for (const child of [...this.children.values()]) {
				for (const path of child.metadataPaths) {
					if (this.visited.has(path)) continue;
					this.visited.add(path);
					const meta = object(this.read(path));
					if (!meta) continue;
					child.meta = meta;
					const session = this.path(meta.sessionFile);
					const transcript = this.path(meta.transcriptPath);
					if (session) child.sessionFiles.add(session);
					if (transcript) child.transcriptPaths.add(transcript);
				}
				for (const path of child.sessionFiles) {
					if (this.visited.has(path)) continue;
					this.visited.add(path);
					const entries = transcriptEntries(this.read(path, true) ?? []);
					child.entries.push(...entries);
					this.roots.add(path.replace(/\.jsonl$/, ""));
					this.artifactDirs.add(join(dirname(path), "subagent-artifacts"));
					this.scanBranch(entries, path);
				}
				for (const path of child.transcriptPaths) {
					if (this.visited.has(path)) continue;
					this.visited.add(path);
					const entries = transcriptEntries(this.read(path, true) ?? [], child.entries.some(e => e.message?.role === "user"));
					child.entries.push(...entries);
					this.scanBranch(entries, path);
				}
				const inlineKey = `${child.key}:inline`;
				if (!this.visited.has(inlineKey) && !child.entries.some(e => e.message?.role === "assistant") && Array.isArray(child.inline?.messages)) {
					this.visited.add(inlineKey);
					child.entries = child.inline.messages.map((message: any) => ({ type: "message", timestamp: "", message }));
					this.scanBranch(child.entries, inlineKey);
				}
			}
			if (before === this.visited.size + this.expanded.size) break;
		}
		return [...this.children.values()];
	}
}
