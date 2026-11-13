/**
 * The tree operations (bash and shell-jobs) are on by default on Linux only.
 * PI_TREE_KILL=1 turns them on elsewhere (not Windows); PI_TREE_KILL=0 turns
 * them off on Linux. When they are off, Pi's own bash operations run, and the
 * bash tool gets no extra guideline.
 */
import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { treeKillOn } from "../lib/process-tree.ts";
import { TREE_GUIDELINE, treeBashOperations, withTreeGuideline } from "../lib/tree-bash.ts";

const saved = process.env.PI_TREE_KILL;
const platform = Object.getOwnPropertyDescriptor(process, "platform");
afterEach(() => {
	if (saved === undefined) delete process.env.PI_TREE_KILL;
	else process.env.PI_TREE_KILL = saved;
	if (platform) Object.defineProperty(process, "platform", platform);
});

function asPlatform(name: NodeJS.Platform): void {
	Object.defineProperty(process, "platform", { ...platform, value: name });
}

const piOps = { exec: async () => ({ exitCode: 0 }) } as unknown as BashOperations;
const sdk = {
	createLocalBashOperations: () => piOps,
	getShellConfig: () => ({ shell: "/bin/bash", args: ["-c"] }),
};
const definition = { name: "bash", promptGuidelines: ["one"] };

test("the platform default: on for Linux, off for macOS and Windows", () => {
	assert.equal(treeKillOn({}, "linux"), true);
	assert.equal(treeKillOn({}, "darwin"), false);
	assert.equal(treeKillOn({}, "win32"), false);
	assert.equal(treeKillOn({ PI_TREE_KILL: "" }, "darwin"), false);
});

test("PI_TREE_KILL=1 turns them on for macOS, not for Windows", () => {
	assert.equal(treeKillOn({ PI_TREE_KILL: "1" }, "darwin"), true);
	assert.equal(treeKillOn({ PI_TREE_KILL: "1" }, "freebsd"), true);
	assert.equal(treeKillOn({ PI_TREE_KILL: "1" }, "win32"), false);
});

test("PI_TREE_KILL=0 turns them off on Linux", () => {
	assert.equal(treeKillOn({ PI_TREE_KILL: "0" }, "linux"), false);
});

test("the default reads process.env and process.platform", () => {
	delete process.env.PI_TREE_KILL;
	asPlatform("darwin");
	assert.equal(treeKillOn(), false);
	process.env.PI_TREE_KILL = "1";
	assert.equal(treeKillOn(), true);
	asPlatform("linux");
	process.env.PI_TREE_KILL = "0";
	assert.equal(treeKillOn(), false);
});

test("macOS by default: Pi's own bash operations and no guideline", () => {
	delete process.env.PI_TREE_KILL;
	asPlatform("darwin");
	assert.equal(treeBashOperations(sdk, undefined), piOps);
	assert.equal(withTreeGuideline(definition), definition);
});

test("macOS with PI_TREE_KILL=1: the tree operations and the guideline", () => {
	process.env.PI_TREE_KILL = "1";
	asPlatform("darwin");
	assert.notEqual(treeBashOperations(sdk, undefined), piOps);
	assert.deepEqual(withTreeGuideline(definition).promptGuidelines, ["one", TREE_GUIDELINE]);
});

test("Linux by default: the tree operations and the guideline", () => {
	delete process.env.PI_TREE_KILL;
	asPlatform("linux");
	assert.notEqual(treeBashOperations(sdk, undefined), piOps);
	assert.deepEqual(withTreeGuideline(definition).promptGuidelines, ["one", TREE_GUIDELINE]);
});

test("Linux with PI_TREE_KILL=0: Pi's own bash operations and no guideline", () => {
	process.env.PI_TREE_KILL = "0";
	asPlatform("linux");
	assert.equal(treeBashOperations(sdk, undefined), piOps);
	assert.equal(withTreeGuideline(definition), definition);
});
