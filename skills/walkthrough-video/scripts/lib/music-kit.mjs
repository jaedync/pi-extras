/**
 * The optional music kit: the sampled instruments that `wv sound score` plays
 * (sfizz_render, the VCSL drum and mallet maps, the Salamander piano).
 * `wv setup --music` builds it from three pinned sources into a staging folder
 * and moves it into place only when every part, including a smoke render,
 * passed. The pins are the commits the hand-built kit measured (2026-10-29).
 */
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { cpus, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "./paths.mjs";
import { assertNotStopping, findOnPath, isStopping, run } from "./proc.mjs";
import { onSignalCleanup } from "./signals.mjs";

const PY_DIR = fileURLToPath(new URL("../py/", import.meta.url));
const GB = 1024 ** 3;

/** One progress line at a time. @typedef {(line: string) => void} Log */
/** A smoke render's result for one SFZ file. @typedef {{name: string, ok: boolean, peak?: number, detail: string}} SmokeItem */
/** @typedef {(dir: string) => Promise<SmokeItem[]>} Smoke */

/** What the kit renders at, and what the smoke render expects back. */
export const MUSIC_KIT_SAMPLE_RATE = 48000;
/** The kits' sources: commits, licences and the measured size of the checkout. */
export const MUSIC_KIT_PINS = {
	sfizz: {
		name: "sfizz",
		url: "https://github.com/sfztools/sfizz.git",
		commit: "f5c6e29f23b8057867c08e88f5f6ac6738baa30b",
		licence: "BSD-2-Clause",
		bytes: 155_000_000,
		submodules: true,
	},
	vcsl: {
		name: "VCSL",
		url: "https://github.com/sgossner/VCSL.git",
		commit: "c1ea7bcc3c7309650ab0da9d15c9cd1fbc4a4c7e",
		licence: "CC0-1.0",
		// The checkout and its shallow history, measured 2026-10-30.
		bytes: 217_000_000,
		// Only the folders the maps read. Vibraphone is not one of them, so it is not downloaded.
		folders: [
			"LICENSE",
			"Membranophones/Struck Membranophones/Bass Drum 1/*",
			"Membranophones/Struck Membranophones/Snare Drum, Modern 1/*",
			"Membranophones/Struck Membranophones/Tom 1/*",
			"Idiophones/Struck Idiophones/Hi-Hat Cymbal/*",
			"Idiophones/Struck Idiophones/Suspended Cymbal 1/*",
			"Idiophones/Struck Idiophones/Claps/*",
			"Idiophones/Struck Idiophones/Marimba/*",
			"Idiophones/Struck Idiophones/Glockenspiel/*",
			"Idiophones/Struck Idiophones/Shaker, Large/*",
			"Idiophones/Struck Idiophones/Tambourine 1/*",
		],
	},
	salamander: {
		name: "salamander",
		url: "https://github.com/sfzinstruments/SalamanderGrandPiano.git",
		commit: "3382bf9496bba2486f5ab0de55a264d1dfc38404",
		licence: "CC BY 3.0",
		// 668 files at that commit, from the GitHub tree API.
		bytes: 748_451_483,
		files: 668,
	},
};
export const MUSIC_KIT_DOWNLOAD_BYTES = Object.values(MUSIC_KIT_PINS).reduce((sum, source) => sum + source.bytes, 0);
/** Free space the install needs: the downloads, the build tree and the staging copy. */
export const MUSIC_KIT_NEED_BYTES = 3 * GB;
/**
 * The credit that a published film with the piano must carry. The Salamander
 * licence asks for the licence link and for the changes to be named, and its
 * README for the source link, so the line gives all three.
 */
export const MUSIC_KIT_ATTRIBUTION =
	"Piano: Salamander Grand Piano V3 by Alexander Holm, CC BY 3.0 (https://creativecommons.org/licenses/by/3.0/). " +
	"Source: https://github.com/sfzinstruments/SalamanderGrandPiano. Changes: leading silence trimmed; used as samples in a composed score.";

/** The kit's layout, which sc.py and the score reference too. */
export function kitPaths(kit = paths().musicKit) {
	return {
		root: kit,
		manifest: join(kit, "kit.json"),
		bin: join(kit, "bin"),
		sfizz: join(kit, "bin", "sfizz_render"),
		samples: join(kit, "samples"),
		vcsl: join(kit, "samples", "vcsl"),
		vcslKitSfz: join(kit, "samples", "vcsl", "kit.sfz"),
		vcslMarimbaSfz: join(kit, "samples", "vcsl", "marimba.sfz"),
		vcslGlockSfz: join(kit, "samples", "vcsl", "glock.sfz"),
		vcslSamples: join(kit, "samples", "vcsl", "kit"),
		piano: join(kit, "samples", "salamander"),
		pianoSfz: join(kit, "samples", "salamander", "Salamander Grand Piano V3.sfz"),
		pianoSamples: join(kit, "samples", "salamander", "Samples"),
	};
}

export function formatBytes(bytes) {
	return bytes >= GB ? `${(bytes / GB).toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

const short = (commit) => (commit ? String(commit).slice(0, 7) : null);

/** The install command for each build tool, on every host that wv supports. */
const TOOL_FIX = {
	git: "install git (Debian or Ubuntu: sudo apt install git; Fedora: sudo dnf install git; Arch: sudo pacman -S git; macOS: xcode-select --install)",
	cmake: "install cmake 3.16 or later (Debian or Ubuntu: sudo apt install cmake; Fedora: sudo dnf install cmake; Arch: sudo pacman -S cmake; macOS: brew install cmake, or see https://cmake.org/download/)",
	compiler: "install a C and a C++ compiler (Debian or Ubuntu: sudo apt install build-essential; Fedora: sudo dnf install gcc gcc-c++; Arch: sudo pacman -S gcc; macOS: xcode-select --install)",
	make: "install make (Debian or Ubuntu: sudo apt install build-essential; Fedora: sudo dnf install make; Arch: sudo pacman -S base-devel; macOS: xcode-select --install)",
	ninja: "install ninja (Debian or Ubuntu: sudo apt install ninja-build; Fedora: sudo dnf install ninja-build; Arch: sudo pacman -S ninja; macOS: brew install ninja)",
};

/** The generator that cmake will use, so the check and the build agree. */
export function buildGenerator(env = process.env) {
	const ninja = findOnPath("ninja", env);
	if (ninja) return { name: "Ninja", path: ninja };
	const make = findOnPath("make", env);
	return make ? { name: "Unix Makefiles", path: make } : null;
}

/** Runs a tool, because a file that exists may not start. */
async function probeTool(command, args, env = process.env, timeoutMs = 15000) {
	if (!command) return { ok: false, detail: "not on PATH" };
	try {
		const result = await run(command, args, { env, timeoutMs });
		const text = `${result.stdout}\n${result.stderr}`.trim();
		if (result.code !== 0) return { ok: false, detail: `cannot run (exit ${result.code ?? result.signal ?? "?"})` };
		return { ok: true, detail: text.split("\n")[0] ?? "" };
	} catch (error) {
		return { ok: false, detail: `cannot run (${(error?.message ?? error).split("\n")[0]})` };
	}
}

/** The build tools the kit needs, each with the fix for the host. Every tool is run. */
export async function kitTools(env = process.env) {
	const gitPath = findOnPath("git", env);
	const cmakePath = findOnPath("cmake", env);
	const ccPath = env.CC || findOnPath("cc", env) || findOnPath("gcc", env) || findOnPath("clang", env);
	const cxxPath = env.CXX || findOnPath("c++", env) || findOnPath("g++", env) || findOnPath("clang++", env);
	const generator = buildGenerator(env);
	const [git, cmake, cc, cxx, gen] = await Promise.all([
		probeTool(gitPath, ["--version"], env),
		probeTool(cmakePath, ["--version"], env),
		probeTool(ccPath, ["--version"], env),
		probeTool(cxxPath, ["--version"], env),
		probeTool(generator?.path, ["--version"], env),
	]);
	// CMake 3.16 is the oldest that the pinned sfizz build supports.
	const version = cmake.ok ? cmake.detail.match(/cmake version (\d+)\.(\d+)/) : null;
	const cmakeOk = cmake.ok && Boolean(version) && (Number(version[1]) > 3 || (Number(version[1]) === 3 && Number(version[2]) >= 16));
	const items = [
		{ name: "git", path: gitPath, ok: git.ok, detail: git.detail, fix: TOOL_FIX.git },
		{ name: "cmake", path: cmakePath, ok: cmakeOk, detail: cmakeOk ? cmake.detail : version ? `${cmake.detail}, needs 3.16 or later` : cmake.detail, fix: TOOL_FIX.cmake },
		{ name: "c compiler", path: ccPath, ok: cc.ok, detail: cc.detail, fix: TOOL_FIX.compiler },
		{ name: "c++ compiler", path: cxxPath, ok: cxx.ok, detail: cxx.detail, fix: TOOL_FIX.compiler },
		{ name: "make or ninja", path: generator?.path, ok: gen.ok, detail: gen.ok ? `${generator.name}: ${gen.detail}` : gen.detail, fix: TOOL_FIX[ninjaFix(env)] },
	];
	return { ok: items.every((item) => item.ok), items, generator: gen.ok ? generator : null };
}

/** The fix for the generator that is missing: ninja when it was the choice, else make. */
function ninjaFix(env) {
	return findOnPath("ninja", env) ? "ninja" : "make";
}

/** Why the kit cannot start on this host, or null. Names every missing tool and its fix. */
export function toolRefusal(tools) {
	const missing = tools.items.filter((item) => !item.ok);
	if (missing.length === 0) return null;
	return `the music kit needs git, cmake 3.16 or later, a C and a C++ compiler, and make or ninja to build the sampler. Missing: ${missing.map((item) => `${item.name} (${item.fix})`).join("; ")}. Install them, then run wv setup --music again.`;
}

export function readManifest(file) {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

function countFiles(dir, extension) {
	try {
		return readdirSync(dir).filter((name) => name.toLowerCase().endsWith(extension)).length;
	} catch {
		return 0;
	}
}

/**
 * The cheap status that `wv setup --check` prints: the four parts are there,
 * with no render. A kit built by hand before this step has no kit.json and is
 * still installed.
 */
export function musicKitStatus(kit = paths().musicKit) {
	const p = kitPaths(kit);
	const manifest = readManifest(p.manifest);
	const present =
		existsSync(p.sfizz) &&
		[p.vcslKitSfz, p.vcslMarimbaSfz, p.vcslGlockSfz, p.pianoSfz].every((file) => existsSync(file)) &&
		countFiles(p.vcslSamples, ".wav") > 0 &&
		countFiles(p.pianoSamples, ".flac") > 0;
	if (!present) return { present: false, kit, manifest, detail: "not installed", hint: `run wv setup --music to add the sampled instruments (about ${formatBytes(MUSIC_KIT_DOWNLOAD_BYTES)} download, about 5 min on 16 cores)` };
	const detail = manifest
		? `installed at ${kit} (VCSL ${short(manifest.vcsl?.commit) ?? "?"}, Salamander ${short(manifest.salamander?.commit) ?? "?"})`
		: `installed at ${kit} (no kit.json: built by hand)`;
	return { present: true, kit, manifest, detail, hint: "" };
}

/** One line for `wv setup --check`, which never fails on the optional kit. */
export function musicKitCheckLine(kit = paths().musicKit) {
	const status = musicKitStatus(kit);
	return status.present ? `music kit (optional): ${status.detail}` : `music kit (optional): ${status.detail}; ${status.hint}`;
}

/**
 * Reads and tests the kit: each part, its commit from kit.json, and a smoke
 * render of every SFZ. `smoke` is injected so the unit tests never run a binary.
 * @param {{kit?: string, smoke?: Smoke, log?: Log}} [options]
 */
export async function checkMusicKit({ kit = paths().musicKit, smoke = (dir) => smokeKit(dir), log = () => {} } = {}) {
	const p = kitPaths(kit);
	const manifest = readManifest(p.manifest);
	const items = [];
	const sfizzOk = existsSync(p.sfizz);
	items.push({ name: "sfizz_render", ok: sfizzOk, detail: sfizzOk ? `${p.sfizz}${manifest?.sfizz?.commit ? ` (sfizz ${short(manifest.sfizz.commit)})` : ""}` : "not built; run wv setup --music" });

	const maps = [p.vcslKitSfz, p.vcslMarimbaSfz, p.vcslGlockSfz];
	const missingMaps = maps.filter((file) => !existsSync(file));
	items.push({
		name: "VCSL maps",
		ok: missingMaps.length === 0,
		detail: missingMaps.length === 0 ? `kit.sfz, marimba.sfz and glock.sfz${manifest?.vcsl?.commit ? ` (VCSL ${short(manifest.vcsl.commit)})` : ""}` : `${missingMaps.map((file) => basename(file)).join(", ")} missing`,
	});

	const wavs = countFiles(p.vcslSamples, ".wav");
	items.push({ name: "VCSL samples", ok: wavs > 0, detail: wavs > 0 ? `${wavs} wav in ${p.vcslSamples}` : `no wav in ${p.vcslSamples}` });

	const flacs = countFiles(p.pianoSamples, ".flac");
	const pianoOk = existsSync(p.pianoSfz) && flacs > 0;
	items.push({
		name: "Salamander piano",
		ok: pianoOk,
		detail: pianoOk ? `${flacs} flac, ${MUSIC_KIT_PINS.salamander.licence}${manifest?.salamander?.commit ? ` (Salamander ${short(manifest.salamander.commit)})` : ""}` : `no piano in ${p.piano}`,
	});

	// The manifest's pins are compared with the code's pins, so an edited kit.json cannot pass.
	if (manifest) {
		const wrong = [];
		for (const [name, pin] of Object.entries(MUSIC_KIT_PINS)) {
			const recorded = manifest[name];
			if (!recorded) {
				wrong.push(`${name}: no pin in kit.json`);
				continue;
			}
			if (recorded.commit !== pin.commit) wrong.push(`${name}: kit.json says ${short(recorded.commit)}, the pin is ${short(pin.commit)}`);
			if (recorded.checkout && recorded.checkout !== pin.commit) wrong.push(`${name}: the checkout was ${short(recorded.checkout)}, not ${short(pin.commit)}`);
		}
		items.push({ name: "pins", ok: wrong.length === 0, detail: wrong.length ? wrong.join("; ") : `${Object.keys(MUSIC_KIT_PINS).length} sources at their pinned commits` });
	}

	// A smoke render needs a binary and the maps; without them the item above is the fix.
	if (sfizzOk && missingMaps.length === 0) {
		let smokeItems;
		try {
			smokeItems = await smoke(kit);
		} catch (error) {
			// A stop is not a kit fault: it goes on to the shutdown, not into the report.
			if (error?.name === "StoppingError") throw error;
			smokeItems = [{ name: "smoke render", ok: false, detail: String(error?.message ?? error).split("\n")[0] }];
		}
		const bad = smokeItems.filter((item) => !item.ok);
		const lowest = smokeItems.reduce((min, item) => Math.min(min, Number(item.peak ?? 1)), 1);
		items.push({
			name: "smoke render",
			ok: bad.length === 0,
			detail: bad.length === 0 ? `${smokeItems.length} of ${smokeItems.length} SFZ render at ${MUSIC_KIT_SAMPLE_RATE} Hz above silence (lowest peak ${lowest.toFixed(2)})` : bad.map((item) => `${item.name}: ${item.detail}`).join(", "),
		});
	}

	const missing = items.filter((item) => !item.ok).map((item) => item.name);
	for (const item of items) log(`${item.ok ? "ok  " : "MISS"}  ${item.name.padEnd(16)} ${item.detail}`);
	const report = { ok: missing.length === 0, present: missing.length === 0, kit, items, missing, manifest };
	return report;
}

/** A type 0 MIDI file: one note per (t, key, vel, dur), sorted, with an end-of-track. */
export function smokeMidi(notes = [{ t: 0.5, key: 36, vel: 110, dur: 0.4 }, { t: 1, key: 60, vel: 100, dur: 0.4 }], bpm = 120) {
	const ppq = 960;
	const ticks = (seconds) => Math.round((seconds * ppq * bpm) / 60);
	const events = [];
	for (const note of notes) {
		events.push([ticks(note.t), 0x90, note.key, note.vel]);
		events.push([ticks(note.t + note.dur), 0x80, note.key, 0]);
	}
	// Note-off sorts before note-on at the same tick, so a repeated key retriggers.
	events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
	const track = [];
	const variable = (value) => {
		const bytes = [value & 0x7f];
		while ((value >>= 7) > 0) bytes.unshift((value & 0x7f) | 0x80);
		return bytes;
	};
	track.push(...variable(0), 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20); // 500000 us per beat
	let last = 0;
	for (const [tick, status, key, velocity] of events) {
		track.push(...variable(tick - last), status, key, velocity);
		last = tick;
	}
	track.push(0x00, 0xff, 0x2f, 0x00);
	const header = Buffer.alloc(14);
	header.write("MThd", 0, "latin1");
	header.writeUInt32BE(6, 4);
	header.writeUInt16BE(0, 8);
	header.writeUInt16BE(1, 10);
	header.writeUInt16BE(ppq, 12);
	const body = Buffer.alloc(8);
	body.write("MTrk", 0, "latin1");
	body.writeUInt32BE(track.length, 4);
	return Buffer.concat([header, body, Buffer.from(track)]);
}

/** The rate, channel count, frame count and sample peak of a WAV file. */
export function wavPeak(buffer) {
	const info = { rate: null, channels: null, bits: null, frames: 0, peak: 0 };
	if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.toString("latin1", 0, 4) !== "RIFF" || buffer.toString("latin1", 8, 12) !== "WAVE") return info;
	let format = null;
	let data = null;
	for (let offset = 12; offset + 8 <= buffer.length; ) {
		const id = buffer.toString("latin1", offset, offset + 4);
		const size = buffer.readUInt32LE(offset + 4);
		const body = offset + 8;
		if (id === "fmt " && body + 16 <= buffer.length) {
			format = buffer.readUInt16LE(body);
			info.channels = buffer.readUInt16LE(body + 2);
			info.rate = buffer.readUInt32LE(body + 4);
			info.bits = buffer.readUInt16LE(body + 14);
		} else if (id === "data") {
			data = buffer.subarray(body, Math.min(buffer.length, body + size));
		}
		offset = body + size + (size % 2);
	}
	if (!data || !info.channels || !info.bits) return info;
	const width = info.bits / 8;
	info.frames = Math.floor(data.length / (width * info.channels));
	const last = info.frames * info.channels;
	for (let index = 0; index < last; index += 1) {
		const at = index * width;
		let sample;
		if (format === 3 && width === 4) sample = Math.abs(data.readFloatLE(at));
		else if (width === 2) sample = Math.abs(data.readInt16LE(at)) / 32768;
		else if (width === 3) sample = Math.abs((data[at] | (data[at + 1] << 8) | (data[at + 2] << 16)) << 8 >> 8) / 8388608;
		else if (width === 4) sample = Math.abs(data.readInt32LE(at)) / 2147483648;
		else continue;
		if (sample > info.peak) info.peak = sample;
	}
	return info;
}

/** Renders a short pass through each SFZ and checks the rate, the length and the level. */
export async function smokeKit(kit = paths().musicKit) {
	const p = kitPaths(kit);
	const jobs = [
		{ name: "kit", sfz: p.vcslKitSfz, keys: [36, 38, 42] },
		{ name: "piano", sfz: p.pianoSfz, keys: [60, 64, 67] },
		{ name: "marimba", sfz: p.vcslMarimbaSfz, keys: [60, 64, 67, 72] },
		{ name: "glock", sfz: p.vcslGlockSfz, keys: [67, 72, 79] },
	];
	const dir = mkdtempSync(join(tmpdir(), "wv-kit-smoke-"));
	try {
		const items = [];
		for (const job of jobs) {
			// A stop that cancelled the last render must not start the next one.
			assertNotStopping("the smoke render");
			if (!existsSync(p.sfizz) || !existsSync(job.sfz)) {
				items.push({ name: job.name, ok: false, peak: 0, detail: existsSync(job.sfz) ? "no sfizz_render" : `${basename(job.sfz)} is missing` });
				continue;
			}
			const midi = join(dir, `${job.name}.mid`);
			const wav = join(dir, `${job.name}.wav`);
			const notes = job.keys.map((key, index) => ({ t: 0.25 + index * 0.5, key, vel: 100, dur: 0.35 }));
			writeFileSync(midi, smokeMidi(notes));
			const result = await run(p.sfizz, ["--sfz", job.sfz, "--midi", midi, "--wav", wav, "-s", String(MUSIC_KIT_SAMPLE_RATE), "-q", "3", "--use-eot"], { timeoutMs: 120000 });
			assertNotStopping("the next smoke render");
			if (result.code !== 0 || !existsSync(wav)) {
				items.push({ name: job.name, ok: false, peak: 0, detail: `sfizz_render failed: ${(result.stderr || result.stdout).trim().split("\n").slice(-1)[0] || `exit ${result.code}`}` });
				continue;
			}
			const info = wavPeak(readFileSync(wav));
			const silent = info.peak <= 0.001;
			items.push({
				name: job.name,
				ok: info.rate === MUSIC_KIT_SAMPLE_RATE && !silent,
				peak: info.peak,
				detail: `${info.rate ?? "no"} Hz, ${info.frames} frames, peak ${info.peak.toFixed(3)}${silent ? " (silent)" : ""}`,
			});
		}
		return items;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * The real steps behind installMusicKit, so the unit tests can replace any of
 * them: a fetch, the sfizz build, the map writers, the smoke render.
 * @param {{log?: Log, env?: NodeJS.ProcessEnv}} [options]
 */
export function kitDeps({ log = () => {}, env = process.env } = {}) {
	return {
		tools: () => kitTools(env),
		// The cache root may not exist yet: ask the filesystem that holds it.
		freeBytes: (dir) => {
			let probe = dir;
			while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
			const stat = statfsSync(probe);
			return stat.bavail * stat.bsize;
		},
		python: () => kitPython(log),
		fetch: (source, dir) => fetchSource(source, dir, log),
		build: (src, bin) => buildSfizz(src, bin, log),
		generate: (vcsl, out, python) => generateMaps(vcsl, out, python, log),
		trim: (folder, python) => trimSamples(folder, python, log),
		smoke: (dir) => smokeKit(dir),
	};
}

/** The Python that writes the maps: the runtime venv, or one uv builds for the kit and its score. */
async function kitPython(log) {
	const { ensurePythonVenv } = await import("./setup.mjs");
	const p = paths();
	const { KIT_PY_PACKAGES, SCORE_MODULES } = await import("./paths.mjs");
	return ensurePythonVenv({ python: p.python, venv: p.venv, packages: KIT_PY_PACKAGES, modules: SCORE_MODULES, log: (line) => log(`music kit: ${line}`) });
}

async function git(args, cwd, timeoutMs) {
	const result = await run("git", args, { cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs });
	if (result.code !== 0) throw new Error(`git ${args[0]} failed in ${cwd}: ${(result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ")}`);
	return result;
}

/** The submodule lines of `git submodule status`: a state character, a commit and a path. */
export function parseSubmodules(text) {
	return String(text)
		.split("\n")
		.filter((line) => /^[ +\-U]/.test(line))
		.map((line) => ({ state: line[0], commit: line.slice(1, 41), path: line.slice(42).replace(/\s+\(.*\)$/, "") }));
}

/**
 * Compares the checkout with the pin, and each submodule with the commit the
 * source names. The fetch asks for the full hash, but the identity after the
 * checkout is the only proof that the kit is what the pins say.
 * @param {string} dir
 * @param {any} source
 * @param {{runGit?: typeof git}} [options]
 */
export async function verifyCheckout(dir, source, { runGit = git } = {}) {
	const head = (await runGit(["rev-parse", "HEAD"], dir, 60000)).stdout.trim();
	if (head !== source.commit) {
		throw new Error(`${source.name}: the checkout in ${dir} is ${head}, not the pinned ${source.commit}. The kit was not installed. Check the source URL and the pin, then run wv setup --music again.`);
	}
	const submodules = source.submodules ? parseSubmodules((await runGit(["submodule", "status", "--recursive"], dir, 60000)).stdout) : [];
	const moved = submodules.filter((entry) => entry.state !== " ");
	if (moved.length > 0) {
		throw new Error(`${source.name}: ${moved.length} submodule(s) are not at their pinned commits (${moved.map((entry) => `${entry.state === "-" ? "not initialised" : entry.state === "U" ? "conflicted" : "moved"}: ${entry.path}`).join(", ")}). The kit was not installed. Remove the staging folder and run wv setup --music again.`);
	}
	return { head, submodules };
}

/**
 * Fetches one source at its pinned commit; a sparse source downloads only its folders.
 * @param {any} source
 * @param {string} dir
 * @param {Log} [log]
 */
export async function fetchSource(source, dir, log = () => {}) {
	mkdirSync(dir, { recursive: true });
	log(`${source.name} ${short(source.commit)}: ${source.url}`);
	await git(["init", "--quiet"], dir, 60000);
	await git(["remote", "add", "origin", source.url], dir, 60000);
	if (source.folders) {
		await git(["sparse-checkout", "init", "--no-cone"], dir, 60000);
		await git(["sparse-checkout", "set", ...source.folders], dir, 60000);
	}
	// A partial clone asks for the pinned commit only, so a later branch never moves the kit.
	await git(["fetch", "--depth", "1", ...(source.folders ? ["--filter=blob:none"] : []), "origin", source.commit], dir, 30 * 60_000);
	await git(["checkout", "--quiet", "FETCH_HEAD"], dir, 10 * 60_000);
	if (source.submodules) await git(["submodule", "update", "--init", "--recursive", "--depth", "1"], dir, 30 * 60_000);
	return verifyCheckout(dir, source);
}

/**
 * Builds sfizz_render only: no JACK, LV2, VST, demos or tests.
 * @param {string} src
 * @param {string} binPath
 * @param {Log} [log]
 */
export async function buildSfizz(src, binPath, log = () => {}) {
	const build = join(src, "build");
	log("building sfizz_render with cmake (Release; no JACK, LV2, VST or tests)");
	const generator = buildGenerator();
	const configureArgs = ["-S", src, "-B", build, "-DCMAKE_BUILD_TYPE=Release", "-DSFIZZ_JACK=OFF", "-DSFIZZ_TESTS=OFF", "-DSFIZZ_DEMOS=OFF", "-DSFIZZ_DEVTOOLS=OFF", "-DSFIZZ_BENCHMARKS=OFF", "-DSFIZZ_RENDER=ON", "-DSFIZZ_SHARED=OFF"];
	// Ninja when it is there: the same generator that kitTools checked, so the check and the build agree.
	if (generator?.name === "Ninja") configureArgs.push("-G", "Ninja");
	const configure = await run("cmake", configureArgs, { timeoutMs: 10 * 60_000 });
	if (configure.code !== 0) throw new Error(`cmake configure failed: ${(configure.stderr || configure.stdout).trim().split("\n").slice(-3).join(" ")}`);
	const jobs = String(Math.max(1, Math.min(16, cpus().length)));
	const built = await run("cmake", ["--build", build, "--target", "sfizz_render", "-j", jobs], { timeoutMs: 60 * 60_000 });
	if (built.code !== 0) throw new Error(`the sfizz build failed: ${(built.stderr || built.stdout).trim().split("\n").slice(-3).join(" ")}`);
	const binary = findBuilt(build, "sfizz_render");
	if (!binary) throw new Error(`the sfizz build wrote no sfizz_render under ${build}`);
	mkdirSync(dirname(binPath), { recursive: true });
	copyFileSync(binary, binPath);
	chmodSync(binPath, 0o755);
	log(`installed ${binPath} (${formatBytes(statSync(binPath).size)})`);
}

function findBuilt(dir, name, depth = 4) {
	const direct = [join(dir, "library", "bin", name), join(dir, "clients", name), join(dir, "bin", name)];
	for (const candidate of direct) if (existsSync(candidate)) return candidate;
	if (depth === 0) return null;
	let entries = [];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return null;
	}
	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === ".git") continue;
		const found = findBuilt(join(dir, entry.name), name, depth - 1);
		if (found) return found;
	}
	return null;
}

/**
 * Writes the drum kit and mallet maps from the VCSL samples (py/make_vcsl_sfz.py).
 * @param {string} vcslDir
 * @param {string} out
 * @param {string} python
 * @param {Log} [log]
 */
async function generateMaps(vcslDir, out, python, log = () => {}) {
	log("writing kit.sfz, marimba.sfz and glock.sfz");
	const result = await run(python, [join(PY_DIR, "make_vcsl_sfz.py"), "--src", vcslDir, "--out", out], { timeoutMs: 10 * 60_000 });
	if (result.code !== 0) throw new Error(`the SFZ map step failed: ${(result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ")}`);
	for (const file of ["kit.sfz", "marimba.sfz", "glock.sfz"]) if (!existsSync(join(out, file))) throw new Error(`the SFZ map step wrote no ${file} in ${out}`);
}

/**
 * Trims the leading silence of the piano samples, so a piano hit lands on its frame.
 * @param {string} folder
 * @param {string} python
 * @param {Log} [log]
 */
async function trimSamples(folder, python, log = () => {}) {
	log(`trimming the leading silence of ${folder}`);
	const result = await run(python, [join(PY_DIR, "trim_samples.py"), folder, "--threshold-db", "-66", "--max-ms", "15"], { timeoutMs: 10 * 60_000 });
	if (result.code !== 0) throw new Error(`the sample trim failed: ${(result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ")}`);
	for (const line of result.stdout.trim().split("\n").filter(Boolean)) log(`  ${line}`);
}

function copyLicences(staging) {
	const dir = join(staging, "licenses");
	mkdirSync(dir, { recursive: true });
	const pairs = [
		[join(staging, "sources", "sfizz", "LICENSE"), "sfizz-LICENSE"],
		[join(staging, "sources", "VCSL", "LICENSE"), "vcsl-LICENSE"],
		[join(staging, "samples", "salamander", "LICENSE"), "salamander-LICENSE"],
	];
	for (const [from, name] of pairs) if (existsSync(from)) copyFileSync(from, join(dir, name));
}

function writeManifest(staging, smoke, verified = {}) {
	const entry = (name) => {
		const pin = MUSIC_KIT_PINS[name];
		const seen = verified[name];
		return {
			url: pin.url,
			commit: pin.commit,
			licence: pin.licence,
			// The identity that git reported after the checkout, not only the pin asked for.
			checkout: seen?.head ?? null,
			...(pin.submodules ? { submodules: (seen?.submodules ?? []).map((one) => ({ path: one.path, commit: one.commit })) } : {}),
		};
	};
	const manifest = {
		version: 1,
		installedAt: new Date().toISOString(),
		sampleRate: MUSIC_KIT_SAMPLE_RATE,
		sfizz: entry("sfizz"),
		vcsl: entry("vcsl"),
		salamander: { ...entry("salamander"), attribution: MUSIC_KIT_ATTRIBUTION },
		smoke: smoke.map((item) => ({ name: item.name, detail: item.detail })),
	};
	writeFileSync(join(staging, "kit.json"), `${JSON.stringify(manifest, null, 1)}\n`);
}

/** True when a folder, a file or a link is at `path`. */
function existsAt(path) {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/** wv never deletes or replaces a kit folder: the owner moves it, or sets WV_MUSIC_KIT. */
function replaceRefusal(kit, first = "") {
	return `${first}wv does not delete or replace a kit folder. Move it aside (mv "${kit}" "${kit}.old"), or set WV_MUSIC_KIT to another folder, then run wv setup --music again.`;
}

/** Refuses an existing kit path before the probes and the download, with the first failed check item. */
function refuseExistingRoot(kit, report) {
	if (!existsAt(kit)) return;
	const failed = report.items.find((item) => !item.ok);
	throw new Error(replaceRefusal(kit, failed ? `${failed.name}: ${failed.detail}. ` : ""));
}

/** Whether a process with this pid still runs. EPERM means it exists but is not ours. */
function processAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

function readLock(lock) {
	try {
		const parsed = JSON.parse(readFileSync(lock, "utf8"));
		return parsed && typeof parsed === "object" ? parsed : null;
	} catch {
		return null;
	}
}

/** Why this lock cannot be taken, from what the file says. */
function lockRefusal(lock) {
	const owner = readLock(lock);
	if (owner && Number.isInteger(owner.pid) && processAlive(owner.pid)) {
		return `another wv setup --music is installing the kit (pid ${owner.pid}, started ${owner.started ?? "unknown"}). Wait for it to finish.`;
	}
	return `a lock from an earlier install remains at ${lock}. If no install runs now, remove it (rm "${lock}"), then run wv setup --music again.`;
}

/**
 * One install at a time per kit. The lock is a file that O_EXCL makes in one
 * atomic step, so two starts cannot both enter. wv never removes or takes over
 * a lock: a lock whose owner is gone needs one command from the user, and no
 * automatic recovery can delete the lock that another install just made.
 * @param {string} kit
 */
function acquireKitLock(kit) {
	const lock = `${kit}.lock`;
	const token = randomUUID();
	// Write the record first, then link it into place: a reader never sees an empty lock.
	const temp = `${lock}.${process.pid}.${token}`;
	writeFileSync(temp, `${JSON.stringify({ pid: process.pid, token, started: new Date().toISOString() })}\n`, { mode: 0o600, flag: "wx" });
	try {
		linkSync(temp, lock);
	} catch (error) {
		if (error?.code !== "EEXIST") throw error;
		throw new Error(lockRefusal(lock));
	} finally {
		rmSync(temp, { force: true });
	}
	return {
		release: () => {
			// A lock that another install has made since is not this run's to remove.
			if (readLock(lock)?.token === token) rmSync(lock, { force: true });
		},
	};
}

/** The staging names that belong to this kit. Only this run's own folder is wv's to remove. */
function stagingFamily(kit) {
	return `.music-kit.staging-${basename(kit)}-`;
}

/** The prefix that proves a staging folder belongs to this kit and this run. */
function stagingPrefix(kit) {
	return `${stagingFamily(kit)}${process.pid}-`;
}

/**
 * Names the staging folders that earlier installs left behind. wv removes only
 * the folder that this run made: the others may not be its to delete, so the
 * note gives the command and the owner runs it.
 * @param {string} kit
 * @param {Log} [log]
 */
function noteLeftoverStaging(kit, log = () => {}) {
	const parent = dirname(kit);
	let names = [];
	try {
		names = readdirSync(parent);
	} catch {
		return;
	}
	const leftovers = names.filter((name) => name.startsWith(stagingFamily(kit))).map((name) => join(parent, name));
	if (leftovers.length === 0) return;
	log(`music kit: leftover staging folders from earlier installs use disk space: ${leftovers.join(", ")}. If no install runs now, remove them: rm -rf ${leftovers.join(" ")}`);
}

/**
 * Installs the kit into a path that does not exist. Nothing downloads when the
 * kit already passes the check, and an existing kit folder is never replaced.
 * @param {{kit?: string, log?: Log, deps?: any}} [options]
 */
export async function installMusicKit({ kit = paths().musicKit, log = () => {}, deps = {} } = {}) {
	const d = { ...kitDeps({ log }), ...deps };
	const existing = await checkMusicKit({ kit, smoke: d.smoke, log: () => {} });
	if (existing.ok) {
		log(`music kit: already installed at ${kit} (the smoke render passes, so nothing is downloaded)`);
		return existing;
	}
	// Before the probe, the lock and the download: wv never replaces a kit folder.
	refuseExistingRoot(kit, existing);

	const refusal = toolRefusal(await d.tools());
	if (refusal) throw new Error(refusal);
	mkdirSync(dirname(kit), { recursive: true, mode: 0o700 });
	const lock = acquireKitLock(kit);
	/** Only the folder this run made is ever removed. */
	let staging = null;
	// A signal runs no finally: the staging folder and this run's lock must go anyway.
	const stopCleanup = onSignalCleanup(() => {
		if (staging) rmSync(staging, { recursive: true, force: true });
		lock.release();
	}, "the music kit staging folder");
	try {
		// An install that ended while this one waited may have made the root: look again.
		const now = await checkMusicKit({ kit, smoke: d.smoke, log: () => {} });
		if (now.ok) {
			log(`music kit: already installed at ${kit} (the smoke render passes, so nothing is downloaded)`);
			return now;
		}
		refuseExistingRoot(kit, now);
		// Only this run's folder is wv's to remove: name the leftovers, do not delete them.
		noteLeftoverStaging(kit, log);
		const free = d.freeBytes(dirname(kit));
		if (free < MUSIC_KIT_NEED_BYTES) throw new Error(`the music kit needs ${formatBytes(MUSIC_KIT_NEED_BYTES)} free at ${dirname(kit)} and only ${formatBytes(free)} is free. Free some space, then run wv setup --music again.`);
		log(`music kit: ${formatBytes(MUSIC_KIT_DOWNLOAD_BYTES)} to download, ${formatBytes(MUSIC_KIT_NEED_BYTES)} of space needed, ${formatBytes(free)} free, at ${kit}`);

		const python = await d.python();
		// Unique per run and in the kit's parent, so the last rename stays on one filesystem.
		// The name carries the kit and this pid, so a later run can prove a leftover is ours.
		staging = mkdtempSync(join(dirname(kit), stagingPrefix(kit)));
		log(`1/5 sfizz ${short(MUSIC_KIT_PINS.sfizz.commit)} (${formatBytes(MUSIC_KIT_PINS.sfizz.bytes)} with its submodules)`);
		const sfizzSrc = join(staging, "sources", "sfizz");
		const verified = { sfizz: await d.fetch(MUSIC_KIT_PINS.sfizz, sfizzSrc) };
		await d.build(sfizzSrc, join(staging, "bin", "sfizz_render"));

		log(`2/5 VCSL ${short(MUSIC_KIT_PINS.vcsl.commit)} (${formatBytes(MUSIC_KIT_PINS.vcsl.bytes)}, 10 sample folders)`);
		const vcslSrc = join(staging, "sources", "VCSL");
		verified.vcsl = await d.fetch(MUSIC_KIT_PINS.vcsl, vcslSrc);

		log(`3/5 Salamander Grand Piano V3 ${short(MUSIC_KIT_PINS.salamander.commit)} (${formatBytes(MUSIC_KIT_PINS.salamander.bytes)}, ${MUSIC_KIT_PINS.salamander.licence})`);
		const pianoSrc = join(staging, "sources", "salamander");
		verified.salamander = await d.fetch(MUSIC_KIT_PINS.salamander, pianoSrc);
		mkdirSync(join(staging, "samples"), { recursive: true });
		renameSync(pianoSrc, join(staging, "samples", "salamander"));
		// The piano's git history is another 714 MB; the samples and their licence are the kit.
		rmSync(join(staging, "samples", "salamander", ".git"), { recursive: true, force: true });

		log("4/5 building the sample maps and trimming the piano samples");
		await d.generate(vcslSrc, join(staging, "samples", "vcsl"), python);
		await d.trim(join(staging, "samples", "salamander", "Samples"), python);
		copyLicences(staging);

		log("5/5 smoke render: one MIDI pass through each SFZ");
		const smoke = await d.smoke(staging);
		const failed = smoke.filter((item) => !item.ok);
		if (failed.length > 0) throw new Error(`the music kit smoke render failed (${failed.map((item) => `${item.name}: ${item.detail}`).join("; ")}). The kit was not installed.`);

		// The cloned sources are build input only; the kit keeps the samples and the licences.
		rmSync(join(staging, "sources"), { recursive: true, force: true });
		writeManifest(staging, smoke, verified);
		// A stop must never publish a half kit, and publication is one rename into a missing path.
		assertNotStopping("the kit publication");
		if (existsAt(kit)) throw new Error(replaceRefusal(kit, `a kit folder appeared at ${kit} while this install ran. `));
		renameSync(staging, kit);
		staging = null;
	} finally {
		// During a stop the shutdown owns these: it runs the cleanup after the child trees are gone,
		// so a descendant that ignores SIGTERM cannot see a missing staging folder or lock.
		if (!isStopping()) {
			try {
				if (staging) rmSync(staging, { recursive: true, force: true });
				lock.release();
			} finally {
				stopCleanup();
			}
		}
	}
	log(`music kit: installed at ${kit}`);
	log(`music kit: a published film that uses the piano carries "${MUSIC_KIT_ATTRIBUTION}"`);
	return checkMusicKit({ kit, smoke: d.smoke, log: () => {} });
}
