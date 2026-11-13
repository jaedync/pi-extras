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
import { killMarked, marker as mark, survivors } from "./support/process-marks.ts";

const marker = () => mark(3000);
const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });

type Execute = (id: string, params: { command: string; timeout?: number }, signal?: AbortSignal) => Promise<{ content: { text: string }[] }>;
const linux = process.platform === "linux";
// GNU timeout moves to a group of its own; the echo keeps bash from exec'ing it.
const escaping = (value: string) => `timeout 400 sh -c 'trap "" TERM; sleep ${value}' & sleep 0.3; echo started`;

test("Tool Display's bash ends a process that left the call's group", { skip: linux ? false : "the check reads /proc", timeout: 20_000 }, async () => {
	const value = marker();
	const dir = mkdtempSync(join(tmpdir(), "tree-wiring-"));
	dirs.push(dir);
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = join(dir, "agent");
	try {
		const ctx = { cwd: dir, isProjectTrusted: () => false } as unknown as Parameters<ReturnType<typeof productionDeps>["tools"]>[0];
		const tools = productionDeps().tools(ctx, (operations) => operations);
		const result = await (tools.definitions.bash.execute as unknown as Execute)("w1", { command: escaping(value) });
		assert.match(result.content[0]!.text, /started/);
		assert.deepEqual(await survivors(value), []);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		killMarked(value);
	}
});

test("a subagent's bash ends a process that left the call's group", { skip: linux ? false : "the check reads /proc", timeout: 20_000 }, async () => {
	const value = marker();
	const dir = mkdtempSync(join(tmpdir(), "tree-wiring-"));
	dirs.push(dir);
	try {
		const record = { name: "w", parent: "main", depth: 1, task: "t" } as unknown as Parameters<typeof childBash>[3];
		const deps = {} as unknown as Parameters<typeof childBash>[4];
		const definition = childBash(sdk, dir, sdk.SettingsManager.inMemory(), record, deps, undefined);
		const result = await (definition.execute as unknown as Execute)("w2", { command: escaping(value) });
		assert.match(result.content[0]!.text, /started/);
		assert.deepEqual(await survivors(value), []);
	} finally { killMarked(value); }
});
