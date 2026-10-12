/** A reviewer and an implementer iterate directly; main is woken once, for the final report. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick, setTimeout as sleep } from "node:timers/promises";
import { MainMail } from "../lib/subagents/deliver.ts";
import { subagentDescription } from "../lib/subagents/describe.ts";
import { childInstructions } from "../lib/subagents/format.ts";
import type { MainDelivery } from "../lib/subagents/types.ts";
import { teamHarness } from "./support/team-harness.ts";

const settled = async () => { for (let i = 0; i < 6; i++) await tick(); };

test("main's subagent tool and the child instructions say to iterate directly and report at the end", () => {
	const main = subagentDescription({ models: "", defaultModel: null, guide: "", forChild: false });
	assert.match(main, /For a review or fix loop, tell the agents to message each other by name and report to you only at the end, so you are not woken for each round\./);
	const child = childInstructions({ name: "review", parent: "main", readOnly: true, canSpawn: false, roster: "" });
	assert.match(child, /- In a review or fix loop, message the other agent by name with expectReply: true, so your report waits for its answer, and report to main only when the loop ends\./);
});

test("two review rounds between peers wake main once, and their notes never reach it", async () => {
	const delivered: MainDelivery[] = [];
	const wakes: string[] = [];
	const mail = new MainMail({ batchMs: 5, port: { send: (message, options) => { if (options.triggerTurn) wakes.push(message.content); } } });
	const h = teamHarness({ deliverToMain: (delivery) => { delivered.push(delivery); mail.deliver(delivery); } });
	const impl = h.spawn("Implement the parser", { name: "impl" });
	const review = h.spawn("Review impl's parser; iterate with impl until it is right", { name: "review", after: [impl] });
	await tick();
	h.lastCall(impl).finish("Implemented v1.");
	await settled();
	assert.equal(h.team.get(review)!.state, "running");
	for (const round of [1, 2]) {
		assert.deepEqual(await h.team.send(review, impl, `Finding ${round}: fix it.`, { expectReply: true }), { ok: true, delivered: "resumed" });
		h.lastCall(review).finish(`Sent finding ${round}.`);
		await settled();
		assert.equal(h.team.get(review)!.state, "waiting", "its report waits for impl's answer");
		assert.equal(h.team.get(impl)!.state, "running");
		assert.match(h.lastCall(impl).text, new RegExp(`Question from review[\\s\\S]*Finding ${round}`));
		assert.ok((await h.team.send(impl, review, `Fixed finding ${round}.`)).ok);
		h.lastCall(impl).finish(`Fixed finding ${round}.`);
		await settled();
		assert.equal(h.team.get(review)!.state, "running", "impl's answer resumes review");
		assert.match(h.lastCall(review).text, new RegExp(`Message from impl:\\nFixed finding ${round}`));
	}
	h.lastCall(review).finish("Approved: the parser is right.");
	await h.team.whenDone(review);
	await sleep(30);
	assert.deepEqual(delivered.filter((d) => d.kind !== "report").map((d) => d.kind), [], "no note between them reaches main");
	const reports = delivered.filter((d): d is Extract<MainDelivery, { kind: "report" }> => d.kind === "report");
	assert.deepEqual(reports.map((d) => [d.record.name, d.quiet === true]), [["impl", true], ["impl", true], ["impl", true], ["review", false]]);
	assert.equal(wakes.length, 1, "one turn for main");
	assert.match(wakes[0]!, /Approved: the parser is right\./);
	mail.dispose();
	await h.team.close();
});
