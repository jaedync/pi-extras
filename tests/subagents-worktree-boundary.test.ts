import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { outsideWorktree } from "../lib/subagents/worktree.ts";

const worktree = { path: "/tmp/repo.worktrees/scout", branch: "subagent/scout", base: "a".repeat(40) };
const cwd = worktree.path;

test("edits inside the worktree pass", () => {
	for (const path of ["src/a.ts", "./README.md", "/tmp/repo.worktrees/scout/lib/b.ts", "lib/../c.ts", "..notes.md", "@src/a.ts", "."]) {
		assert.equal(outsideWorktree(worktree, cwd, path), undefined, path);
	}
});

test("edits outside the worktree are refused with a message that names it", () => {
	for (const path of ["../scout-2/a.ts", "/tmp/repo/src/a.ts", "/tmp/repo.worktrees/scout-2/a.ts", "lib/../../x.ts", "~/notes.md", "~", "@../x.ts", "file:///tmp/repo/a.ts"]) {
		const error = outsideWorktree(worktree, cwd, path);
		assert.match(error ?? "", /is outside your worktree \/tmp\/repo\.worktrees\/scout\. Edit only files inside it/, path);
	}
	assert.match(outsideWorktree(worktree, cwd, "~/notes.md") ?? "", new RegExp(`^${join(homedir(), "notes.md").replace(/[.]/g, "\\.")} is outside`));
});

test("a path that is not text is left to the tool to refuse", () => {
	assert.equal(outsideWorktree(worktree, cwd, undefined), undefined);
	assert.equal(outsideWorktree(worktree, cwd, 3), undefined);
});

test("an edit through a symlink out of the worktree is refused; one that stays inside passes", (t) => {
	const dir = mkdtempSync(join(tmpdir(), "subagent-boundary-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	const root = join(dir, "repo");
	mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
	const tree = { ...worktree, path: join(dir, "repo.worktrees", "scout") };
	mkdirSync(join(tree.path, "src"), { recursive: true });
	symlinkSync(join(root, "node_modules"), join(tree.path, "node_modules"), "dir");
	symlinkSync(join(root, "missing.txt"), join(tree.path, "dangling.txt"));
	symlinkSync(join(tree.path, "src"), join(tree.path, "alias"), "dir");
	const real = realpathSync(root);
	for (const path of ["node_modules/pkg/index.js", "node_modules/new/dir/file.js", "node_modules", "dangling.txt"]) {
		const error = outsideWorktree(tree, tree.path, path);
		assert.match(error ?? "", new RegExp(`resolves to ${real.replace(/[.]/g, "\\.")}/.*, outside your worktree`), path);
	}
	for (const path of ["src/a.ts", "alias/a.ts", "new/dir/a.ts", join(tree.path, "README.md")]) {
		assert.equal(outsideWorktree(tree, tree.path, path), undefined, path);
	}
});
