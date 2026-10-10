import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { killGroup, track } from "../lib/link-context/media/children.ts";

test("a tracked process group is killed with its children", async () => {
	const child = spawn("sh", ["-c", "sleep 30 & sleep 30; wait"], { detached: true, stdio: "ignore" });
	const untrack = track(child.pid);
	await new Promise((resolve) => setTimeout(resolve, 200));
	const before = spawnSync("pgrep", ["-g", String(child.pid)], { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
	assert.ok(before.length >= 2, "the shell and its sleeps share the group");
	killGroup(child.pid);
	await new Promise((resolve) => child.on("exit", resolve));
	await new Promise((resolve) => setTimeout(resolve, 200));
	const after = spawnSync("pgrep", ["-g", String(child.pid)], { encoding: "utf8" }).stdout.trim();
	assert.equal(after, "", "no process of the group is left");
	untrack();
	killGroup(undefined);
});

test("Pi's exit kills groups that are still running", () => {
	const script = `
		import { spawn } from "node:child_process";
		import { track } from ${JSON.stringify(new URL("../lib/link-context/media/children.ts", import.meta.url).href)};
		const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
		track(child.pid);
		console.log(child.pid);
		process.exit(0);
	`;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	const pid = Number(result.stdout.trim());
	spawnSync("sleep", ["0.2"]);
	assert.throws(() => process.kill(pid, 0), /ESRCH/, "the detached child did not outlive its parent");
});
