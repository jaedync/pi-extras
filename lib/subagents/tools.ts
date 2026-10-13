/**
 * The `subagent` and `message` tool definitions, for main and for children.
 * They are thin: validation and wording here, behavior in the team.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MAX_AFTER, stopOrder, waitingFor } from "./after.ts";
import { CHECK_TIMEOUT_MINUTES, MAX_CHECK_CHARS, MAX_CHECK_TIMEOUT_MINUTES, MAX_FIX_ROUNDS, mergeCheck } from "./checks.ts";
import { allowedTools, checkAllowlist } from "./allowlist.ts";
import { MAX_RUN_MINUTES } from "./budget.ts";
import { childMessageDescription, mainMessageDescription, stopDescription, subagentDescription } from "./describe.ts";
import { capReport, reportText, rosterText } from "./format.ts";
import { isThinking, type ModelChoice, resolveModel, THINKING_LEVELS, type Thinking, thinkingFor, type ThinkingSettings } from "./models.ts";
import { EVERYONE, MAIN } from "./names.ts";
import { teamNow } from "./status.ts";
import type { HostTeam } from "./contract.ts";
import type { SendResult } from "./team.ts";
import { type AgentRecord, type CheckUpdate, LIVE_STATES } from "./types.ts";

export const MAX_TASK_CHARS = 60_000;
export const MAX_MESSAGE_CHARS = 20_000;
const PROGRESS_MS = 1_000;

export interface ToolContext {
	/** Read at each call: after a /reload, the team may change once it is quiet (host.ts). */
	readonly team: HostTeam;
	allowed: readonly ModelChoice[];
	/** Used when the call names no model: the configured default, else the parent's. */
	fallbackModel: string | null;
	thinking: ThinkingSettings;
	modelTable: string;
	guide: string;
	replyTimeoutMs: number;
	now(): number;
	/** Main's current run; children it starts in one run report together. */
	currentGroup?(): string | undefined;
	/** The tools a child could have before any allowlist: the parent's active tools minus the exclusions. */
	childTools?(readOnly: boolean): string[];
}

type Result = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> | undefined };
const text = (value: string, details?: Record<string, unknown>): Result => ({ content: [{ type: "text", text: value }], details });

const thinkingSchema = Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)), { description: "Reasoning level; omit for the model's usual level." });

/** A check's fields, on `subagent` and on `message`; `check` itself says what it does there. */
const checkFields = (check: string) => ({
	check: Type.Optional(Type.String({ minLength: 1, maxLength: MAX_CHECK_CHARS, description: check })),
	fixUntilPass: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_FIX_ROUNDS, description: "With check: how many times a failure goes back to it to fix before it reports. Default 0." })),
	checkTimeoutMinutes: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: MAX_CHECK_TIMEOUT_MINUTES, description: `With check: minutes the command may run. Default ${CHECK_TIMEOUT_MINUTES}.` })),
});

const subagentParams = Type.Object({
	task: Type.String({ minLength: 1, maxLength: MAX_TASK_CHARS, description: "The complete brief: goal, relevant files and facts, constraints, and what the report must contain." }),
	name: Type.Optional(Type.String({ maxLength: 40, description: "Short name that says what it does, like auth-review or count-md. You, the user and other agents address it by this name." })),
	model: Type.Optional(Type.String({ description: "Model reference or unique short name from the list above." })),
	thinking: Type.Optional(thinkingSchema),
	readOnly: Type.Optional(Type.Boolean({ description: "No file edits or shell commands." })),
	tools: Type.Optional(Type.Array(Type.String(), { description: "Give it only these of the tools it would get; message always stays. Omit for all of them." })),
	cwd: Type.Optional(Type.String({ minLength: 1, maxLength: 4096, description: "Directory it starts in, absolute or ~/: its tools, AGENTS.md and session work there. Default: your working directory." })),
	isolation: Type.Optional(Type.Union([Type.Literal("shared"), Type.Literal("worktree")], { description: "Default shared. Use worktree for a separate git worktree of the repository at cwd (default: your working directory), with its current files." })),
	context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")], { description: "fork gives it this conversation so far; default fresh." })),
	wait: Type.Optional(Type.Boolean({ description: "Block until it finishes and return its report. Only for short checks." })),
	maxMinutes: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: MAX_RUN_MINUTES, description: "Minutes one run may work before it is stopped; default from config." })),
	maxCost: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "US dollars one run may spend before it is stopped; default from config." })),
	after: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 40 }), { minItems: 1, maxItems: MAX_AFTER, description: "Agents that must end first. It waits queued, then starts with the paths of their reports." })),
	...checkFields("Shell command the harness runs in its directory when a run ends normally, before the report goes up. The report shows the command, exit code and last output lines. Later runs keep it."),
}, { additionalProperties: false });

const messageParams = Type.Object({
	to: Type.String({ minLength: 1, description: "An agent's name, or \"all\"." }),
	text: Type.String({ minLength: 1, maxLength: MAX_MESSAGE_CHARS }),
	expectReply: Type.Optional(Type.Boolean({ description: "Ask for an answer." })),
	...checkFields("A new check for one of your subagents: a shell command the harness runs when its run ends normally. Replaces the one it has."),
}, { additionalProperties: false });

const stopParams = Type.Object({
	name: Type.String({ minLength: 1, description: "The subagent's name, or \"all\" for every one of yours still working." }),
}, { additionalProperties: false });

interface SubagentInput extends CheckInput {
	task: string; name?: string; model?: string; thinking?: string; readOnly?: boolean; isolation?: "shared" | "worktree"; cwd?: string; context?: string; wait?: boolean;
	maxMinutes?: number; maxCost?: number; tools?: string[]; after?: string[];
}
interface CheckInput { check?: string; fixUntilPass?: number; checkTimeoutMinutes?: number }
interface MessageInput extends CheckInput { to: string; text: string; expectReply?: boolean }

/** Whether `self` could run a shell command itself: main, or a child that is not read-only and has bash. */
function runsBash(tc: ToolContext, self: string): boolean {
	if (self === MAIN) return true;
	const record = tc.team.get(self);
	return !!record && !record.readOnly && allowedTools(tc.childTools?.(false) ?? [], record.tools).includes("bash");
}

/** The check a call sets, if any. A check runs a command, so only an agent that could run it itself may set one. */
function checkInput(tc: ToolContext, self: string, params: CheckInput): CheckUpdate | undefined {
	if (params.check === undefined) {
		if (params.fixUntilPass !== undefined || params.checkTimeoutMinutes !== undefined) throw new Error("fixUntilPass and checkTimeoutMinutes go with check.");
		return undefined;
	}
	if (!runsBash(tc, self)) throw new Error("Only an agent that can run bash commands itself can set a check, and you can't.");
	return { command: params.check, ...(params.fixUntilPass !== undefined ? { fixUntilPass: params.fixUntilPass } : {}), ...(params.checkTimeoutMinutes !== undefined ? { timeoutMinutes: params.checkTimeoutMinutes } : {}) };
}

/** The allowlist for a new child of `parent`: the one asked for, else its parent's, since a restricted parent can't pass on more than it has. */
function spawnTools(tc: ToolContext, parent: string, requested: readonly string[] | undefined, readOnly: boolean): string[] | undefined {
	const limit = tc.team.get(parent)?.tools;
	const available = allowedTools(tc.childTools?.(readOnly) ?? [], limit);
	if (requested === undefined) return limit ? available : undefined;
	const checked = checkAllowlist(requested, available, readOnly);
	if (!checked.ok) throw new Error(checked.error);
	return checked.tools;
}

function spawnSummary(record: AgentRecord, team: HostTeam): string {
	const thinking = record.thinking ? `, thinking ${record.thinking}` : "";
	const waits = waitingFor(record, (name) => team.get(name));
	const where = waits.length > 0 ? `It waits for ${waits.join(", ")} to end, then starts.`
		: record.state === "queued" ? "It is queued behind other subagents and starts when a slot frees." : "It is running in the background.";
	const place = record.worktree ? ` in the worktree ${record.worktree.path}` : record.cwd ? ` in ${record.cwd}` : "";
	const checked = record.check ? " Its report will end with the harness's check." : "";
	return `Started ${record.name} on ${record.model}${thinking}${place}. ${where} Its report will arrive as a message.${checked} Talk to it with message({ to: "${record.name}", text }).`;
}

export function subagentTool(tc: ToolContext, parent: string): ToolDefinition {
	return {
		name: "subagent",
		label: "Subagent",
		description: subagentDescription({ models: tc.modelTable, defaultModel: tc.fallbackModel, guide: tc.guide, forChild: parent !== MAIN }),
		promptSnippet: "Delegate bounded work to a background subagent on a chosen model",
		parameters: subagentParams,
		async execute(_id, raw, signal, onUpdate) {
			const params = raw as SubagentInput;
			const wanted = params.model ?? tc.fallbackModel;
			if (!wanted) throw new Error("No model to run on: name one, or set subagents.defaultModel.");
			const resolved = resolveModel(wanted, tc.allowed);
			if (!resolved.ok) throw new Error(resolved.error);
			if (params.thinking !== undefined && !isThinking(params.thinking)) throw new Error(`Unknown thinking level ${params.thinking}.`);
			const thinking = thinkingFor(resolved.choice, params.thinking as Thinking | undefined, tc.thinking);
			const fork = params.context === "fork";
			if (fork && parent !== MAIN) throw new Error("Only the main session can fork its context.");
			const tools = spawnTools(tc, parent, params.tools, params.readOnly === true);
			const check = checkInput(tc, parent, params);
			const group = parent === MAIN ? tc.currentGroup?.() : undefined;
			const spawned = tc.team.spawn({
				...(group ? { group } : {}),
				...(params.isolation ? { isolation: params.isolation } : {}),
				...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
				...(params.maxMinutes !== undefined ? { maxMinutes: params.maxMinutes } : {}),
				...(params.maxCost !== undefined ? { maxCost: params.maxCost } : {}),
				...(tools ? { tools } : {}),
				...(params.after ? { after: params.after } : {}),
				...(check ? { check: mergeCheck(check) } : {}),
				task: params.task.trim(), parent, model: resolved.choice.ref, readOnly: params.readOnly === true, fork,
				blocking: params.wait === true, ...(params.name ? { name: params.name } : {}), ...(thinking ? { thinking } : {}),
			});
			if (!spawned.ok) throw new Error(spawned.error);
			const record = spawned.record;
			// Status Plus finds the child's session through this path and counts its usage.
			const details = {
				name: record.name, model: record.model, thinking: record.thinking ?? null, wait: params.wait === true,
				...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
				...(record.worktree ? { worktree: { ...record.worktree } } : {}),
				...(record.cwd ? { cwd: record.cwd } : {}),
			};
			if (params.wait !== true) return text(spawnSummary(record, tc.team), details);
			return await waitFor(tc, record.name, details, signal, onUpdate as ((update: Result) => void) | undefined);
		},
	} as ToolDefinition;
}

async function waitFor(tc: ToolContext, name: string, details: Record<string, unknown>, signal: AbortSignal | undefined,
	onUpdate: ((update: Result) => void) | undefined): Promise<Result> {
	let last = 0;
	let onDetached: (() => void) | undefined;
	// The child's question to its waiting parent detaches it (see Team.send); stop waiting so the parent can answer.
	const detached = new Promise<"detached">((resolve) => { onDetached = () => resolve("detached"); });
	const stopProgress = tc.team.onChange((record) => {
		if (!record || record.name !== name) return;
		if (!record.blocking && LIVE_STATES.has(record.state)) onDetached?.();
		if (!onUpdate) return;
		const now = tc.now();
		if (now - last < PROGRESS_MS) return;
		last = now;
		onUpdate(text(record.activity ?? record.state, { ...details, activity: record.activity, state: record.state }));
	});
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<null>((resolve) => {
		if (signal?.aborted) return resolve(null);
		onAbort = () => resolve(null);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
	try {
		const done = await Promise.race([tc.team.whenDone(name), aborted, detached]);
		if (done === "detached") {
			return text(`Stopped waiting: ${name} asked you something. Answer with message({ to: "${name}", text }); its report will arrive as a message.`, { ...details, detached: true, asked: true });
		}
		if (done === null) {
			tc.team.detach(name);
			return text(`Stopped waiting. ${name} keeps running in the background and its report will arrive as a message.`, { ...details, detached: true });
		}
		// Later runs (after a message resumes it) report as messages.
		tc.team.detach(name);
		const failed = done.state !== "idle";
		const result = text(reportText(done, tc.now()), { ...details, state: done.state, ...(done.report ? { report: capReport(done.report) } : {}) });
		if (failed) throw new Error(result.content[0]!.text);
		return result;
	} finally {
		stopProgress();
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}

/** A message's check is for the one agent it goes to. */
function messageCheck(tc: ToolContext, self: string, params: MessageInput): CheckUpdate | undefined {
	const check = checkInput(tc, self, params);
	if (check && params.to === EVERYONE) throw new Error("A check is for one agent; name it in to.");
	return check;
}

const deliveredWords: Record<string, string> = {
	replied: "Answered; it continues with your reply.",
	steered: "Delivered; it reads it after its current tool call.",
	resumed: "It had finished; it resumed with its context to handle this.",
	queued: "It has not started yet; it reads this when it does.",
	inbox: "It had finished; this waits for its next run.",
	main: "Delivered to main.",
};

const userWords: Record<string, string> = {
	replied: "Answered its question.",
	steered: "Delivered after its current step.",
	resumed: "It resumed to handle your message.",
	queued: "It has not started yet; it reads this when it does.",
	inbox: "It waits in its inbox for its next run.",
};

/** What the inspector tells the user about a message they sent a child; a paused child's notice says why it did not resume. */
export function userSendWords(result: Extract<SendResult, { ok: true }>): string {
	const words = userWords[result.delivered] ?? "Delivered.";
	return result.notice ? `${words} ${result.notice}` : words;
}

export function mainMessageTool(tc: ToolContext): ToolDefinition {
	return {
		name: "message",
		label: "Message",
		description: mainMessageDescription(),
		promptSnippet: "Message a running or finished subagent",
		parameters: messageParams,
		async execute(_id, raw) {
			const params = raw as MessageInput;
			const check = messageCheck(tc, MAIN, params);
			const result = await tc.team.send(MAIN, params.to, params.text, { expectReply: params.expectReply === true, ...(check ? { check } : {}) });
			if (!result.ok) throw new Error(result.error);
			const tail = params.expectReply && result.delivered !== "replied" ? " Its answer will wake you." : "";
			return withRoster(text(`${deliveredWords[result.delivered] ?? "Delivered."}${tail}${result.notice ? `\n${result.notice}` : ""}`, { to: params.to, delivered: result.delivered, ...(result.notice ? { notice: result.notice } : {}) }), tc.team);
		},
	} as ToolDefinition;
}

/** Stops a subagent `self` started (or one under it); main can stop any. */
export function stopTool(tc: Pick<ToolContext, "team">, self: string): ToolDefinition {
	return {
		name: "stop_subagent",
		label: "Stop subagent",
		description: stopDescription(self !== MAIN),
		promptSnippet: "Stop a subagent whose work is no longer needed",
		parameters: stopParams,
		async execute(_id, raw) {
			const result = await stopFor(tc.team, self, (raw as { name: string }).name);
			return self === MAIN ? withRoster(result, tc.team) : result;
		},
	} as ToolDefinition;
}

async function stopFor(team: HostTeam, self: string, name: string): Promise<Result> {
	if (name === EVERYONE) return stopAll(team, self);
	const record = team.get(name);
	if (!record) throw new Error(`No agent named ${name}.`);
	if (!team.under(name, self)) throw new Error(`${name} is not one of your subagents; you can stop only agents you started.`);
	const stopped = await team.stop(name, { by: self });
	if (!stopped) return text(`${name} had already ${record.state === "idle" ? "finished" : record.state}; nothing to stop.`, { name, state: record.state });
	return text(`Stopped ${name}. ${reportText(stopped, Date.now())}\n\nMessage it to resume it with its context.`, { name, state: stopped.state, ...(stopped.sessionFile ? { sessionFile: stopped.sessionFile } : {}) });
}

/** Main's own results end with its team as it is now (status.ts), so it needs no turn to ask. */
function withRoster(result: Result, team: HostTeam): Result {
	const [first, ...rest] = result.content;
	return { ...result, content: [{ type: "text", text: `${first?.text ?? ""}\n\n${teamNow(team.list(), Date.now())}` }, ...rest] };
}

async function stopAll(team: HostTeam, self: string): Promise<Result> {
	const mine = team.list().filter((record) => record.parent === self && (LIVE_STATES.has(record.state) || record.state === "interrupted"));
	if (mine.length === 0) return text("No subagents of yours are running.", { stopped: [] });
	const stopped: string[] = [];
	for (const record of stopOrder(mine)) if (await team.stop(record.name, { by: self })) stopped.push(record.name);
	return text(`Stopped ${stopped.length} ${stopped.length === 1 ? "subagent" : "subagents"}: ${stopped.join(", ")}. Their last messages are in their sessions; no reports follow.`, { stopped });
}

export function childMessageTool(tc: ToolContext, self: string): ToolDefinition {
	return {
		name: "message",
		label: "Message",
		description: childMessageDescription(tc.replyTimeoutMs),
		parameters: messageParams,
		async execute(_id, raw, signal) {
			const params = raw as MessageInput;
			const check = messageCheck(tc, self, params);
			const result = await tc.team.send(self, params.to, params.text, { expectReply: params.expectReply === true, ...(signal ? { signal } : {}), ...(check ? { check } : {}) });
			if (!result.ok) throw new Error(result.error);
			const roster = rosterText(self, tc.team.list().map((r) => ({ name: r.name, task: r.task, state: r.state, model: r.model })));
			const head = result.reply !== undefined ? `Reply from ${params.to}:\n${result.reply}` : deliveredWords[result.delivered] ?? "Delivered.";
			const tail = params.expectReply && result.reply === undefined ? " Its answer will arrive as a message; keep working." : "";
			return text(`${head}${tail}${result.notice ? `\n${result.notice}` : ""}\n\nTeam now:\n${roster}`, { to: params.to, delivered: result.delivered });
		},
	} as ToolDefinition;
}
