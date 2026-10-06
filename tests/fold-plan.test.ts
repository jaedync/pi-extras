import assert from "node:assert/strict";
import { test } from "node:test";
import { planFold, type PlanItem } from "../lib/fold/plan.ts";

const item = (kind: PlanItem["kind"], height = 2): PlanItem => ({ kind, height });

test("consecutive tool rows and quiet replies fold into one group at the first member", () => {
	const plan = planFold([item("visible"), item("tool"), item("work"), item("tool"), item("visible")]);
	assert.deepEqual(plan.groups.map((group) => group.members), [[1, 2, 3]]);
	assert.deepEqual(plan.entries, [{ kind: "item", index: 0 }, { kind: "group", group: 0 }, { kind: "item", index: 4 }]);
});

test("a visible reply splits the work into two groups", () => {
	const plan = planFold([item("tool"), item("visible"), item("tool"), item("tool")]);
	assert.deepEqual(plan.groups.map((group) => group.members), [[0], [2, 3]]);
	assert.deepEqual(plan.entries.map((entry) => entry.kind), ["group", "item", "group"]);
});

test("a spacer between members is dropped, and one before a visible row stays with it", () => {
	const plan = planFold([item("tool"), item("spacer", 1), item("tool"), item("spacer", 1), item("visible")]);
	assert.deepEqual(plan.groups[0]!.members, [0, 2]);
	assert.deepEqual(plan.groups[0]!.dropped, [1]);
	assert.deepEqual(plan.entries, [{ kind: "group", group: 0 }, { kind: "item", index: 3 }, { kind: "item", index: 4 }]);
});

test("a visible row that draws nothing does not split a group", () => {
	const plan = planFold([item("tool"), item("visible", 0), item("tool")]);
	assert.deepEqual(plan.groups.map((group) => group.members), [[0, 2]]);
	assert.deepEqual(plan.entries, [{ kind: "group", group: 0 }, { kind: "item", index: 1 }]);
});

test("spacers before the first member and at the end are kept", () => {
	const plan = planFold([item("spacer", 1), item("tool"), item("spacer", 1)]);
	assert.deepEqual(plan.entries, [{ kind: "item", index: 0 }, { kind: "group", group: 0 }, { kind: "item", index: 2 }]);
});

test("a transcript with no work has no groups", () => {
	const plan = planFold([item("spacer", 1), item("visible")]);
	assert.deepEqual(plan.groups, []);
	assert.deepEqual(plan.entries, [{ kind: "item", index: 0 }, { kind: "item", index: 1 }]);
});

test("the last group knows it is last", () => {
	const plan = planFold([item("tool"), item("visible"), item("work")]);
	assert.deepEqual(plan.groups.map((group) => group.last), [false, true]);
	const closed = planFold([item("tool"), item("visible")]);
	assert.equal(closed.groups[0]!.last, false);
});

test("a notice Pi adds during a run stays in place but does not split the group", () => {
	const plan = planFold([item("tool"), item("spacer", 1), item("note", 1), item("tool")]);
	assert.deepEqual(plan.groups.map((group) => group.members), [[0, 3]]);
	assert.deepEqual(plan.entries, [{ kind: "group", group: 0 }, { kind: "item", index: 1 }, { kind: "item", index: 2 }]);
	assert.equal(plan.groups[0]!.last, true, "a group with only notices after it may still grow");
	const before = planFold([item("note", 1), item("tool")]);
	assert.deepEqual(before.entries, [{ kind: "item", index: 0 }, { kind: "group", group: 0 }]);
});
