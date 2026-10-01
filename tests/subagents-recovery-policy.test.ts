import { test } from "node:test";
import assert from "node:assert/strict";
import { recoveryDecision, recoveryOwner } from "../lib/subagents/recovery.ts";
import { NO_USAGE, type AgentRecord } from "../lib/subagents/types.ts";

const r = (patch: Partial<AgentRecord> = {}): AgentRecord => ({ name: "helper", parent: "main", depth: 1, model: "faux/cheap", task: "Original task",
	readOnly: false, fork: false, blocking: false, state: "interrupted", createdAt: 1, activity: "bash sleep 30", runs: 1, toolCalls: 0, usage: NO_USAGE,
	interruptedBy: "reload", interruptionId: "reload-1", interruptedOwner: "owner", autoResumeAttempts: 0, ...patch });
const decide = (record: AgentRecord, patch: Record<string, unknown> = {}) => recoveryDecision(record, {
	reason: "reload", policy: "reload", shutdown: "reload", shutdownOwner: "owner", owner: "owner", allowed: new Set(["faux/cheap"]), moved: false, ...patch,
} as any);

test("reload owner identity survives a runtime reload but distinguishes concurrent SDK parents", () => {
	const manager = {};
	assert.equal(recoveryOwner(manager), recoveryOwner(manager));
	assert.notEqual(recoveryOwner(manager), recoveryOwner({}));
});

test("only this owner's immediately preceding reload is auto-resumed", () => {
	assert.equal(decide(r()).resume, true);
	assert.equal(decide(r({ interruptedBy: "signal" })).resume, false, "crash then reload stays paused");
	assert.equal(decide(r(), { shutdown: "quit" }).resume, false);
	assert.equal(decide(r(), { shutdownOwner: "other" }).resume, false, "a lease-conflict parent's reload cannot resume the other parent's work");
	assert.equal(decide(r({ interruptedBy: undefined, interruptionId: undefined })).resume, false, "legacy aborted sessions never auto-resume");
	assert.equal(decide(r({ interruptedBy: undefined, interruptionId: undefined }), { policy: "always" }).resume, false);
	assert.equal(decide(r({ orphaned: true })).resume, false, "orphans never auto-resume");
});

test("always has one attempt per interruption and grandchildren remain explicitly resumable", () => {
	assert.equal(decide(r({ interruptedBy: "signal" }), { reason: "startup", policy: "always" }).resume, true);
	assert.equal(decide(r({ autoResumeAttempts: 1 }), { reason: "startup", policy: "always" }).resume, false);
	assert.match(decide(r({ parent: "lead", depth: 2 })).why, /parent|subagents resume/);
	assert.equal(decide(r({ parent: "lead", depth: 2 })).resume, false);
});

test("moved workspaces and out-of-scope models pause with actionable reasons", () => {
	assert.match(decide(r(), { moved: true }).why, /workspace/);
	assert.equal(decide(r(), { moved: true }).resume, false);
	assert.match(decide(r({ model: "old/model" })).why, /scope.*default/i);
	assert.equal(decide(r({ model: "old/model" })).resume, false);
});
