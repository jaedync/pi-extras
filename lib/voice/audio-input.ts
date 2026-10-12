/**
 * Whether this host has a microphone, so a host without one never downloads
 * the speech models on its own. A host where this cannot be decided waits
 * for the user to dictate or run /voice setup.
 *
 * Linux reads the ALSA capture streams and asks a running PulseAudio or
 * PipeWire server for its sources. macOS asks PvRecorder for its capture
 * devices, but the first CoreAudio query can take a second, so a child
 * process asks in the background and saves the verdict for a day.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { voiceHome } from "./provision.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface AudioProbe {
	exists(path: string): boolean;
	read(path: string): string;
	/** PulseAudio or PipeWire source names; undefined when pactl gives no answer. */
	sources(): readonly string[] | undefined;
	now(): number;
}

export interface ProbeDeps extends AudioProbe {
	write(path: string, text: string): void;
	/** Starts a device count in the background; calls back with undefined when it fails. Returns a stop. */
	run(done: (devices: number | undefined) => void): () => void;
}

export interface ProbeCommand {
	readonly command: string;
	readonly args: readonly string[];
}

const PCM = "/proc/asound/pcm";
/** A PCM device line ends with its streams: `playback 1 : capture 1`. */
const CAPTURE_STREAM = /:\s*capture\s+\d+\s*$/m;
const PACTL_TIMEOUT_MS = 1_000;
const VERDICT_FILE = "audio-input.json";
/** A microphone plugged in later is seen after at most this long, or at the first dictation. */
export const VERDICT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const PROBE_TIMEOUT_MS = 10_000;
/** Prints the number of capture devices PvRecorder lists. Listing opens no device, so it asks for no permission. */
const COUNT_SCRIPT = "process.stdout.write(String(require(process.argv[1]).PvRecorder.getAvailableDevices().length))";

function pactlSources(): readonly string[] | undefined {
	const result = spawnSync("pactl", ["list", "short", "sources"], {
		encoding: "utf8",
		timeout: PACTL_TIMEOUT_MS,
		stdio: ["ignore", "pipe", "ignore"],
		env: { ...process.env, LC_ALL: "C" },
	});
	if (result.error || result.status !== 0) return undefined;
	// `index<TAB>name<TAB>module<TAB>format<TAB>state`
	return result.stdout.split("\n").flatMap((line) => line.split("\t")[1] || []);
}

export const systemProbe: AudioProbe = {
	exists: existsSync,
	read: (path) => readFileSync(path, "utf8"),
	sources: pactlSources,
	now: Date.now,
};

/** A server is running only where its socket is; pactl run without one could start a PulseAudio daemon. */
function pulseSocket(env: Env, probe: AudioProbe): boolean {
	if (env.PULSE_SERVER || probe.exists("/mnt/wslg/PulseServer")) return true;
	return !!env.XDG_RUNTIME_DIR && probe.exists(join(env.XDG_RUNTIME_DIR, "pulse", "native"));
}

function linuxInput(env: Env, probe: AudioProbe): boolean {
	if (probe.exists(PCM) && CAPTURE_STREAM.test(probe.read(PCM))) return true;
	if (!pulseSocket(env, probe)) return false;
	// A sink's monitor records what plays, not a microphone.
	return (probe.sources() ?? []).some((name) => !name.endsWith(".monitor"));
}

const verdictPath = (env: Env) => join(voiceHome(env, homedir()), VERDICT_FILE);

/** The saved macOS verdict while it is fresh; undefined when there is none, it is stale, or it does not parse. */
function savedVerdict(env: Env, probe: AudioProbe): boolean | undefined {
	const path = verdictPath(env);
	if (!probe.exists(path)) return undefined;
	let saved: unknown;
	try {
		saved = JSON.parse(probe.read(path));
	} catch {
		return undefined; // A torn or foreign file counts as no verdict; the next probe replaces it.
	}
	const { input, at } = (saved ?? {}) as { input?: unknown; at?: unknown };
	if (typeof input !== "boolean" || typeof at !== "number") return undefined;
	const age = probe.now() - at;
	return age >= 0 && age < VERDICT_MAX_AGE_MS ? input : undefined;
}

/**
 * Cheap and synchronous, for session start: true only when an input is known
 * to exist. False also means "not decided", so callers start no download.
 */
export function hasAudioInput(platform: NodeJS.Platform, env: Env, probe: AudioProbe = systemProbe): boolean {
	if (platform === "linux") return linuxInput(env, probe);
	if (platform === "darwin") return savedVerdict(env, probe) === true;
	return false;
}

function writeVerdict(env: Env, deps: ProbeDeps, input: boolean): void {
	try {
		deps.write(verdictPath(env), `${JSON.stringify({ input, at: deps.now() })}\n`);
	} catch {
		// Unsaved, the verdict still counts for this session; the next session probes again.
	}
}

function writeAtomic(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	writeFileSync(`${path}.${process.pid}.tmp`, text, { mode: 0o600 });
	renameSync(`${path}.${process.pid}.tmp`, path);
}

/**
 * On macOS without a fresh verdict, counts the capture devices in the
 * background, saves the verdict, and calls `onFound` when there is a
 * microphone. Call it when hasAudioInput is false; the returned stop ends the
 * probe with the session. Elsewhere it does nothing: the sync check decided.
 */
export function probeAudioInput(platform: NodeJS.Platform, env: Env, onFound: () => void, deps: ProbeDeps = systemDeps): () => void {
	if (platform !== "darwin" || savedVerdict(env, deps) !== undefined) return () => {};
	let live = true;
	const stop = deps.run((devices) => {
		if (!live) return;
		live = false;
		if (devices === undefined) return;
		writeVerdict(env, deps, devices > 0);
		if (devices > 0) onFound();
	});
	return () => {
		live = false;
		stop();
	};
}

function deviceProbeCommand(): ProbeCommand | undefined {
	try {
		const module = createRequire(import.meta.url).resolve("@picovoice/pvrecorder-node");
		return { command: process.execPath, args: ["-e", COUNT_SCRIPT, module] };
	} catch {
		return undefined; // No PvRecorder for this platform: the probe cannot decide.
	}
}

/**
 * Runs the device count in a child, so a slow CoreAudio start never blocks
 * Pi. The child is killed at its timeout, when Pi exits, or by the returned stop.
 */
export function runDeviceProbe(done: (devices: number | undefined) => void, command = deviceProbeCommand(), timeoutMs = PROBE_TIMEOUT_MS): () => void {
	if (!command) {
		done(undefined);
		return () => {};
	}
	const child = spawn(command.command, [...command.args], { stdio: ["ignore", "pipe", "ignore"] });
	const kill = () => child.kill("SIGKILL");
	// spawn's own `timeout` holds a referenced timer, which would keep Pi from exiting.
	const timer = setTimeout(kill, timeoutMs);
	timer.unref();
	let out = "";
	let finished = false;
	const finish = (devices: number | undefined) => {
		if (finished) return;
		finished = true;
		clearTimeout(timer);
		process.off("exit", kill);
		done(devices);
	};
	process.once("exit", kill);
	child.stdout!.on("data", (chunk: Buffer) => (out = (out + chunk.toString()).slice(0, 32)));
	child.on("error", () => finish(undefined));
	child.on("close", (code) => finish(code === 0 && /^\d+$/.test(out) ? Number(out) : undefined));
	// Pi must not wait for the probe to exit.
	child.unref();
	(child.stdout as { unref?: () => void } | null)?.unref?.();
	return () => {
		if (child.exitCode === null && child.signalCode === null) kill();
		finish(undefined);
	};
}

export const systemDeps: ProbeDeps = { ...systemProbe, write: writeAtomic, run: (done) => runDeviceProbe(done) };
