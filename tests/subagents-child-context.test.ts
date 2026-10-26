import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHILD_INSTRUCTIONS_FILE, childContextFiles, projectRoot } from "../lib/subagents/child-context.ts";

function layout() {
	const dir = mkdtempSync(join(tmpdir(), "child-context-"));
	const agentDir = join(dir, "agent");
	const dev = join(dir, "dev");
	const repo = join(dev, "repo");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(repo, ".git"), { recursive: true });
	mkdirSync(join(repo, "pkg"), { recursive: true });
	const files = [
		{ path: join(agentDir, "AGENTS.md"), content: "global" },
		{ path: join(dev, "AGENTS.md"), content: "workspace" },
		{ path: join(repo, "AGENTS.md"), content: "repo" },
		{ path: join(repo, "pkg", "AGENTS.md"), content: "pkg" },
	];
	return { dir, agentDir, dev, repo, files };
}

test("the project root is the nearest directory with .git, else the cwd itself", () => {
	const { dir, dev, repo } = layout();
	try {
		assert.equal(projectRoot(join(repo, "pkg")), repo);
		assert.equal(projectRoot(repo), repo);
		assert.equal(projectRoot(dev), dev);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("without a child file the context files stay as Pi loaded them", () => {
	const { dir, agentDir, repo, files } = layout();
	try {
		assert.deepEqual(childContextFiles(files, { agentDir, cwd: join(repo, "pkg"), full: false }), files);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("the child file replaces the global file, and files above the project root drop out", () => {
	const { dir, agentDir, repo, files } = layout();
	try {
		writeFileSync(join(agentDir, CHILD_INSTRUCTIONS_FILE), "lean\n");
		const lean = childContextFiles(files, { agentDir, cwd: join(repo, "pkg"), full: false });
		assert.deepEqual(lean, [
			{ path: join(agentDir, CHILD_INSTRUCTIONS_FILE), content: "lean\n" },
			{ path: join(repo, "AGENTS.md"), content: "repo" },
			{ path: join(repo, "pkg", "AGENTS.md"), content: "pkg" },
		]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a cwd outside git keeps its own file; full keeps everything", () => {
	const { dir, agentDir, dev, files } = layout();
	try {
		writeFileSync(join(agentDir, CHILD_INSTRUCTIONS_FILE), "lean\n");
		const atDev = files.slice(0, 2);
		assert.deepEqual(childContextFiles(atDev, { agentDir, cwd: dev, full: false }).map((file) => file.content), ["lean\n", "workspace"]);
		assert.deepEqual(childContextFiles(files, { agentDir, cwd: dev, full: true }), files);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an empty child file counts as none", () => {
	const { dir, agentDir, repo, files } = layout();
	try {
		writeFileSync(join(agentDir, CHILD_INSTRUCTIONS_FILE), "  \n");
		assert.deepEqual(childContextFiles(files, { agentDir, cwd: repo, full: false }), files);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
