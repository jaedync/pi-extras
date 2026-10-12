/**
 * `after`: a spawn that waits for other agents to end before its first run.
 * The team records it at once and keeps it queued while any agent it names is
 * live (team.ts `pump`); idle, failed, stopped and interrupted all count as
 * ended. Its first prompt then says how each one ended and where its report
 * is, not the report itself, so the child reads only what it needs. Only the
 * first start waits: a later run, a resume included, never does.
 */
import { checkFailed, checkOf, checkVerdict } from "./checks.ts";
import { latestReportFile } from "./reports.ts";
import { LIVE_STATES, type AgentRecord } from "./types.ts";

/** The most agents one spawn may wait for. */
export const MAX_AFTER = 16;

type Lookup = (name: string) => AgentRecord | undefined;

const live = (record: AgentRecord | undefined): boolean => record !== undefined && LIVE_STATES.has(record.state);

/**
 * The agents `record` can't end before: its live subagents, whose reports it
 * waits for; the live agents that owe it an answer; and, while it waits to
 * start, its live after agents. A conservative graph: an owed answer may come
 * without its giver ending, but nothing makes it come. One that owes an
 * answer but no longer runs is not waited on (team.ts `waitsFor`).
 */
function blockers(record: AgentRecord, children: ReadonlyMap<string, readonly string[]>, get: Lookup): string[] {
	const owed = (record.owed ?? []).filter((name) => live(get(name)));
	return [...(children.get(record.name) ?? []), ...owed, ...(record.state === "queued" ? waitingFor(record, get) : [])];
}

/** Whether `name` can't end before `target` does, directly or through other agents. */
export function dependsOn(name: string, target: string, records: readonly AgentRecord[]): boolean {
	const byName = new Map(records.map((record) => [record.name, record]));
	const get: Lookup = (other) => byName.get(other);
	const children = new Map<string, string[]>();
	for (const record of records) if (live(record)) children.set(record.parent, [...(children.get(record.parent) ?? []), record.name]);
	const seen = new Set<string>();
	const next = [name];
	while (next.length > 0) {
		const current = next.pop()!;
		if (current === target) return true;
		if (seen.has(current)) continue;
		seen.add(current);
		const record = get(current);
		if (record) next.push(...blockers(record, children, get));
	}
	return false;
}

/**
 * The held spawn through which `name` can't end before `target` does: the
 * first spawn on such a path that waits to start for its after agents.
 * Undefined when no path goes through one (a path of subagents and owed
 * answers alone is not this case).
 */
export function heldBetween(name: string, target: string, records: readonly AgentRecord[]): string | undefined {
	const byName = new Map(records.map((record) => [record.name, record]));
	const get: Lookup = (other) => byName.get(other);
	const children = new Map<string, string[]>();
	for (const record of records) if (live(record)) children.set(record.parent, [...(children.get(record.parent) ?? []), record.name]);
	const seen = new Set<string>();
	const next: Array<{ readonly at: string; readonly held: string | undefined }> = [{ at: name, held: undefined }];
	while (next.length > 0) {
		const { at, held } = next.pop()!;
		if (at === target && held !== undefined) return held;
		const key = `${held === undefined ? "-" : "+"}${at}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const record = get(at);
		if (!record) continue;
		const waits = record.state === "queued" ? waitingFor(record, get) : [];
		next.push(...[...(children.get(at) ?? []), ...(record.owed ?? [])].map((other) => ({ at: other, held })));
		next.push(...waits.map((other) => ({ at: other, held: held ?? at })));
	}
	return undefined;
}

export interface AfterRequest {
	readonly after: readonly string[];
	/** The spawner: this spawn's parent, which is not done until it reports. */
	readonly parent: string;
	readonly blocking: boolean;
}

/**
 * Why a spawn can't wait for its after agents, or undefined. Every agent can
 * address every other, so any name in the team is visible. An agent that
 * can't end before the spawner does would never let this spawn start, and
 * the spawner waits for this spawn: neither would end. A caller blocked in
 * wait: true could not answer a question from one of them either.
 */
export function afterError(request: AfterRequest, records: readonly AgentRecord[], known: () => string): string | undefined {
	if (request.blocking) return "wait: true can't go with after: the agents it waits for may need an answer from you first. Leave out wait; its report arrives as a message.";
	if (request.after.length > MAX_AFTER) return `after can name at most ${MAX_AFTER} agents.`;
	for (const name of request.after) {
		if (name === request.parent) return `after can't name ${name}: that is you, and you are not done until this subagent reports.`;
		if (!records.some((record) => record.name === name)) return `after names ${JSON.stringify(name)}, which is not an agent. ${known()}`;
		if (dependsOn(name, request.parent, records)) return `after can't name ${name}: it waits for you, directly or through other agents, so neither would end.`;
	}
	return undefined;
}

/** The agents `record` still waits for before its first run; none once it has run. */
export function waitingFor(record: AgentRecord, get: Lookup): string[] {
	if (record.runs > 0 || !record.after?.length) return [];
	return record.after.filter((name) => live(get(name)));
}

/**
 * `records` in an order where a spawn that has not run comes after the agents
 * among them that its first run waits for. Resumed in this order, a spawn
 * finds each of those agents live again when it resumes too, and waits.
 */
export function afterOrder<T extends Pick<AgentRecord, "name" | "runs" | "after">>(records: readonly T[]): T[] {
	const byName = new Map(records.map((record) => [record.name, record]));
	const ordered: T[] = [];
	const placed = new Set<string>();
	const place = (record: T, path: ReadonlySet<string>): void => {
		// A loop of after names is refused at spawn; should one be here anyway, the index's order breaks it.
		if (placed.has(record.name) || path.has(record.name)) return;
		const before = record.runs === 0 ? (record.after ?? []).map((name) => byName.get(name)).filter((found): found is T => found !== undefined) : [];
		for (const other of before) place(other, new Set([...path, record.name]));
		placed.add(record.name);
		ordered.push(record);
	};
	for (const record of records) place(record, new Set());
	return ordered;
}

/** Queued only because an agent it names has not ended. */
export const heldAfter = (record: AgentRecord, get: Lookup): boolean => record.state === "queued" && waitingFor(record, get).length > 0;

/** What the widget shows for a held spawn. */
export const afterActivity = (names: readonly string[]): string => `after ${names.join(", ")}`;

/**
 * Whether another member of `group` still works. A spawn held for its after
 * agents does not, so it never keeps its group's reports waiting meanwhile.
 */
export function busyInGroup(records: readonly AgentRecord[], group: string, except: string): boolean {
	const byName = new Map(records.map((record) => [record.name, record]));
	return records.some((record) => record.group === group && record.name !== except && live(record) && !heldAfter(record, (name) => byName.get(name)));
}

/**
 * Whether a spawn of the same parent waits to start after `record`: the
 * parent hears of it through that spawn's report, so this one need not wake it.
 */
export function awaited(record: AgentRecord, records: readonly AgentRecord[]): boolean {
	return records.some((other) => other.parent === record.parent && other.state === "queued" && other.runs === 0 && other.after?.includes(record.name) === true);
}

/**
 * Why an agent can't ask `target` a question: `target` waits to start for its
 * after agents, and a message can't start it. The asker's report would wait
 * for the answer, and when the asker is, or waits through others on, one of
 * those agents, nothing would end. A question asked first can close that loop
 * later, so every question to a held spawn is refused; a note waits for it.
 */
export function askError(target: AgentRecord | undefined, get: Lookup): string | undefined {
	const waits = target?.state === "queued" ? waitingFor(target, get) : [];
	if (waits.length === 0) return undefined;
	return `${target!.name} has not started: it starts after ${waits.join(", ")} ${waits.length === 1 ? "ends" : "end"}. Send a note instead (no expectReply); it reads it when it starts.`;
}

/** What a queued spawn shows: the after agents it still waits for, then plain `queued`; any other activity stays. */
export function queuedActivity(record: AgentRecord, get: Lookup): string | null {
	const waits = waitingFor(record, get);
	return waits.length > 0 ? afterActivity(waits) : record.activity?.startsWith("after ") ? "queued" : record.activity;
}

const oneLine = (text: string, max = 200): string => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** The report of its latest run that saved one; a restored record has only its session file to find it by. */
function reportOf(record: AgentRecord): string | undefined {
	if (record.reportFile) return record.reportFile;
	try { return record.sessionFile ? latestReportFile(record.sessionFile) : undefined; }
	catch { return undefined; }
}

function ended(record: AgentRecord): string {
	switch (record.state) {
		// Its own report may claim success; the harness's check says otherwise.
		case "idle": return checkFailed(record) ? `finished, but the harness's check ${checkVerdict(checkOf(record)!)}` : "finished";
		case "failed": return `failed: ${oneLine(record.error ?? "unknown error")}`;
		case "stopped": return `was stopped${record.stopReason ? ` ${record.stopReason}` : ""}`;
		case "interrupted": return "was interrupted; that counts as ended, and it may resume later";
		default: return `is ${record.state}`;
	}
}

function endedLine(name: string, record: AgentRecord | undefined): string {
	if (!record) return `- ${name} is no longer known.`;
	const report = reportOf(record);
	const where = report ? `Report: ${report}` : record.sessionFile ? `No report; its session: ${record.sessionFile}` : "No report.";
	return `- ${name} ${ended(record)}. ${where}`;
}

/** The block a held spawn's first prompt ends with: how each after agent ended and where its report is. */
export function afterBlock(record: AgentRecord, get: Lookup): string {
	const lines = (record.after ?? []).map((name) => endedLine(name, get(name)));
	return ["## Agents you started after", "You started when these had ended. Read their reports as you need them.", ...lines].join("\n");
}

/**
 * The order to stop several agents in: those that have not started go first.
 * Stopping an agent a held spawn waits for would launch that spawn, only for
 * the next stop to end it.
 */
export function stopOrder<T extends Pick<AgentRecord, "state">>(records: readonly T[]): T[] {
	return [...records.filter((record) => record.state === "queued"), ...records.filter((record) => record.state !== "queued")];
}
