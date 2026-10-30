/**
 * Every command that wv prints for the user to run quotes each path, so a name
 * with a space, a quote or a newline cannot become part of the command.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { quoteArg } from "../skills/walkthrough-video/scripts/lib/shell.mjs";

test("quoteArg quotes one argument for a POSIX shell", () => {
	assert.equal(quoteArg("plain"), "'plain'");
	assert.equal(quoteArg("with space"), "'with space'");
	assert.equal(quoteArg("it's"), "'it'\\''s'");
	assert.equal(quoteArg("$(touch /tmp/wv-quote-pwned)"), "'$(touch /tmp/wv-quote-pwned)'");
	assert.equal(quoteArg("`id`"), "'`id`'");
	assert.equal(quoteArg("line\nbreak"), "'line\nbreak'");
});

test("the printed rm -rf removes the leftover and not a folder that its words name", () => {
	const dir = mkdtempSync(join(tmpdir(), "wv-quote-"));
	try {
		const leftover = join(dir, ".music-kit.staging-music-kit-2147483647-abc123 left over");
		mkdirSync(leftover, { recursive: true });
		writeFileSync(join(leftover, "x"), "x");
		mkdirSync(join(dir, "over"), { recursive: true });
		writeFileSync(join(dir, "over", "user-data"), "keep me");
		const result = spawnSync("sh", ["-c", `rm -rf -- ${quoteArg(leftover)}`], { encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		assert.equal(existsSync(leftover), false, "the leftover is gone");
		assert.equal(readFileSync(join(dir, "over", "user-data"), "utf8"), "keep me", "the unrelated folder is kept");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
