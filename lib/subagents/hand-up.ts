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
import type { AgentRecord, MainDelivery } from "./types.ts";

export interface HandUpHost {
	readonly questions: OpenQuestions;
	readonly routing: Routing;
	list(): AgentRecord[];
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
	// A check that did not pass is news either way.
	const quiet = (peerRun || awaited(record, host.list())) && record.state === "idle" && !checkFailed(record) && !parentAsked && !owedMain;
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

/** The report to its parent, which a blocking parent gets from its wait instead. */
function reportUp(host: HandUpHost, record: AgentRecord, quiet: boolean): void {
	if (record.blocking) return;
	if (record.parent === MAIN) return host.deliverToMain({ kind: "report", record, ...(quiet ? { quiet } : {}) });
	host.routing.deliver(record.name, record.parent, reportText(record, host.now()), !quiet, `Report from ${record.name}`);
}
