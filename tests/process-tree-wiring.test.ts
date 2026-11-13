/**
 * The bash tool that Tool Display gives the main session, and the one a
 * subagent gets, both end a setsid child at the end of the call.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import * as sdk from "@earendil-works/pi-coding-agent";
import { productionDeps } from "../lib/tool-display/index.ts";
import { childBash } from "../lib/subagents/child.ts";
import { scopeSupported, treeKillOn } from "../lib/process-tree.ts";
import { killMarked, marker as mark, survivors } from "./support/process-marks.ts";

const marker = () => mark(3000);
const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

type Execute = (id: string, params: { command: string; timeout?: number }, signal?: AbortSignal) => Promise<{ content: { text: string }[] }>;
const linux = process.platform === "linux";
// The tree operations are on by default on Linux only; PI_TREE_KILL=1 turns them on elsewhere.
// Off Linux the fallback misses this command's escaped child (tests/process-tree.test.ts a2), so the check is for Linux.
const on = !treeKillOn() ? "the tree operations are off here" : linux ? false : "the fallback off Linux misses a child that left the group before the first scan";
// GNU timeout moves to a group of its own; the echo keeps bash from exec'ing it.
const escaping = (value: string) => `timeout 400 sh -c 'trap "" TERM; sleep ${value}' & sleep 0.3; echo started; cat /proc/self/cgroup 2>/dev/null`;
const SCOPE = linux && scopeSupported();
const GUIDELINE = /end when the call ends.*shell job.*systemd-run --user --unit/;

/** The call ran in a scope of its own where one can start, and the end named what it ended. */
function ranInTree(text: string): void {
	assert.match(text, /started/);
	if (SCOPE) assert.match(text, /\/pi-bash-\d+-[0-9a-f]+\.scope$/m);
	assert.match(text, /Ended \d+ background process(es)? when the call ended: /);
}

test("Tool Display's bash ends a process that left the call's group", { skip: on, timeout: 20_000 }, async () => {
	const value = marker();
	const dir = mkdtempSync(join(tmpdir(), "tree-wiring-"));
	dirs.push(dir);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
	try {
		const ctx = { cwd: dir, isProjectTrusted: () => false } as unknown as Parameters<ReturnType<typeof productionDeps>["tools"]>[0];
		const tools = productionDeps().tools(ctx, (operations) => operations);
		assert.ok((tools.definitions.bash.promptGuidelines ?? []).some((line) => GUIDELINE.test(line)), "the bash guideline names the way to keep a process");
		const result = await (tools.definitions.bash.execute as unknown as Execute)("w1", { command: escaping(value) });
		ranInTree(result.content[0]!.text);
		assert.deepEqual(await survivors(value), []);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		killMarked(value);
	}
});

test("a subagent's bash ends a process that left the call's group", { skip: on, timeout: 20_000 }, async () => {
	const value = marker();
	const dir = mkdtempSync(join(tmpdir(), "tree-wiring-"));
	dirs.push(dir);
	try {
		const record = { name: "w", parent: "main", depth: 1, task: "t" } as unknown as Parameters<typeof childBash>[3];
		const deps = {} as unknown as Parameters<typeof childBash>[4];
		const definition = childBash(sdk, dir, sdk.SettingsManager.inMemory(), record, deps, undefined);
		assert.ok((definition.promptGuidelines ?? []).some((line) => GUIDELINE.test(line)), "the bash guideline names the way to keep a process");
		const result = await (definition.execute as unknown as Execute)("w2", { command: escaping(value) });
		ranInTree(result.content[0]!.text);
		assert.deepEqual(await survivors(value), []);
	} finally { killMarked(value); }
});
