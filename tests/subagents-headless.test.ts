import { test } from "node:test";
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { awaitChildren, isHeadless } from "../lib/subagents/headless.ts";

/** A team whose live list and change listeners the test drives, and mail that records what was taken. */
function fakes() {
	let live: unknown[] = [{ name: "scout" }];
	const listeners = new Set<(record: null) => void>();
	let waiting = false;
	const taken: string[] = [];
	const team = { live: () => live as never, onChange: (listener: (record: null) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
	const mail = {
		waiting: () => waiting,
		takeAll: () => {
			taken.push("all");
			return { messages: [{ customType: "subagent-report", content: "r", display: true, details: { id: "1" } }] as never, wakes: true };
		},
	};
	return {
		team, mail, taken, listeners,
		finish: () => { live = []; for (const listener of listeners) listener(null); },
		mailArrives: () => { waiting = true; },
	};
}

test("only print and json runs are headless", () => {
	assert.deepEqual(["print", "json", "tui", "rpc", undefined].map(isHeadless), [true, true, false, false, false]);
});

test("main waits until its children are done, then takes their mail as boundary entries", async () => {
	const f = fakes();
	let settled = false;
	const handover = awaitChildren(f.team, f.mail).then((value) => { settled = true; return value; });
	await sleep(20);
	assert.equal(settled, false, "a child is still working");
	f.finish();
	const result = await handover;
	assert.deepEqual(result, { entries: [{ type: "custom_message", customType: "subagent-report", content: "r", display: true, details: { id: "1" } }], wakes: true });
	assert.equal(f.listeners.size, 0, "it stops listening once done");
});

test("mail for main ends the wait while children still work, so a child asking main gets its answer", async () => {
	const f = fakes();
	const handover = awaitChildren(f.team, f.mail);
	f.mailArrives();
	const result = await handover;
	assert.equal(result.wakes, true);
	assert.deepEqual(f.taken, ["all"]);
});
