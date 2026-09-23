/**
 * Runs the Computer Use client as a one-shot launchd job in the user's desktop
 * session, wired to private FIFOs.
 *
 * The Computer Use service only answers a client whose "responsible" process is
 * OpenAI's signed codex helper. A launchd job is its own responsible process, so
 * the job runs `codex sandbox` with the client as its child. The same holds from
 * a local terminal and over SSH, where a directly spawned child would be
 * attributed to sshd. The pattern matches voice's desktop capture.
 */
import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { closeSync, constants, createReadStream, createWriteStream, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { ClientProcess } from "./mcp-link.ts";

export const JOB_LABEL_PREFIX = "com.pi-extras.computer-use.";
const RUN_DIR_PREFIX = "pi-extras-computer-use-";
const LAUNCHCTL = "/bin/launchctl";
/** How long to look for the job's pid after launchd accepts it. */
const PID_WAIT_MS = 2_000;
const PID_POLL_MS = 25;

const domain = () => `gui/${process.getuid?.() ?? 0}`;

function launchctl(args: string[]): Promise<{ ok: boolean; output: string }> {
	return new Promise((resolve) => {
		execFile(LAUNCHCTL, args, { encoding: "utf8", timeout: 5_000 }, (error, stdout, stderr) => resolve({ ok: !error, output: `${stdout}${stderr}` }));
	});
}

/** True when someone is logged in to this Mac's desktop, so launchd can start jobs there. */
export function guiSessionAvailable(): boolean {
	return process.platform === "darwin" && spawnSync(LAUNCHCTL, ["print", domain()], { stdio: "ignore", timeout: 3_000 }).status === 0;
}

const xml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function jobPlist(job: { label: string; command: string; args: readonly string[]; env: Readonly<Record<string, string>>; runDir: string }): string {
	const strings = [job.command, ...job.args].map((value) => `<string>${xml(value)}</string>`).join("");
	const env = Object.entries(job.env).map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`).join("");
	const pipe = (name: string) => `<string>${xml(join(job.runDir, name))}</string>`;
	// No KeepAlive: a client that exits must stay down, never respawn into closed pipes.
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(job.label)}</string>
<key>ProgramArguments</key><array>${strings}</array>
<key>WorkingDirectory</key><string>${xml(job.runDir)}</string>
<key>EnvironmentVariables</key><dict>${env}</dict>
<key>StandardInPath</key>${pipe("stdin")}
<key>StandardOutPath</key>${pipe("stdout")}
<key>StandardErrorPath</key>${pipe("stderr")}
<key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Interactive</string>
</dict></plist>
`;
}

/** Labels from `launchctl list` whose owning Pi process no longer exists. */
export function staleLabels(listing: string, alive: (pid: number) => boolean): string[] {
	const pattern = new RegExp(`^${JOB_LABEL_PREFIX.replace(/\./g, "\\.")}(\\d+)\\.[0-9a-f]+$`);
	return listing.split("\n").map((line) => line.split("\t")[2]?.trim() ?? "")
		.filter((label) => { const pid = label.match(pattern)?.[1]; return pid !== undefined && !alive(Number(pid)); });
}

function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Unloads jobs and run directories left behind by a Pi that died mid-call. */
export async function sweepStaleJobs(alive: (pid: number) => boolean = processAlive): Promise<void> {
	const listing = await launchctl(["list"]);
	await Promise.all(staleLabels(listing.output, alive).map((label) => launchctl(["bootout", `${domain()}/${label}`])));
	for (const entry of readdirSync(tmpdir())) {
		const pid = entry.startsWith(RUN_DIR_PREFIX) ? Number(entry.slice(RUN_DIR_PREFIX.length).split("-")[0]) : NaN;
		if (Number.isInteger(pid) && !alive(pid)) rmSync(join(tmpdir(), entry), { recursive: true, force: true });
	}
}

/** Opening a FIFO blocks a libuv thread until the other end opens; opening it read-write releases that. */
function releaseFifo(fifo: string): void {
	try { closeSync(openSync(fifo, constants.O_RDWR | constants.O_NONBLOCK)); } catch { /* already gone */ }
}

class GuiJob extends EventEmitter implements ClientProcess {
	readonly stdin: Writable;
	readonly stdout: Readable;
	readonly stderr: Readable;
	pid?: number;
	private readonly unload: () => Promise<void>;

	constructor(stdin: Writable, stdout: Readable, stderr: Readable, unload: () => Promise<void>) {
		super();
		this.stdin = stdin;
		this.stdout = stdout;
		this.stderr = stderr;
		this.unload = unload;
	}

	kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
		if (this.pid === undefined) { void this.unload(); return true; }
		try { process.kill(this.pid, signal); return true; } catch { void this.unload(); return false; }
	}
}

export async function spawnGuiJob(command: string, args: readonly string[], env: Readonly<Record<string, string>>): Promise<ClientProcess> {
	const runDir = mkdtempSync(join(tmpdir(), `${RUN_DIR_PREFIX}${process.pid}-`));
	const label = `${JOB_LABEL_PREFIX}${process.pid}.${randomBytes(4).toString("hex")}`;
	const fifos = ["stdin", "stdout", "stderr"].map((name) => join(runDir, name));
	const made = spawnSync("/usr/bin/mkfifo", ["-m", "600", ...fifos], { encoding: "utf8", timeout: 3_000 });
	if (made.status !== 0) {
		rmSync(runDir, { recursive: true, force: true });
		throw new Error(`could not create the Computer Use pipes: ${(made.stderr ?? "").trim()}`);
	}
	const plistPath = join(runDir, "job.plist");
	writeFileSync(plistPath, jobPlist({ label, command, args, env, runDir }), { mode: 0o600 });

	let unloaded: Promise<void> | undefined;
	const unload = () => unloaded ??= launchctl(["bootout", `${domain()}/${label}`]).then(() => rmSync(runDir, { recursive: true, force: true }));

	// Open our ends first: launchd opens the other ends while starting the job.
	const stdout = createReadStream(fifos[1]);
	const stderr = createReadStream(fifos[2]);
	const stdin = createWriteStream(fifos[0]);
	const loaded = await launchctl(["bootstrap", domain(), plistPath]);
	if (!loaded.ok) {
		fifos.forEach(releaseFifo);
		for (const stream of [stdout, stderr, stdin]) stream.destroy();
		rmSync(runDir, { recursive: true, force: true });
		throw new Error(`launchd refused the Computer Use job: ${loaded.output.trim()}`);
	}

	const job = new GuiJob(stdin, stdout, stderr, unload);
	for (let waited = 0; job.pid === undefined && waited < PID_WAIT_MS; waited += PID_POLL_MS) {
		const printed = await launchctl(["print", `${domain()}/${label}`]);
		const pid = printed.output.match(/^\s*pid = (\d+)$/m)?.[1];
		if (pid) job.pid = Number(pid);
		else if (/last exit code = \d+/.test(printed.output) && !/never exited/.test(printed.output)) break;
		else await new Promise((resolve) => setTimeout(resolve, PID_POLL_MS));
	}

	let open = 2;
	const finished = async () => {
		if (--open > 0) return;
		const printed = await launchctl(["print", `${domain()}/${label}`]);
		const code = printed.output.match(/last exit code = (-?\d+)/)?.[1];
		// A finished job stays loaded until booted out; no label may outlive its session.
		await unload();
		job.emit("close", code === undefined ? null : Number(code));
	};
	stdout.once("close", () => void finished());
	stderr.once("close", () => void finished());
	return job;
}
