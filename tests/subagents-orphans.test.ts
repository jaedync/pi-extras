import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverOrphans } from "../lib/subagents/restore.ts";
import { commandCompletions } from "../lib/subagents/names.ts";

test("unindexed session files become named resumable orphans with their model and task", () => {
	const dir = mkdtempSync(join(tmpdir(), "child-orphans-"));
	try {
		const file = join(dir, "2026-10-01T03-27-03-559Z_hard-tasks_9e880e7b.jsonl");
		writeFileSync(file, "synthetic");
		const records = discoverOrphans(dir, [], () => [
			{ type: "model_change", provider: "faux", modelId: "cheap" },
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "Check the worktree" }] } },
			{ type: "message", message: { role: "assistant", stopReason: "aborted", content: [] } },
		]);
		assert.equal(records[0]?.name, "hard-tasks");
		assert.equal(records[0]?.task, "Check the worktree");
		assert.equal(records[0]?.model, "faux/cheap");
		assert.equal(records[0]?.state, "interrupted");
		assert.equal(records[0]?.orphaned, true);
		assert.deepEqual(discoverOrphans(dir, records, () => []), []);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test("resume command completes restored names", () => {
	assert.deepEqual(commandCompletions("resume h", ["helper"]), [{ value: "resume helper", label: "resume helper" }]);
});
