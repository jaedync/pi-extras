/**
 * Where a child's report goes when its run ends (team.ts `finish`): to a
 * question its parent waits on, to its parent, or to main. Agents it owed an
 * answer get how its run ended; anyone else waiting on its answer stops
 * waiting. A peer's run that ended quietly does not wake its parent.
 */
import { awaited } from "./after.ts";
import { checkFailed } from "./checks.ts";
import { reportText } from "./format.ts";
import { MAIN } from "./names.ts";
import type { OpenQuestions } from "./questions.ts";
import type { Routing } from "./routing.ts";
import { type AgentRecord, LIVE_STATES, type MainDelivery } from "./types.ts";
import { footerTree, sourceCheckout, worktreeFooter } from "./worktree.ts";

export interface HandUpHost {
	readonly questions: OpenQuestions;
	readonly routing: Routing;
	list(): AgentRecord[];
	get(name: string): AgentRecord | undefined;
	deliverToMain(delivery: MainDelivery): void;
	now(): number;
}

/** Hands `record`'s report on; `silent` when its parent stopped it and has the record from that call. */
export function handUp(host: HandUpHost, record: AgentRecord, silent: boolean): void {
	const { name } = record;
	// The report answers anything main was waiting on.
	const { owedMain, peerRun } = host.routing.ended(name);
	const { parentAsked, unanswered } = payOwed(host, record);
	// A peer's run that ended quietly is news for the parent's next turn, unless it answers the parent or main.
	// So is one that a spawn of the same parent waits for: the parent hears of it through that spawn's report.
	// A check that did not pass is news either way, and so is any report to a parent whose run waits on its subagents.
	const parentWaits = host.get(record.parent)?.state === "waiting";
	const quiet = (peerRun || awaited(record, host.list())) && record.state === "idle" && !checkFailed(record) && !parentAsked && !owedMain && !parentWaits;
	// A parent waiting on this child's answer gets the report as that answer.
	const asked = host.questions.of(record.parent).find((question) => question.to === name);
	if (asked) asked.resolve(reportText(record, host.now()));
	else if (!silent) reportUp(host, record, quiet);
	// Its parent has the report; anyone else it owed an answer gets how its run ended instead.
	for (const asker of unanswered) host.routing.deliver(name, asker, `${name} ended without answering you. ${reportText(record, host.now())}`, true, `Report from ${name}`);
	// Anyone else waiting on it would wait out the whole timeout for an answer that can't come.
	for (const [asker, questions] of host.questions.entries()) {
		if (asker === record.parent) continue;
		for (const question of questions.filter((open) => open.to === name)) question.reject(new Error(`${name} ended without answering (${record.state}). Continue without its answer, or message it again: a finished agent resumes to handle a message.`));
	}
}

/**
 * A resume that could not launch: its parent, and main when main asked it,
 * get the failure; anyone else it owed an answer hears that none will come.
 */
export function handUpFailure(host: HandUpHost, failure: AgentRecord, owedMain: boolean): void {
	const text = reportText(failure, host.now());
	const { unanswered } = payOwed(host, failure);
	const asked = host.questions.of(failure.parent).find((question) => question.to === failure.name);
	if (asked) asked.resolve(text);
	else if (failure.parent === MAIN) host.deliverToMain({ kind: "report", record: failure });
	else host.routing.deliver(failure.name, failure.parent, text, true);
	if (owedMain && failure.parent !== MAIN) host.deliverToMain({ kind: "report", record: failure });
	for (const asker of unanswered) host.routing.deliver(failure.name, asker, `${failure.name} ended without answering you. ${text}`, true, `Report from ${failure.name}`);
}

/** Settles what `record` owed: whether its parent asked it, and who else did. */
function payOwed(host: HandUpHost, record: AgentRecord): { parentAsked: boolean; unanswered: string[] } {
	const unanswered: string[] = [];
	let parentAsked = false;
	for (const asker of host.list().filter((entry) => entry.owed?.includes(record.name)).map((entry) => entry.name)) {
		if (!host.routing.payOwed(asker, record.name)) continue;
		if (asker === record.parent) parentAsked = true;
		else unanswered.push(asker);
	}
	return { parentAsked, unanswered };
}

/**
 * The report to its parent, which a blocking parent gets from its wait
 * instead. A parent that failed or was stopped can't read it, so it goes to
 * the nearest live ancestor, or main: no report is lost.
 */
function reportUp(host: HandUpHost, record: AgentRecord, quiet: boolean): void {
	const to = reportTarget(host, record);
	const orphan = to !== record.parent;
	if (record.blocking && !orphan) return;
	const sent = orphan ? orphanFooter(host, record, to) : record;
	if (to === MAIN) return host.deliverToMain({ kind: "report", record: sent, ...(quiet && !orphan ? { quiet } : {}) });
	const why = orphan ? `${record.name}'s parent ${record.parent} has ended, so its report comes to you.\n` : "";
	host.routing.deliver(record.name, to, `${why}${reportText(sent, host.now())}`, !quiet || orphan, `Report from ${record.name}`);
}

/**
 * The Apply line of a report whose worktree an ended agent owns or made: that
 * agent's own Apply line is a tree written when it ended. A helper in its
 * worktree applies what changed since; a worktree made from it applies to
 * that agent's own source checkout.
 */
function orphanFooter(host: HandUpHost, record: AgentRecord, to: string): AgentRecord {
	const { worktree } = record;
	if (!worktree || host.get(to)?.worktree?.path === worktree.path) return record;
	if (record.sharesWorktree) {
		let owner = host.get(record.parent);
		while (owner?.sharesWorktree) owner = host.get(owner.parent);
		const since = owner?.worktreeReport ? footerTree(owner.worktreeReport) : undefined;
		return { ...record, sharesWorktree: undefined, worktreeReport: worktreeFooter(worktree, since ? { since } : {}) };
	}
	const parent = host.get(record.parent);
	const into = parent?.worktree && sourceCheckout(worktree.path) === parent.worktree.path ? sourceCheckout(parent.worktree.path) : undefined;
	return into ? { ...record, worktreeReport: worktreeFooter(worktree, { into }) } : record;
}

function reportTarget(host: HandUpHost, record: AgentRecord): string {
	const parent = host.get(record.parent);
	if (!parent || (parent.state !== "failed" && parent.state !== "stopped")) return record.parent;
	for (let above = host.get(parent.parent); above; above = host.get(above.parent)) if (LIVE_STATES.has(above.state)) return above.name;
	return MAIN;
}
