/**
 * Microphone capture inside the Pi process, so the OS attributes microphone
 * access to the user's terminal. PvRecorder is tried first; command-line
 * recorders are the fallback. All paths deliver 16 kHz mono Int16 frames.
 * macOS over SSH has no terminal to attribute to; see desktop-capture.ts.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export const FRAME_SAMPLES = 1600; // 100 ms at 16 kHz

export interface CaptureCommand {
	readonly command: string;
	readonly args: readonly string[];
}

export interface Capture {
	readonly label: string;
	/** Microphone name worth showing the user, if the recorder knows it. */
	readonly device?: string;
	/** What to tell the user when audio is silent or never arrives, if the default is wrong for this recorder. */
	readonly blockedHint?: string;
	stop(): void;
}

export interface CaptureCallbacks {
	onFrame(frame: Int16Array): void;
	onError(error: Error): void;
}

type Env = Readonly<Record<string, string | undefined>>;
interface Probe {
	exists(path: string): boolean;
	read(path: string): string;
}

const RAW_16K = ["-ac", "1", "-ar", "16000", "-f", "s16le", "-loglevel", "error", "-"];

/** avfoundation input spec: ":<name>" selects an audio device by name, ":default" the system default. */
export function avfoundationInput(device?: string): string {
	return `:${device ?? "default"}`;
}

/** `device` is a name to open instead of the default; only macOS recorders honor it. */
export function captureCommands(platform: NodeJS.Platform, has: (bin: string) => boolean, device?: string): CaptureCommand[] {
	const candidates: CaptureCommand[] =
		platform === "darwin"
			? [{ command: "ffmpeg", args: ["-nostdin", "-f", "avfoundation", "-i", avfoundationInput(device), ...RAW_16K] }]
			: [
					{ command: "parecord", args: ["--raw", "--format=s16le", "--rate=16000", "--channels=1", "--latency-msec=50"] },
					{ command: "ffmpeg", args: ["-nostdin", "-f", "pulse", "-i", "default", ...RAW_16K] },
					{ command: "arecord", args: ["-q", "-t", "raw", "-f", "S16_LE", "-r", "16000", "-c", "1"] },
				];
	return candidates.filter((c) => has(c.command));
}

/** Cheap check so headless servers never download speech models. */
export function hasAudioInput(platform: NodeJS.Platform, env: Env, probe: Probe = { exists: existsSync, read: (p) => readFileSync(p, "utf8") }): boolean {
	if (platform === "darwin") return true;
	if (platform !== "linux") return false;
	if (env.PULSE_SERVER || probe.exists("/mnt/wslg/PulseServer")) return true;
	if (env.XDG_RUNTIME_DIR && probe.exists(join(env.XDG_RUNTIME_DIR, "pulse", "native"))) return true;
	if (!probe.exists("/proc/asound/cards")) return false;
	return /^\s*\d+\s*\[/m.test(probe.read("/proc/asound/cards"));
}

/** Regroups a little-endian s16 byte stream into fixed-size frames. */
export class FrameChunker {
	private pending = Buffer.alloc(0);
	private readonly frameBytes: number;
	private readonly emit: (frame: Int16Array) => void;

	constructor(samples: number, emit: (frame: Int16Array) => void) {
		this.frameBytes = samples * 2;
		this.emit = emit;
	}

	push(chunk: Buffer): void {
		let buffer = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
		while (buffer.length >= this.frameBytes) {
			const frame = new Int16Array(this.frameBytes / 2);
			for (let i = 0; i < frame.length; i++) frame[i] = buffer.readInt16LE(i * 2);
			this.emit(frame);
			buffer = buffer.subarray(this.frameBytes);
		}
		this.pending = Buffer.from(buffer);
	}
}

interface PvRecorderLike {
	start(): void;
	stop(): void;
	release(): void;
	read(): Promise<Int16Array>;
	getSelectedDevice(): string;
}

export interface PvRecorderClass {
	new (frameLength: number, device: number): PvRecorderLike;
	getAvailableDevices(): string[];
}

export function loadPvRecorder(): PvRecorderClass | undefined {
	try {
		const require = createRequire(import.meta.url);
		return require("@picovoice/pvrecorder-node").PvRecorder;
	} catch {
		// Missing prebuilt for this platform or libc; command-line recorders take over.
		return undefined;
	}
}

function startPvRecorder(callbacks: CaptureCallbacks, device?: string): Capture | undefined {
	const PvRecorder = loadPvRecorder();
	if (!PvRecorder) return undefined;
	let recorder: PvRecorderLike;
	try {
		// -1 is the system default; a device unplugged since it was chosen also lands there.
		const index = device ? PvRecorder.getAvailableDevices().indexOf(device) : -1;
		recorder = new PvRecorder(FRAME_SAMPLES, index);
		recorder.start();
	} catch {
		return undefined;
	}
	let running = true;
	void (async () => {
		try {
			while (running) callbacks.onFrame(await recorder.read());
		} catch (error) {
			if (running) callbacks.onError(error as Error);
		} finally {
			recorder.release();
		}
	})();
	const selected = recorder.getSelectedDevice();
	return {
		label: `pvrecorder: ${selected}`,
		device: selected,
		stop() {
			if (!running) return;
			running = false;
			recorder.stop();
		},
	};
}

function onPath(bin: string): boolean {
	return spawnSync("sh", ["-c", `command -v ${bin}`], { stdio: "ignore" }).status === 0;
}

function startCommand(spec: CaptureCommand, callbacks: CaptureCallbacks, device?: string): Capture {
	const child: ChildProcess = spawn(spec.command, [...spec.args], { stdio: ["ignore", "pipe", "pipe"] });
	const chunker = new FrameChunker(FRAME_SAMPLES, callbacks.onFrame);
	let stderr = "";
	let stopped = false;
	child.stdout!.on("data", (chunk: Buffer) => chunker.push(chunk));
	child.stderr!.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-400)));
	child.on("error", (error) => callbacks.onError(error));
	child.on("exit", (code) => {
		if (!stopped) callbacks.onError(new Error(`${spec.command} exited ${code}: ${stderr.trim() || "no output"}`));
	});
	return {
		label: spec.command,
		device,
		stop() {
			stopped = true;
			child.kill("SIGTERM");
		},
	};
}

export function startCapture(callbacks: CaptureCallbacks, device?: string, platform: NodeJS.Platform = process.platform): Capture {
	const pv = startPvRecorder(callbacks, device);
	if (pv) return pv;
	const [first] = captureCommands(platform, onPath, device);
	if (!first) {
		throw new Error(platform === "darwin" ? "no microphone recorder available" : "no microphone recorder found (install pulseaudio-utils)");
	}
	return startCommand(first, callbacks, platform === "darwin" ? device : undefined);
}
