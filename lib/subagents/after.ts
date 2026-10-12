/**
 * `after`: a spawn that waits for other agents to end before its first run.
 * The team records it at once and keeps it queued while any agent it names is
 * live (team.ts `pump`); idle, failed, stopped and interrupted all count as
 * ended. Its first prompt then says how each one ended and where its report
 * is, not the report itself, so the child reads only what it needs. Only the
 * first start waits: a later run, a resume included, never does.
 */
import { latestReportFile } from "./reports.ts";
import { LIVE_STATES, type AgentRecord } from "./types.ts";

/** The most agents one spawn may wait for. */
export const MAX_AFTER = 16;

type Lookup = (name: string) => AgentRecord | undefined;

const live = (record: AgentRecord | undefined): boolean => record !== undefined && LIVE_STATES.has(record.state);

/** Whether `name` is an agent `spawner` sits under: it is not done until the spawner's subagents report. */
function above(name: string, spawner: string, get: Lookup): boolean {
	for (let current = get(spawner); current; current = get(current.parent)) if (current.parent === name) return true;
	return false;
}

/**
 * Why a spawn by `spawner` can't wait for `names`, or undefined. Every agent
 * can address every other, so any name in the team is visible. The spawner
 * and the agents above it wait for this spawn, so neither would ever end.
 */
export function afterError(names: readonly string[], spawner: string, get: Lookup, known: () => string): string | undefined {
	if (names.length > MAX_AFTER) return `after can name at most ${MAX_AFTER} agents.`;
	for (const name of names) {
		if (name === spawner) return `after can't name ${name}: that is you, and you are not done until this subagent reports.`;
		if (!get(name)) return `after names ${JSON.stringify(name)}, which is not an agent. ${known()}`;
		if (above(name, spawner, get)) return `after can't name ${name}: it waits for you, so neither would end.`;
	}
	return undefined;
}

/** The agents `record` still waits for before its first run; none once it has run. */
export function waitingFor(record: AgentRecord, get: Lookup): string[] {
	if (record.runs > 0 || !record.after?.length) return [];
	return record.after.filter((name) => live(get(name)));
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

/** The after agents `asker` is, or works for, while `target` still waits for them: `target` can't answer it first. */
export function waitsOnAsker(target: AgentRecord, asker: string, get: Lookup, under: (name: string, ancestor: string) => boolean): string[] {
	if (target.state !== "queued") return [];
	const waits = waitingFor(target, get);
	return waits.some((name) => name === asker || under(asker, name)) ? waits : [];
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
		case "idle": return "finished";
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
