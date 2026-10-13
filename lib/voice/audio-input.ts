/**
 * Whether this host has a microphone, so a host without one never downloads
 * the speech models on its own. A host where this cannot be decided waits
 * for the user to dictate or run /voice setup.
 *
 * Linux reads the ALSA capture streams, then asks a running PulseAudio or
 * PipeWire server for its sources and saves that answer for a day. macOS asks
 * PvRecorder for its capture devices, but the first CoreAudio query can take
 * a second, so a child process asks in the background and saves the verdict
 * for a day.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { errorText, operationalError } from "../operational-log.ts";
import { voiceHome } from "./provision.ts";

type Env = Readonly<Record<string, string | undefined>>;

export interface AudioProbe {
	exists(path: string): boolean;
	read(path: string): string;
	write(path: string, text: string): void;
	/** The source names of the PulseAudio or PipeWire server at `server`; undefined when pactl gives no answer. */
	sources(server: string): readonly string[] | undefined;
	now(): number;
}

export interface ProbeDeps extends AudioProbe {
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
/** The voice extension's own operational log. */
const LOG_FILE = "voice.log";
/** A microphone plugged in later is seen after at most this long, or at the first dictation. */
export const VERDICT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
export const PROBE_TIMEOUT_MS = 10_000;
/** Prints the number of capture devices PvRecorder lists. Listing opens no device, so it asks for no permission. */
const COUNT_SCRIPT = "process.stdout.write(String(require(process.argv[1]).PvRecorder.getAvailableDevices().length))";

function pactlSources(server: string): readonly string[] | undefined {
	const result = spawnSync("pactl", ["list", "short", "sources"], {
		encoding: "utf8",
		timeout: PACTL_TIMEOUT_MS,
		stdio: ["ignore", "pipe", "ignore"],
		// libpulse never autospawns a daemon for a named server, so a stale socket file starts nothing.
		env: { ...process.env, LC_ALL: "C", PULSE_SERVER: server },
	});
	if (result.error || result.status !== 0) return undefined;
	// `index<TAB>name<TAB>module<TAB>format<TAB>state`
	return result.stdout.split("\n").flatMap((line) => line.split("\t")[1] || []);
}

const verdictPath = (env: Env) => join(voiceHome(env, homedir()), VERDICT_FILE);
const logNote = (env: Env, message: string) => operationalError(join(voiceHome(env, homedir()), LOG_FILE), "voice", message);

function writeAtomic(path: string, text: string): void {
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temporary, text, { mode: 0o600 });
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}

export const systemProbe: AudioProbe = {
	exists: existsSync,
	read: (path) => readFileSync(path, "utf8"),
	write: writeAtomic,
	sources: pactlSources,
	now: Date.now,
};

/** The PulseAudio or PipeWire server to ask, only where its socket is. */
function pulseServer(env: Env, probe: AudioProbe): string | undefined {
	if (env.PULSE_SERVER) return env.PULSE_SERVER;
	if (probe.exists("/mnt/wslg/PulseServer")) return "unix:/mnt/wslg/PulseServer";
	const native = env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, "pulse", "native") : undefined;
	return native && probe.exists(native) ? `unix:${native}` : undefined;
}

/** A capture stream decides at once; pactl's answer is saved for a day, so it does not block every session start. */
function linuxInput(env: Env, probe: AudioProbe): boolean {
	if (probe.exists(PCM) && CAPTURE_STREAM.test(probe.read(PCM))) return true;
	const server = pulseServer(env, probe);
	if (!server) return false;
	const saved = savedVerdict(env, probe);
	if (saved !== undefined) return saved;
	// A sink's monitor records what plays, not a microphone.
	const input = (probe.sources(server) ?? []).some((name) => !name.endsWith(".monitor"));
	writeVerdict(env, probe, input);
	return input;
}

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

/** Unsaved, the verdict still counts for this session; the next session asks again. */
function writeVerdict(env: Env, probe: AudioProbe, input: boolean): void {
	try {
		probe.write(verdictPath(env), `${JSON.stringify({ input, at: probe.now() })}\n`);
	} catch (error) {
		logNote(env, `microphone check not saved: ${errorText(error)}`);
	}
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

export interface Runtime {
	readonly bun: boolean;
	readonly sea: boolean;
	readonly execPath: string;
}

function isSea(): boolean {
	try {
		return createRequire(import.meta.url)("node:sea").isSea?.() === true;
	} catch {
		return false; // A Node without node:sea is older than single executable applications.
	}
}

const currentRuntime = (): Runtime => ({ bun: !!process.versions.bun, sea: isSea(), execPath: process.execPath });

/**
 * The child that counts devices. It needs a plain node binary: in Pi's Bun or
 * single-executable builds, execPath is Pi itself, which reads `-e` as an extension.
 */
export function deviceProbeCommand(runtime: Runtime = currentRuntime()): ProbeCommand | undefined {
	const binary = runtime.execPath.split(/[\\/]/).at(-1) ?? "";
	if (runtime.bun || runtime.sea || !/^node(js)?(\.exe)?$/i.test(binary)) return undefined;
	try {
		const module = createRequire(import.meta.url).resolve("@picovoice/pvrecorder-node");
		return { command: runtime.execPath, args: ["-e", COUNT_SCRIPT, module] };
	} catch {
		return undefined; // No PvRecorder for this platform: the probe cannot decide.
	}
}

/**
 * Runs the device count in a child, so a slow CoreAudio start never blocks
 * Pi. The child is killed at its timeout, when Pi exits, or by the returned stop.
 */
export function runDeviceProbe(
	done: (devices: number | undefined) => void,
	command = deviceProbeCommand(),
	timeoutMs = PROBE_TIMEOUT_MS,
	onError: (message: string) => void = () => {},
): () => void {
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
	child.on("error", (error) => {
		onError(`microphone check could not run: ${errorText(error)}`);
		finish(undefined);
	});
	child.on("close", (code) => finish(code === 0 && /^\d+$/.test(out) ? Number(out) : undefined));
	// Pi must not wait for the probe to exit.
	child.unref();
	(child.stdout as { unref?: () => void } | null)?.unref?.();
	return () => {
		if (child.exitCode === null && child.signalCode === null) kill();
		finish(undefined);
	};
}

export const systemDeps: ProbeDeps = {
	...systemProbe,
	run: (done) => runDeviceProbe(done, undefined, undefined, (message) => logNote(process.env, message)),
};
