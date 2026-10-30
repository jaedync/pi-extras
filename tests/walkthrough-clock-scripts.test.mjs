/**
 * The clock install script of a capture: one replacement chain, so an advance
 * and a navigation never interleave, and the new script exists before the old
 * one is removed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createClockScripts } from "../skills/walkthrough-video/scripts/lib/clock-scripts.mjs";

/** A CDP session that records calls and answers after a tick, as a real one does. */
function fakeCdp() {
	const calls = [];
	let next = 0;
	return {
		calls,
		send: async (method, params) => {
			await new Promise((resolve) => setTimeout(resolve, 2));
			calls.push([method, params]);
			if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: `script-${++next}` };
			return {};
		},
	};
}

test("two concurrent replacements leave exactly one active script, and add before remove", async () => {
	const cdp = fakeCdp();
	const scripts = createClockScripts({ send: cdp.send, source: (ms) => `start ${ms}` });
	await scripts.replace(1000);
	const before = cdp.calls.length;
	// An advance and a navigation at the same time: both go through the one queue.
	await Promise.all([scripts.replace(2000), scripts.replace(3000)]);
	const added = cdp.calls.slice(before).filter(([method]) => method === "Page.addScriptToEvaluateOnNewDocument");
	const removed = cdp.calls.slice(before).filter(([method]) => method === "Page.removeScriptToEvaluateOnNewDocument");
	assert.equal(added.length, 2, "two new scripts");
	assert.deepEqual(added.map(([, params]) => params.source), ["start 2000", "start 3000"], "in call order");
	assert.equal(removed.length, 2, "each replacement removes exactly the script before it");
	assert.equal(scripts.active(), "script-3", "one identifier is active at the end");
	// The add of a replacement comes before its remove.
	const second = cdp.calls.findIndex(([method, params]) => method === "Page.addScriptToEvaluateOnNewDocument" && params.source === "start 3000");
	const lastRemove = cdp.calls.map(([method]) => method).lastIndexOf("Page.removeScriptToEvaluateOnNewDocument");
	assert.ok(second >= 0 && second < lastRemove, "the new script is added before the old one is removed");
});

test("a failed replacement is reported and does not stop the next one", async () => {
	const said = [];
	let fail = true;
	const calls = [];
	const scripts = createClockScripts({
		send: async (method, params) => {
			if (method === "Page.addScriptToEvaluateOnNewDocument" && fail) {
				fail = false;
				throw new Error("CDP is busy");
			}
			calls.push(method);
			if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "script-1" };
			return {};
		},
		source: (ms) => `start ${ms}`,
		log: (line) => said.push(line),
	});
	// The caller sees the failure, so the pump can stop; the queue itself survives.
	await assert.rejects(scripts.replace(1000), /CDP is busy/);
	assert.match(said.join(""), /the start time was not updated: CDP is busy/);
	await scripts.replace(2000);
	assert.equal(scripts.active(), "script-1", "the next replacement works");
	assert.ok(calls.includes("Page.addScriptToEvaluateOnNewDocument"));
});

test("reversed CDP replies cannot leave the older script installed (F4)", async () => {
	// The first add answers slowly, the second quickly: without one queue the older
	// reply wins and the page keeps the earlier start time.
	const installed = new Map();
	let next = 0;
	const send = async (method, params) => {
		// The older time answers slowly, the newer one quickly: a shared queue is the only order.
		const delay = params.source === "start 2000" ? 40 : 1;
		await new Promise((resolve) => setTimeout(resolve, delay));
		if (method === "Page.addScriptToEvaluateOnNewDocument") {
			const id = `script-${++next}`;
			installed.set(id, params.source);
			return { identifier: id };
		}
		if (method === "Page.removeScriptToEvaluateOnNewDocument") {
			installed.delete(params.identifier);
			return {};
		}
		return {};
	};
	const scripts = createClockScripts({ send, source: (ms) => `start ${ms}` });
	await scripts.replace(1000);
	// Two concurrent updates, as an advance and a navigation make.
	await Promise.all([scripts.replace(2000), scripts.replace(3000)]);
	assert.equal(installed.size, 1, `exactly one script is installed: ${[...installed.values()].join(", ")}`);
	assert.deepEqual([...installed.values()], ["start 3000"], "the newest start time is the one a new document gets");
	assert.equal(scripts.active(), [...installed.keys()][0], "the active identifier is the installed one");
});
