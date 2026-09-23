/**
 * Microphone capture for Pi running over SSH on a Mac. macOS attributes
 * microphone access to whatever started the session; over SSH that is sshd,
 * which can never be granted access and silently receives zeros. Running
 * ffmpeg as a launchd job in the logged-in desktop session gives it its own
 * identity, which the user allows once on the Mac. ffmpeg streams PCM into a
 * private Unix socket that this process listens on.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { avfoundationInput, FRAME_SAMPLES, FrameChunker, type Capture, type CaptureCallbacks } from "./capture.ts";

export type Launchctl = (args: string[]) => Promise<{ code: number; stderr: string }>;

export interface DesktopCaptureOptions {
	readonly home: string;
	/** Absolute path: launchd jobs do not inherit the shell's PATH. */
	readonly ffmpeg: string;
	readonly uid: number;
	/** Mic to open by name; absent records from the system default. */
	readonly device?: string;
	/** Name of the mic that will record, for the indicator. */
	readonly deviceName?: string;
	readonly pid?: number;
	readonly launchctl?: Launchctl;
	readonly alive?: (pid: number) => boolean;
}

type Env = Readonly<Record<string, string | undefined>>;

const LABEL_PREFIX = "com.pi-extras.voice.capture.";
const JOB_FILE = /^capture-(\d+)-(\d+)\.(plist|sock|log)$/;
const LOG_TAIL_CHARS = 300;
const FFMPEG_FALLBACKS = ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"];

export const DESKTOP_BLOCKED_HINT =
	"no audio from the Mac's microphone over SSH: on the Mac, click Allow for ffmpeg, or turn it on in System Settings › Privacy & Security › Microphone";
const NO_DESKTOP = "Pi is running over SSH, and the Mac's microphone needs someone logged in to its desktop";
const NEEDS_FFMPEG = "Pi is running over SSH; voice records through the Mac's desktop session with ffmpeg (brew install ffmpeg)";

let sequence = 0;

export function isRemoteSession(env: Env): boolean {
	return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY);
}

export function captureRoute(platform: NodeJS.Platform, env: Env): "desktop" | "local" {
	return platform === "darwin" && isRemoteSession(env) ? "desktop" : "local";
}

function xml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function capturePlist(job: { label: string; ffmpeg: string; socketPath: string; logPath: string; device?: string }): string {
	const args = [job.ffmpeg, "-nostdin", "-f", "avfoundation", "-i", avfoundationInput(job.device), "-ac", "1", "-ar", "16000", "-f", "s16le", "-loglevel", "error", `unix:${job.socketPath}`];
	// No KeepAlive: a recorder that exits must stay down, never respawn into a dead socket.
	return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(job.label)}</string>
<key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join("")}</array>
<key>StandardErrorPath</key><string>${xml(job.logPath)}</string>
<key>ProcessType</key><string>Interactive</string>
<key>RunAtLoad</key><true/>
</dict></plist>
`;
}

const runLaunchctl: Launchctl = (args) =>
	new Promise((resolve) => {
		const child = spawn("/bin/launchctl", args, { stdio: ["ignore", "ignore", "pipe"] });
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
		child.on("error", (error) => resolve({ code: -1, stderr: error.message }));
		child.on("close", (code) => resolve({ code: code ?? -1, stderr }));
	});

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Jobs from sessions that crashed before stopping stay loaded in launchd; remove them. */
function sweepStale(home: string, domain: string, launchctl: Launchctl, alive: (pid: number) => boolean): void {
	for (const name of readdirSync(home)) {
		const match = JOB_FILE.exec(name);
		if (!match || alive(Number(match[1]))) continue;
		if (match[3] === "plist") void launchctl(["bootout", `${domain}/${LABEL_PREFIX}${match[1]}.${match[2]}`]);
		rmSync(join(home, name), { force: true });
	}
}

function logTail(path: string): string {
	if (!existsSync(path)) return "";
	const text = readFileSync(path, "utf8").trim();
	return text ? `: ${text.slice(-LOG_TAIL_CHARS)}` : "";
}

export function startDesktopCapture(callbacks: CaptureCallbacks, options: DesktopCaptureOptions): Capture {
	const pid = options.pid ?? process.pid;
	const launchctl = options.launchctl ?? runLaunchctl;
	const domain = `gui/${options.uid}`;
	const n = ++sequence;
	const label = `${LABEL_PREFIX}${pid}.${n}`;
	const base = join(options.home, `capture-${pid}-${n}`);
	const paths = { socket: `${base}.sock`, plist: `${base}.plist`, log: `${base}.log` };
	const chunker = new FrameChunker(FRAME_SAMPLES, callbacks.onFrame);
	let stopped = false;
	let connection: Socket | undefined;
	let loaded: Promise<unknown> = Promise.resolve();

	sweepStale(options.home, domain, launchctl, options.alive ?? processAlive);

	const stop = (): void => {
		if (stopped) return;
		stopped = true;
		connection?.destroy();
		server.close();
		rmSync(paths.socket, { force: true });
		rmSync(paths.plist, { force: true });
		// Boot out only after bootstrap settles, or a late load would leave the job behind.
		void loaded
			.then(() => launchctl(["bootout", `${domain}/${label}`]))
			.finally(() => rmSync(paths.log, { force: true }));
	};
	const fail = (message: string): void => {
		if (stopped) return;
		stop();
		callbacks.onError(new Error(message));
	};

	const server = createServer((socket) => {
		if (connection || stopped) {
			socket.destroy();
			return;
		}
		connection = socket;
		socket.on("data", (chunk: Buffer) => chunker.push(chunk));
		socket.on("error", () => socket.destroy());
		socket.on("close", () => fail(`the desktop recorder stopped${logTail(paths.log)}`));
	});
	server.on("error", (error) => fail(`could not open the recorder socket: ${error.message}`));
	server.listen(paths.socket, () => {
		if (stopped) return;
		writeFileSync(paths.plist, capturePlist({ label, ffmpeg: options.ffmpeg, socketPath: paths.socket, logPath: paths.log, device: options.device }), { mode: 0o600 });
		loaded = launchctl(["bootstrap", domain, paths.plist]).then(({ code, stderr }) => {
			if (code !== 0) fail(`${NO_DESKTOP} (launchctl: ${stderr.trim() || `exit ${code}`})`);
		});
	});

	return { label: "ffmpeg via the desktop session", device: options.deviceName ?? "Mac microphone", blockedHint: DESKTOP_BLOCKED_HINT, stop };
}

function resolveFfmpeg(): string | undefined {
	const found = spawnSync("/bin/sh", ["-c", "command -v ffmpeg"], { encoding: "utf8" }).stdout?.trim();
	if (found?.startsWith("/")) return found;
	return FFMPEG_FALLBACKS.find((path) => existsSync(path));
}

/** Entry point for macOS over SSH. */
export function startMacDesktopCapture(callbacks: CaptureCallbacks, home: string, mic: { device?: string; name?: string } = {}): Capture {
	const ffmpeg = resolveFfmpeg();
	if (!ffmpeg) throw new Error(NEEDS_FFMPEG);
	return startDesktopCapture(callbacks, { home, ffmpeg, uid: process.getuid!(), device: mic.device, deviceName: mic.name });
}
