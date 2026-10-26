/** The launcher script with a fake `pi`: exit codes, arguments, restarts, the loop guard, `pi update` and Ctrl+C. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
[ -r /proc/$$/status ] && grep SigIgn /proc/$$/status >> "$log"
runs=$(grep -c -- '--- run' "$log")
case "$FAKE_MODE" in
	exit7) exit 7 ;;
	restart-once)
		if [ "$runs" = 1 ]; then mkdir -p "$FAKE_STORE/restart"; printf '%s\\n%s\\n' "/sessions/a b.jsonl" "Updated: Pi 1.4.1" > "$FAKE_STORE/restart/$PI_EXTRAS_RESTART_TOKEN"; fi
		exit 0 ;;
	restart-always)
		mkdir -p "$FAKE_STORE/restart"; printf '%s\\n' "/sessions/s.jsonl" > "$FAKE_STORE/restart/$PI_EXTRAS_RESTART_TOKEN"; exit 3 ;;
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
	writeFileSync(join(extras, "lib", "auto-update", "cli.ts"), 'import { appendFileSync } from "node:fs"; appendFileSync(process.env.FAKE_LOG, `cli ${process.argv.slice(2).join(" ")}\\n`); process.exit(9);\n');
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

test("a restart request starts Pi again on the session, once", async (t) => {
	const r = rig(t);
	const result = await launch(r, ["--model", "x"], "restart-once").done;
	assert.equal(result.code, 0);
	const [first, second] = runs(r);
	assert.ok(first!.startsWith("[--model]\n[x]\n"));
	assert.ok(second!.startsWith("[--session]\n[/sessions/a b.jsonl]\ntoken="), second);
	assert.equal(first!.match(/token=(\w+)/)?.[1], second!.match(/token=(\w+)/)?.[1], "the token stays for the restarted Pi");
	assert.match(first!, /note=unset\n/);
	assert.match(second!, /note=Updated: Pi 1\.4\.1\n/, "line 2 of the request goes to the restarted Pi");
	assert.equal(runs(r).length, 2);
	assert.equal(existsSync(join(r.store, "restart", first!.match(/token=(\w+)/)![1]!)), false, "the request is consumed");
	assert.match(result.stderr, /starting Pi again for the update/);
});

test("more than 3 restarts in 60 s stop the loop with Pi's exit code", async (t) => {
	const r = rig(t);
	const result = await launch(r, [], "restart-always").done;
	assert.equal(result.code, 3);
	assert.equal(runs(r).length, 4, "the first run and 3 restarts");
	assert.match(result.stderr, /restarted 3 times in 60 s\. No more restarts\. To continue, run: pi --session \/sessions\/s\.jsonl/);
});

test("pi update runs a forced update check instead", async (t) => {
	const r = rig(t);
	const result = await launch(r, ["update", "--all"], "exit7").done;
	assert.equal(result.code, 9);
	assert.equal(readFileSync(r.log, "utf8"), "cli check --force\n");
	assert.match(result.stderr, /update automatically/);
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
