/**
 * The model-facing descriptions of the subagent tools. Built once per session
 * start or reload, so the model guide and model list never change mid-session
 * and never bust the prompt cache.
 */
import { MAIN } from "./names.ts";

export function subagentDescription(options: { models: string; defaultModel: string | null; guide: string; forChild: boolean }): string {
	const lines = [
		"Start a subagent: a separate Pi session on the model you choose, with a fresh context, the same working directory and similar tools. It runs in the background and its report reaches you as a message when it finishes; meanwhile keep working or end your turn. Pass wait: true only for a short check whose answer you need before your next step.",
		"",
		"Delegate bounded work that benefits from its own context, a different model's strengths, or an independent second opinion. Do it yourself when a few tool calls would. Start several at once only for work that is truly independent, and prefer one well-briefed subagent over many.",
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
		"A running subagent reads it after its current tool call. A finished one resumes with its context intact to handle it.",
		"With expectReply: true its answer wakes you when it arrives. You never wait on this call.",
	].join(" ");
}

export function childMessageDescription(replyTimeoutMs: number): string {
	return [
		`Send a message to "${MAIN}", another agent by name, or "all".`,
		`With expectReply: true this call waits up to ${Math.round(replyTimeoutMs / 60_000)} minutes and returns the answer.`,
		"Keep messages short and only send what changes the recipient's work.",
	].join(" ");
}
