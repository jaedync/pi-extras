/**
 * The model-facing descriptions of the subagent tools. Built once per session
 * start or reload, so the model guide and model list never change mid-session
 * and never bust the prompt cache.
 */
import { MAIN } from "./names.ts";

export function subagentDescription(options: { models: string; defaultModel: string | null; guide: string; forChild: boolean }): string {
	const lines = [
		"Start a subagent: a separate Pi session on the model you choose, with a fresh context, the parent's working directory by default and similar tools. It runs in the background and its report reaches you as a message when it finishes; meanwhile keep working or end your turn. Pass wait: true only for a short check whose answer you need before your next step.",
		"",
		"Delegate bounded work that benefits from its own context, a different model's strengths, or an independent second opinion. Do it yourself when a few tool calls would. Start several at once only for work that is truly independent, and prefer one well-briefed subagent over many.",
		"",
		'The first child to edit files in the shared checkout holds it until its run ends; another child\'s edits there are refused meanwhile, though its own subagents can edit beside it. Use isolation: "worktree" for parallel edits, or to leave your checkout unchanged: a separate git checkout of your current files, uncommitted changes included, whose report says how to apply its changes. Set readOnly: true for research and review. Pass tools to give it only the named tools; its message tool always stays.',
		"",
		"Each run has a time budget (maxMinutes) and maybe a cost budget (maxCost, US dollars); the defaults come from config. A run over either is stopped with its subagents, and its report says so. Raise them for long work; a message resumes it with a fresh budget.",
		"",
		"The task is the subagent's whole brief: it has not seen this conversation (unless context is \"fork\"). State the goal, the relevant files and facts, constraints such as read-only, and what the report must contain.",
		"",
		options.forChild
			? "Its report arrives as a message to you. You are not done until your subagents have reported."
			: "Talk to a running or finished subagent with message. Its notes and questions appear in this conversation.",
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
		"A question to anyone else returns at once: the answer arrives as a message, and your report waits until it answers or ends.",
		"Keep messages short and only send what changes the recipient's work.",
	].join(" ");
}
