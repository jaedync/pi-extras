/** The launcher script with a fake `pi`: exit codes, arguments, restarts, the loop guard, `pi update` and Ctrl+C. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LAUNCHER_MARKER, renderLauncher } from "../lib/auto-update/launcher.ts";

interface Rig {
	readonly root: string;
	readonly store: string;
	readonly launcher: string;
	readonly log: string;
}

/** A fake Pi: logs its argv (one argument per line, runs split by "--"), then acts on FAKE_MODE. */
const FAKE_PI = `#!/bin/sh
log="$FAKE_LOG"
printf '%s\\n' "--- run" >> "$log"
for arg in "$@"; do printf '[%s]\\n' "$arg" >> "$log"; done
printf 'token=%s\\n' "$PI_EXTRAS_RESTART_TOKEN" >> "$log"
printf 'note=%s\\n' "\${PI_EXTRAS_UPDATE_DONE-unset}" >> "$log"
printf 'skip=%s\\n' "\${PI_SKIP_VERSION_CHECK-unset}" >> "$log"
printf 'store=%s\\n' "\${PI_EXTRAS_UPDATE_STORE-unset}" >> "$log"
printf 'self=%s\\n' "$0" >> "$log"
printf 'restarts=%s target=%s\\n' "\${PI_EXTRAS_RESTART_COUNT-unset}" "\${PI_EXTRAS_RESTART_TARGET-unset}" >> "$log"
[ -r /proc/$$/status ] && grep SigIgn /proc/$$/status >> "$log"
runs=$(grep -c -- '--- run' "$log")
case "$FAKE_MODE" in
	exit7) exit 7 ;;
	restart-once)
		# Lines: the session, the note, the target, then one replayed argument per line.
		if [ "$runs" = 1 ]; then mkdir -p "$FAKE_STORE/restart"; printf '%s\\n' "/sessions/a b.jsonl" "Updated: Pi 1.4.1" "T1" "--model" "x y" "it's" "*" '$HOME' "" "--offline" > "$FAKE_STORE/restart/$PI_EXTRAS_RESTART_TOKEN"; fi
		exit 0 ;;
	restart-always)
		mkdir -p "$FAKE_STORE/restart"; printf '%s\\n' "/sessions/s.jsonl" "" "T1" > "$FAKE_STORE/restart/$PI_EXTRAS_RESTART_TOKEN"; exit 3 ;;
	restart-two-targets)
		mkdir -p "$FAKE_STORE/restart"; printf '%s\\n' "/sessions/s.jsonl" "" "T$runs" > "$FAKE_STORE/restart/$PI_EXTRAS_RESTART_TOKEN"; [ "$runs" -lt 3 ] || rm -f "$FAKE_STORE/restart/$PI_EXTRAS_RESTART_TOKEN"; exit 0 ;;
	wait-int)
		trap 'printf "%s\\n" got-int >> "$log"; exit 5' INT
		printf '%s\\n' ready >> "$log"
		while :; do sleep 0.05; done ;;
esac
exit 0
`;

function rig(t: test.TestContext, withCurrent = true): Rig {
	const root = mkdtempSync(join(tmpdir(), "au-launcher-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const store = join(root, "store with 'quote");
	const fake = join(store, "pi", "1.0.0", "bin");
	mkdirSync(fake, { recursive: true });
	writeFileSync(join(fake, "pi"), FAKE_PI);
	chmodSync(join(fake, "pi"), 0o755);
	if (withCurrent) symlinkSync("pi/1.0.0", join(store, "pi-current"));
	const fallback = join(root, "fallback-pi");
	writeFileSync(fallback, '#!/bin/sh\nprintf "%s\\n" "--- fallback $*" >> "$FAKE_LOG"\nexit 4\n');
	chmodSync(fallback, 0o755);
	const extras = join(root, "extras");
	mkdirSync(join(extras, "lib", "auto-update"), { recursive: true });
	// Slow on purpose: the launcher must not wait for it. It logs its priority, to show the check runs niced.
	writeFileSync(join(extras, "lib", "auto-update", "cli.ts"), 'import { appendFileSync } from "node:fs"; import { getPriority } from "node:os"; setTimeout(() => { appendFileSync(process.env.FAKE_LOG, `cli ${process.argv.slice(2).join(" ")} nice=${getPriority()}\\n`); process.exit(9); }, 1500);\n');
	const launcher = join(root, "bin", "pi");
	mkdirSync(join(root, "bin"));
	writeFileSync(launcher, renderLauncher({ store, fallbackPi: fallback, fallbackExtras: extras, node: process.execPath }));
	chmodSync(launcher, 0o755);
	return { root, store, launcher, log: join(root, "log") };
}

function launch(r: Rig, args: string[], mode: string): { done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>; pid: number } {
	const child = spawn(r.launcher, args, { env: { PATH: process.env.PATH, FAKE_LOG: r.log, FAKE_MODE: mode, FAKE_STORE: r.store }, stdio: ["ignore", "ignore", "pipe"], detached: true });
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
	return { pid: child.pid!, done: new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal, stderr }))) };
}

const runs = (r: Rig) => readFileSync(r.log, "utf8").split("--- run\n").slice(1);

test("the launcher carries its marker on the second line and fills in its paths", () => {
	const text = renderLauncher({ store: "/s/it's", fallbackPi: "/p", fallbackExtras: "/e", node: "/n" });
	assert.equal(text.split("\n")[1], LAUNCHER_MARKER);
	assert.match(text, /STORE='\/s\/it'\\''s'/);
	assert.doesNotMatch(text, /@[A-Z_]+@/);
});

test("the exit code passes through and every argument arrives unchanged", async (t) => {
	const r = rig(t);
	const args = ["--mode", "rpc", "a b", "it's", "$HOME", "*", "", "line\nbreak", "-p"];
	const { done } = launch(r, args, "exit7");
	const result = await done;
	assert.equal(result.code, 7);
	const [run] = runs(r);
	assert.ok(run!.startsWith(args.map((arg) => `[${arg}]\n`).join("")), run);
	assert.match(run!, /token=[0-9a-f]{16}\n/);
});

test("a restart request starts Pi again on the session with the replayed options, once", async (t) => {
	const r = rig(t);
	const result = await launch(r, ["--model", "x", "--continue", "hello"], "restart-once").done;
	assert.equal(result.code, 0);
	const [first, second] = runs(r);
	assert.ok(first!.startsWith("[--model]\n[x]\n[--continue]\n[hello]\n"));
	// Exactly the replayed list, then the session: spaces, quotes, globs, "$HOME" and an empty argument unchanged.
	assert.ok(second!.startsWith("[--model]\n[x y]\n[it's]\n[*]\n[$HOME]\n[]\n[--offline]\n[--session]\n[/sessions/a b.jsonl]\ntoken="), second);
	assert.equal(first!.match(/token=(\w+)/)?.[1], second!.match(/token=(\w+)/)?.[1], "the token stays for the restarted Pi");
	assert.match(first!, /note=unset\n/);
	assert.match(second!, /note=Updated: Pi 1\.4\.1\n/, "line 2 of the request goes to the restarted Pi");
	assert.match(first!, /restarts=unset target=unset\n/);
	assert.match(second!, /restarts=1 target=T1\n/, "Pi learns how often the launcher restarted it for this target");
	assert.equal(runs(r).length, 2);
	assert.equal(existsSync(join(r.store, "restart", first!.match(/token=(\w+)/)![1]!)), false, "the request is consumed");
	assert.match(result.stderr, /starting Pi again for the update/);
});

test("the restart count goes up for the same target and starts again for a new one", async (t) => {
	const r = rig(t);
	await launch(r, [], "restart-two-targets").done;
	assert.deepEqual(runs(r).map((run) => run.match(/restarts=(\S+) target=(\S+)/)!.slice(1).join(" ")), ["unset unset", "1 T1", "1 T2"]);
});

test("Pi gets the launcher's store and runs from the real folder that pi-current names", async (t) => {
	const r = rig(t);
	await launch(r, [], "exit7").done;
	const [run] = runs(r);
	assert.match(run!, new RegExp(`store=${r.store.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\n`));
	// The real path, so /proc/<pid>/cmdline names the release folder that GC must keep.
	assert.equal(run!.match(/self=(.*)\n/)?.[1], join(realpathSync(r.store), "pi", "1.0.0", "bin", "pi"));
});

test("more than 3 restarts in 60 s stop the loop with Pi's exit code", async (t) => {
	const r = rig(t);
	const result = await launch(r, [], "restart-always").done;
	assert.equal(result.code, 3);
	assert.equal(runs(r).length, 4, "the first run and 3 restarts");
	assert.match(runs(r)[3]!, /restarts=3 target=T1\n/);
	assert.match(result.stderr, /restarted 3 times in 60 s\. No more restarts\. To continue, run: pi --session \/sessions\/s\.jsonl/);
});

test("pi update starts a forced check in the background with a low priority and returns at once", async (t) => {
	const r = rig(t);
	const started = Date.now();
	const result = await launch(r, ["update", "--all"], "exit7").done;
	assert.ok(Date.now() - started < 1_200, "the launch does not wait for the check");
	assert.equal(result.code, 0);
	assert.match(result.stderr, /^pi-extras: Pi and its packages update automatically\. An update check started in the background\. Use \/pi-extras update in Pi to see the result\.\n$/);
	assert.equal(existsSync(r.log), false, "Pi did not run");
	const deadline = Date.now() + 10_000;
	while (!existsSync(r.log) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
	const line = readFileSync(r.log, "utf8").match(/^cli check --force nice=(\d+)\n$/);
	assert.ok(line, readFileSync(r.log, "utf8"));
	if (existsSync("/usr/bin/nice") || existsSync("/bin/nice")) assert.ok(Number(line[1]) >= 10, `niced: ${line[1]}`);
});

test("Pi's own update banner is off only while the store says that auto-update manages Pi", async (t) => {
	const r = rig(t);
	await launch(r, [], "exit7").done;
	writeFileSync(join(r.store, "pi-managed"), "");
	await launch(r, [], "exit7").done;
	const [without, managed] = runs(r);
	assert.match(without!, /skip=unset\n/, "pi: \"skip\" or no marker: the user manages Pi and keeps the banner");
	assert.match(managed!, /skip=1\n/);
});

test("without pi-current the launcher starts the Pi it replaced and says so", async (t) => {
	const r = rig(t, false);
	const result = await launch(r, ["list"], "exit7").done;
	assert.equal(result.code, 4);
	assert.equal(readFileSync(r.log, "utf8"), "--- fallback list\n");
	assert.match(result.stderr, /pi-current is missing\. Starting .*fallback-pi/);
});

test("Ctrl+C reaches Pi and does not end the launcher; Pi does not inherit an ignored SIGINT", { skip: process.platform === "win32" }, async (t) => {
	const r = rig(t);
	const { pid, done } = launch(r, [], "wait-int");
	const deadline = Date.now() + 10_000;
	while (!(existsSync(r.log) && readFileSync(r.log, "utf8").includes("ready")) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
	// The terminal sends SIGINT to the whole foreground process group.
	process.kill(-pid, "SIGINT");
	const result = await done;
	assert.equal(result.signal, null, "the launcher was not killed by SIGINT");
	assert.equal(result.code, 5, "the launcher exits with Pi's code after Pi handled Ctrl+C");
	assert.match(readFileSync(r.log, "utf8"), /got-int/);
	const ignored = readFileSync(r.log, "utf8").match(/SigIgn:\s+([0-9a-f]+)/)?.[1];
	if (ignored) assert.equal(BigInt(`0x${ignored}`) & 2n, 0n, "SIGINT is not ignored in Pi");
});
