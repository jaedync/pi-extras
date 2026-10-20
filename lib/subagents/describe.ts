/**
 * The model-facing descriptions of the subagent tools. Built once per session
 * start or reload, so the model guide and model list never change mid-session
 * and never bust the prompt cache.
 */
import { MAIN } from "./names.ts";

export function subagentDescription(options: { models: string; defaultModel: string | null; guide: string; forChild: boolean }): string {
	const lines = [
		"Start a subagent: a separate Pi session on the model you choose, with a fresh context and similar tools. It runs in the background and its report reaches you as a message when it finishes; meanwhile keep working or end your turn. Pass wait: true only for a short check whose answer you need before your next step.",
		"",
		"Delegate bounded work that benefits from its own context, a different model's strengths, or an independent second opinion. Do it yourself when a few tool calls would. Start several at once only for work that is truly independent, and prefer one well-briefed subagent over many.",
		"",
		'cwd (absolute or ~/) starts it in another directory or repository. The first child to edit files in a checkout (the file\'s git repository; outside git, its cwd\'s, or yours without one) holds it until its run ends: other children\'s edits there are refused, except its own subagents\'. isolation: "worktree" gives it its own git worktree of the repository at cwd, with uncommitted changes, for parallel edits; its report says how to apply them. Example: { task, cwd: "~/dev/app", isolation: "worktree" }. Set readOnly: true for research and review: it keeps only read, grep, find, ls and known search and fetch tools, and drops every other tool. Pass tools to give it only the named tools; its message tool always stays.',
		"",
		"Each run has a time budget (maxMinutes) and maybe a cost budget (maxCost, US dollars), with defaults from config. The child is told when its run started and when its time budget ends, and it gets notes of the work minutes used and left at each 10% of it up to 80% and after a wait; near the end of a cost budget it gets a note. At the limit its tools are blocked, its subagents stop, and it must write its report at once; the report says it was written at the budget, and a child that does not write it is stopped. A message resumes it with a fresh budget and its context. Each subagent has its own budget, which its parent's does not limit. Raise them for long work.",
		"",
		"The task is the subagent's whole brief: it has not seen this conversation (unless context is \"fork\"). State the goal, the relevant files and facts, constraints such as read-only, and what the report must contain.",
		"",
		"A task that changes code needs check: the shell command that proves the work (tests, typecheck or build). With fixUntilPass a failure goes back to the child to fix. Read-only and research tasks need no check.",
		"",
		options.forChild
			? "Its report arrives as a message to you. You are not done until your subagents have reported."
			: "Talk to a running or finished subagent with message. Its notes and questions appear in this conversation. For a review or fix loop, tell the agents to message each other by name and report to you only at the end, so you are not woken for each round.",
		"",
		"Models (and the thinking level each gets unless you pass one):",
		options.models || "(none)",
	];
	if (options.defaultModel) lines.push(`Default when you name none: ${options.defaultModel}.`);
	if (options.guide.trim()) lines.push("", "The user's current notes on which model suits which work:", options.guide.trim());
	return lines.join("\n");
}

export function mainMessageDescription(): string {
	return [
		`Send a message to a subagent by name, or to "all" of them.`,
		"A running subagent reads it after its current tool call. A finished, failed or stopped one resumes with its context intact to handle it.",
		"With expectReply: true its answer wakes you when it arrives. You never wait on this call.",
	].join(" ");
}

export function stopDescription(forChild: boolean): string {
	return [
		`Stop a subagent you started, and everything it started, when its work is no longer needed or it is going wrong.`,
		`Pass its name, or "all" for every one of yours that is still working. The result says how it ended and gives its last message; no report follows. A message to it later resumes it with its context.`,
		forChild ? "You can stop only your own subagents." : "A finished subagent has nothing to stop; message it instead.",
	].join(" ");
}

export function childMessageDescription(replyTimeoutMs: number): string {
	return [
		`Send a message to "${MAIN}", another agent by name, or "all".`,
		`With expectReply: true to "${MAIN}" or your parent, this call waits up to ${Math.round(replyTimeoutMs / 60_000)} minutes and returns the answer.`,
		"A question to anyone else returns immediately: the answer arrives as a message, and your report waits until it answers or ends. A question to an agent that waits for you is refused; send it a note instead.",
		"Keep messages short and only send what changes the recipient's work.",
	].join(" ");
}
