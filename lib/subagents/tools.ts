/**
 * The `subagent` and `message` tool definitions, for main and for children.
 * They are thin: validation and wording here, behavior in the team.
 */
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { childMessageDescription, mainMessageDescription, subagentDescription } from "./describe.ts";
import { reportText, rosterText } from "./format.ts";
import { isThinking, type ModelChoice, resolveModel, THINKING_LEVELS, type Thinking, thinkingFor, type ThinkingSettings } from "./models.ts";
import { MAIN } from "./names.ts";
import type { Team } from "./team.ts";
import type { AgentRecord } from "./types.ts";

export const MAX_TASK_CHARS = 60_000;
export const MAX_MESSAGE_CHARS = 20_000;
const PROGRESS_MS = 1_000;

export interface ToolContext {
	team: Team;
	allowed: readonly ModelChoice[];
	/** Used when the call names no model: the configured default, else the parent's. */
	fallbackModel: string | null;
	thinking: ThinkingSettings;
	modelTable: string;
	guide: string;
	replyTimeoutMs: number;
	now(): number;
}

type Result = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> | undefined };
const text = (value: string, details?: Record<string, unknown>): Result => ({ content: [{ type: "text", text: value }], details });

const thinkingSchema = Type.Union(THINKING_LEVELS.map((level) => Type.Literal(level)), { description: "Reasoning level; omit for the model's usual level." });

const subagentParams = Type.Object({
	task: Type.String({ minLength: 1, maxLength: MAX_TASK_CHARS, description: "The complete brief: goal, relevant files and facts, constraints, and what the report must contain." }),
	name: Type.Optional(Type.String({ maxLength: 40, description: "Short name that says what it does, like auth-review or count-md. You, the user and other agents address it by this name." })),
	model: Type.Optional(Type.String({ description: "Model reference or unique short name from the list above." })),
	thinking: Type.Optional(thinkingSchema),
	readOnly: Type.Optional(Type.Boolean({ description: "No file edits or shell commands." })),
	context: Type.Optional(Type.Union([Type.Literal("fresh"), Type.Literal("fork")], { description: "fork gives it this conversation so far; default fresh." })),
	wait: Type.Optional(Type.Boolean({ description: "Block until it finishes and return its report. Only for short checks." })),
}, { additionalProperties: false });

const messageParams = Type.Object({
	to: Type.String({ minLength: 1, description: "An agent's name, or \"all\"." }),
	text: Type.String({ minLength: 1, maxLength: MAX_MESSAGE_CHARS }),
	expectReply: Type.Optional(Type.Boolean({ description: "Ask for an answer." })),
}, { additionalProperties: false });

interface SubagentInput { task: string; name?: string; model?: string; thinking?: string; readOnly?: boolean; context?: string; wait?: boolean }
interface MessageInput { to: string; text: string; expectReply?: boolean }

function spawnSummary(record: AgentRecord): string {
	const thinking = record.thinking ? `, thinking ${record.thinking}` : "";
	const where = record.state === "queued" ? "It is queued behind other subagents and starts when a slot frees." : "It is running in the background.";
	return `Started ${record.name} on ${record.model}${thinking}. ${where} Its report will arrive as a message. Talk to it with message({ to: "${record.name}", text }).`;
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
			const spawned = tc.team.spawn({
				task: params.task.trim(), parent, model: resolved.choice.ref, readOnly: params.readOnly === true, fork,
				blocking: params.wait === true, ...(params.name ? { name: params.name } : {}), ...(thinking ? { thinking } : {}),
			});
			if (!spawned.ok) throw new Error(spawned.error);
			const record = spawned.record;
			// Status Plus finds the child's session through this path and counts its usage.
			const details = {
				name: record.name, model: record.model, thinking: record.thinking ?? null, wait: params.wait === true,
				...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
			};
			if (params.wait !== true) return text(spawnSummary(record), details);
			return await waitFor(tc, record.name, details, signal, onUpdate as ((update: Result) => void) | undefined);
		},
	} as ToolDefinition;
}

async function waitFor(tc: ToolContext, name: string, details: Record<string, unknown>, signal: AbortSignal | undefined,
	onUpdate: ((update: Result) => void) | undefined): Promise<Result> {
	let last = 0;
	const stopProgress = tc.team.onChange((record) => {
		if (!record || record.name !== name || !onUpdate) return;
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
		const done = await Promise.race([tc.team.whenDone(name), aborted]);
		if (done === null) {
			tc.team.detach(name);
			return text(`Stopped waiting. ${name} keeps running in the background and its report will arrive as a message.`, { ...details, detached: true });
		}
		// Later runs (after a message resumes it) report as messages.
		tc.team.detach(name);
		const failed = done.state !== "idle";
		const result = text(reportText(done, tc.now()), { ...details, state: done.state });
		if (failed) throw new Error(result.content[0]!.text);
		return result;
	} finally {
		stopProgress();
		if (onAbort) signal?.removeEventListener("abort", onAbort);
	}
}

const deliveredWords: Record<string, string> = {
	replied: "Answered; it continues with your reply.",
	steered: "Delivered; it reads it after its current tool call.",
	resumed: "It had finished; it resumed with its context to handle this.",
	queued: "It has not started yet; it reads this when it does.",
	inbox: "It had finished; this waits for its next run.",
	main: "Delivered to main.",
};

export function mainMessageTool(tc: ToolContext): ToolDefinition {
	return {
		name: "message",
		label: "Message",
		description: mainMessageDescription(),
		promptSnippet: "Message a running or finished subagent",
		parameters: messageParams,
		async execute(_id, raw) {
			const params = raw as MessageInput;
			const result = await tc.team.send(MAIN, params.to, params.text, { expectReply: params.expectReply === true });
			if (!result.ok) throw new Error(result.error);
			const tail = params.expectReply && result.delivered !== "replied" ? " Its answer will wake you." : "";
			return text(`${deliveredWords[result.delivered] ?? "Delivered."}${tail}`, { to: params.to, delivered: result.delivered });
		},
	} as ToolDefinition;
}

export function childMessageTool(tc: ToolContext, self: string): ToolDefinition {
	return {
		name: "message",
		label: "Message",
		description: childMessageDescription(tc.replyTimeoutMs),
		parameters: messageParams,
		async execute(_id, raw, signal) {
			const params = raw as MessageInput;
			const result = await tc.team.send(self, params.to, params.text, { expectReply: params.expectReply === true, ...(signal ? { signal } : {}) });
			if (!result.ok) throw new Error(result.error);
			const roster = rosterText(self, tc.team.list().map((r) => ({ name: r.name, task: r.task, state: r.state, model: r.model })));
			const head = result.reply !== undefined ? `Reply from ${params.to}:\n${result.reply}` : deliveredWords[result.delivered] ?? "Delivered.";
			return text(`${head}\n\nTeam now:\n${roster}`, { to: params.to, delivered: result.delivered });
		},
	} as ToolDefinition;
}
