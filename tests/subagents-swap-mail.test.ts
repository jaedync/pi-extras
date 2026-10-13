/**
 * Mail a swap carries to its new session reaches the child once and in order,
 * whatever becomes of the new launch: it works, falls back, fails, is stopped,
 * or the session closes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { Team } from "../lib/subagents/team.ts";
import type { ChildHandle } from "../lib/subagents/types.ts";

const settled = async () => { for (let i = 0; i < 12; i++) await tick(); };

function harness(fallbackModels: string[]) {
	const transcript: unknown[] = [];
	const prompts: string[][] = [];
	const resolvers: Array<() => void> = [];
	const queues: string[][] = [];
	const gates: Array<{ go: () => void; fail: (e: Error) => void }> = [];
	let launches = 0;
	let stale = false;
	const team = new Team({
		maxConcurrent: 4, maxDepth: 2, replyTimeoutMs: 60_000, warn: () => undefined, deliverToMain: () => undefined, fallbackModels,
		launcher: {
			async launch(): Promise<ChildHandle> {
				const id = launches++;
				if (id > 0) await new Promise<void>((resolve, reject) => { gates[id] = { go: resolve, fail: reject }; });
				prompts[id] = []; queues[id] = [];
				return {
					sessionFile: "/sessions/impl.jsonl", stamp: { generation: id, files: [] },
					prompt: (text: string) => new Promise<void>((resolve) => { transcript.push({ role: "user", content: [{ type: "text", text }] }); prompts[id]!.push(text); resolvers[id] = resolve; }),
					steer: (text: string) => { queues[id]!.push(text); },
					abort: async () => undefined, lastText: () => undefined, messages: () => transcript,
					takeQueued: () => queues[id]!.splice(0), dispose: async () => undefined,
				};
			},
			current: (handle) => !(stale && handle.stamp?.generation === 0),
			codeCurrent: (handle) => !(stale && handle.stamp?.generation === 0),
		},
	});
	return { team, transcript, prompts, resolvers, gates, makeStale: () => { stale = true; } };
}

const order = (text: string, words: string[]) => words.map((w) => text.indexOf(w));

async function swapWithM1M2(h: ReturnType<typeof harness>) {
	assert.ok(h.team.spawn({ name: "impl", task: "Task", parent: "main", model: "m", readOnly: false, fork: false, blocking: false }).ok);
	await settled();
	await h.team.send("main", "impl", "M1");
	h.makeStale();
	h.transcript.push({ role: "assistant", content: [{ type: "text", text: "Done, I think." }] });
	assert.equal((h.team as unknown as { turnEnded(name: string): boolean }).turnEnded("impl"), true);
	h.resolvers[0]!();
	await settled();
	assert.equal(h.team.get("impl")!.state, "starting");
	await h.team.send("main", "impl", "M2");
}

function check(prompt: string, words: string[]) {
	const at = order(prompt, words);
	assert.ok(at.every((i) => i >= 0) && at.every((v, i) => i === 0 || at[i - 1]! < v), `order ${at}: ${prompt}`);
	for (const m of words) assert.equal(prompt.split(m).length, 2, `${m} once`);
}

test("swap carries M1, M2 comes during the launch, the launch fails with no fallback, then main resumes with M4", async () => {
	const h = harness([]);
	await swapWithM1M2(h);
	h.gates[1]!.fail(new Error("unknown model m"));
	await settled();
	await h.team.send("main", "impl", "M4"); await settled();
	h.gates[2]?.go(); await settled();
	const prompt = (h.prompts[2] ?? []).join("\n\n");
	check(prompt, ["M1", "M2", "M4"]);
	await h.team.close();
});

test("swap carries M1 to a fallback; M2 during the launch; a stop parks it; M3 resumes: M1, M2, M3", async () => {
	const h = harness(["fb/model"]);
	await swapWithM1M2(h);
	h.gates[1]!.fail(new Error("503 overloaded"));
	await settled();
	await h.team.stop("impl"); await settled();
	h.gates[2]?.go(); await settled();
	await h.team.send("main", "impl", "M3"); await settled();
	const last = h.gates.length - 1;
	h.gates[last]!.go(); await settled();
	const prompt = (h.prompts[last] ?? []).join("\n\n");
	check(prompt, ["M1", "M2", "M3"]);
	await h.team.close();
});

test("swap carries M1; M2 during the launch; close parks it: the inbox keeps M1, M2 in order", async () => {
	const h = harness([]);
	await swapWithM1M2(h);
	h.team.interrupt("quit");
	check((h.team.get("impl")!.inbox ?? []).join("\n\n"), ["M1", "M2"]);
	h.gates[1]!.go(); await settled();
});

test("swap carries M1; the launch fails and the fallback launch works: M1 once", async () => {
	const h = harness(["fb/model"]);
	await swapWithM1M2(h);
	h.gates[1]!.fail(new Error("503 overloaded"));
	await settled();
	h.gates[2]!.go(); await settled();
	const prompt = (h.prompts[2] ?? []).join("\n\n");
	check(prompt, ["M1", "M2"]);
	await h.team.close();
});

test("swap carries M1; a stop during the swap launch: the inbox has M1 once", async () => {
	const h = harness([]);
	await swapWithM1M2(h);
	await h.team.stop("impl"); await settled();
	check((h.team.get("impl")!.inbox ?? []).join("\n\n"), ["M1", "M2"]);
	h.gates[1]!.go(); await settled();
});

test("swap carries M1; close during the swap launch: the record no longer lists M1 as unread, so a restore can't add it again", async () => {
	const h = harness([]);
	await swapWithM1M2(h);
	h.team.interrupt("quit");
	const record = h.team.get("impl")!;
	assert.ok(!(record.unread ?? []).some((t) => t.includes("M1")), "M1 is both in the inbox and unread");
	h.gates[1]!.go(); await settled();
});
