// Fixture helpers for the untangle-codebase tests: temp folders and git repos.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLI = join(dirname(fileURLToPath(import.meta.url)), "../skills/untangle-codebase/scripts/untangle.mjs");

const temps = [];

export function tempDir() {
	const dir = mkdtempSync(join(tmpdir(), "untangle-test-"));
	temps.push(dir);
	return dir;
}

export function removeTemps() {
	temps.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }));
}

export function put(root, files) {
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), text);
	}
}

export const git = (root, ...args) => execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });

export function gitInit(root) {
	git(root, "init", "-q");
	git(root, "config", "user.name", "t");
	git(root, "config", "user.email", "t@example.invalid");
	git(root, "config", "commit.gpgsign", "false");
}

export function commit(root, files, message = "change") {
	put(root, files);
	git(root, "add", "-A");
	git(root, "commit", "-qm", message);
}
