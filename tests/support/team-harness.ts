/**
 * A Team behind a fake launcher: children finish or fail only when a test says
 * so, and each child's transcript outlives its session, as a session file does.
 */
import assert from "node:assert/strict";
import { Team, type TeamOptions } from "../../lib/subagents/team.ts";
import type { AgentRecord, ChildHandle, ChildHooks, MainDelivery, SpawnRequest } from "../../lib/subagents/types.ts";

export interface Call { text: string; model: string; finish(result: string): void; fail(error: Error): void }

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

type HarnessOptions = Partial<TeamOptions> & {
	sessionDir?: string;
	transcripts?: Map<string, unknown[]>;
	/** A launch error for this record, as a model the runtime can't resolve gives. */
	refuse?: (record: AgentRecord) => Error | undefined;
};

export function teamHarness(options: HarnessOptions = {}) {
	const { sessionDir = "/sessions", transcripts = new Map<string, unknown[]>(), refuse, ...teamOptions } = options;
	const calls = new Map<string, Call[]>();
	const steered = new Map<string, string[]>();
	const hooks = new Map<string, ChildHooks>();
	const launched: Array<{ name: string; model: string }> = [];
	const main: MainDelivery[] = [];
	const say = (name: string, message: unknown) => transcripts.set(name, [...(transcripts.get(name) ?? []), message]);
	const team = new Team({
		maxConcurrent: 4, maxDepth: 2, replyTimeoutMs: 60_000,
		deliverToMain: (delivery) => main.push(delivery),
		messagesFor: (record) => transcripts.get(record.name) ?? [],
		launcher: {
			async launch(record: AgentRecord, childHooks: ChildHooks): Promise<ChildHandle> {
				launched.push({ name: record.name, model: record.model });
				const refused = refuse?.(record);
				if (refused) throw refused;
				hooks.set(record.name, childHooks);
				return {
					sessionFile: `${sessionDir}/${record.name}.jsonl`,
					prompt: (text) => new Promise<void>((resolve, reject) => {
						say(record.name, user(text));
						calls.set(record.name, [...(calls.get(record.name) ?? []), {
							text, model: record.model, fail: reject,
							finish: (result) => { say(record.name, { role: "assistant", content: [{ type: "text", text: result }] }); resolve(); },
						}]);
					}),
					steer: (text) => steered.set(record.name, [...(steered.get(record.name) ?? []), text]),
					abort: async () => undefined,
					lastText: () => undefined,
					messages: () => transcripts.get(record.name) ?? [],
					takeQueued: () => [],
					dispose: async () => undefined,
				};
			},
		},
		...teamOptions,
	});
	const spawn = (task: string, extra: Partial<SpawnRequest> = {}) => {
		const result = team.spawn({ task, parent: "main", model: "openai-codex/gpt-6-luna", readOnly: false, fork: false, blocking: false, ...extra });
		assert.ok(result.ok, !result.ok ? result.error : "");
		return result.record.name;
	};
	const lastCall = (name: string) => calls.get(name)!.at(-1)!;
	/** The child reads the first `count` steered messages between tool calls, as Pi does. */
	const read = (name: string, count: number) => {
		const queue = steered.get(name) ?? [];
		for (const text of queue.slice(0, count)) say(name, user(text));
		steered.set(name, queue.slice(count));
		hooks.get(name)?.update({ activity: "thinking" });
	};
	return { team, calls, steered, hooks, launched, main, transcripts, spawn, lastCall, read };
}
