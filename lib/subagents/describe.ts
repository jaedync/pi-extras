/**
 * The model-facing descriptions of the subagent tools. Built once per session
 * start or reload, so the model guide and model list never change mid-session
 * and never bust the prompt cache.
 */
import { MAIN } from "./names.ts";

/**
 * Claude Code cuts an MCP tool description at this length (CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH),
 * and Meridian sends pi's tools to it as MCP tools. The guide comes last, so it is cut to fit here,
 * with a note, instead of losing its end silently.
 */
export const DESCRIPTION_MAX_CHARS = 4_096;
/**
 * With `codemode` active, Pi appends a line to each declared tool's description
 * ("Codemode: `tools.subagent(args)` resolves to a string.", 57 characters), after this text.
 */
export const PI_SUFFIX_RESERVE = 100;
const GUIDE_HEADING = "The user's notes on which model suits which work:";
const GUIDE_CUT_NOTE = "\n(notes cut to fit; read the guide file named above for the rest)";
const MODELS_HEADING = "Models (and the thinking level each gets unless you pass one):";
/** A model table never takes the room of the guide's first lines, where the bans go. */
const MIN_GUIDE_ROOM = 800;

/** `text` cut to at most `max` characters, never inside a surrogate pair. */
function sliceSafe(text: string, max: number): string {
	const cut = text.slice(0, Math.max(0, max));
	return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** The guide within `room`: cut before the last whole bullet that fits, else at a line end, with a note. */
function fitGuide(guide: string, room: number): string {
	if (guide.length <= room) return guide;
	const cut = sliceSafe(guide, room - GUIDE_CUT_NOTE.length);
	const bullet = cut.lastIndexOf("\n- ");
	const line = cut.lastIndexOf("\n");
	const end = bullet > 0 ? bullet : line > 0 ? line : cut.length;
	return `${cut.slice(0, end)}${GUIDE_CUT_NOTE}`;
}

/** The model table within `room`, cut at a line end with the count of models left out. */
function fitModels(models: string, room: number): string {
	if (models.length <= room) return models;
	const lines = models.split("\n");
	const kept: string[] = [];
	for (const line of lines) {
		const note = `(${lines.length - kept.length - 1} more models in scope; any of them can be named)`;
		if ([...kept, line, note].join("\n").length > room) break;
		kept.push(line);
	}
	return [...kept, `(${lines.length - kept.length} more models in scope; any of them can be named)`].join("\n");
}

export function subagentDescription(options: { models: string; defaultModel: string | null; guide: string; forChild: boolean }): string {
	const intro = [
		"Start a subagent: a separate Pi session on the model you choose, with a fresh context and similar tools. It runs in the background and its report reaches you as a message when it finishes; meanwhile keep working or end your turn. Pass wait: true only for a short check whose answer you need before your next step.",
		"",
		"Delegate bounded work that benefits from its own context, a different model's strengths, or an independent second opinion. Do it yourself when a few tool calls would. Start several at once only for truly independent work.",
		"",
		"The task is its whole brief: it has not seen this conversation (unless context is \"fork\"). State the goal, the relevant files and facts, the constraints, and what the report must contain.",
		"",
		"A task that changes code needs check: the shell command that proves the work (tests, typecheck or build). With fixUntilPass a failure goes back to the child to fix. Read-only and research tasks need no check.",
		"",
		"cwd (absolute or ~/) starts it in another directory or repository. The first child to edit files in a checkout (the file's git repository; outside git, its cwd's, or yours without one) holds it until its run ends: other children's edits there are refused, except its own subagents'. isolation: \"worktree\" gives it its own git worktree of the repository at cwd, with uncommitted changes, for parallel edits; its report says how to apply them. Example: { task, cwd: \"~/dev/app\", isolation: \"worktree\" }. Pass tools to give it only the named tools; its message and clock tools always stay. Each run has its own time and cost budget (maxMinutes, maxCost); at the limit its tools are blocked and it must report. A message resumes it with a fresh budget and its context.",
		"",
		options.forChild
			? "Its report arrives as a message to you. You are not done until your subagents have reported."
			: "Talk to a running or finished subagent with message. For a review or fix loop, tell the agents to message each other by name and report to you only at the end, so you are not woken for each round.",
		"",
	];
	const guide = options.guide.trim();
	const tail = options.defaultModel ? `\nDefault when you name none: ${options.defaultModel}.` : "";
	const limit = DESCRIPTION_MAX_CHARS - PI_SUFFIX_RESERVE;
	const fixedLength = intro.join("\n").length + MODELS_HEADING.length + tail.length + 2;
	const modelRoom = limit - fixedLength - (guide ? MIN_GUIDE_ROOM : 0);
	const head = [...intro, MODELS_HEADING, fitModels(options.models || "(none)", modelRoom)].join("\n") + tail;
	if (!guide) return head;
	const room = limit - head.length - GUIDE_HEADING.length - 3;
	return room <= GUIDE_CUT_NOTE.length ? head : `${head}\n\n${GUIDE_HEADING}\n${fitGuide(guide, room)}`;
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
