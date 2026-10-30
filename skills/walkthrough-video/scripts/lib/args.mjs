/**
 * Command line parsing for wv. Every failure is a UsageError with one clear
 * sentence: the option, the value and the accepted range.
 */
import { parseArgs } from "node:util";
import { GSAP, HYPERFRAMES, PLAYWRIGHT_CORE, TYPESCRIPT, pythonPackageNames } from "./paths.mjs";
import { MUSIC_KIT_ATTRIBUTION, MUSIC_KIT_DOWNLOAD_BYTES, MUSIC_KIT_PINS, formatBytes } from "./music-kit.mjs";

export class UsageError extends Error {}

const COMMAND_NAMES = ["setup", "capture", "voice", "compose", "gates", "render", "preview", "review", "film", "lift", "sound", "check", "measure", "taste"];
/** The film kit commands parse their own arguments and print their own --help (scripts/film/<name>.mjs). */
export const FILM_COMMANDS = ["film", "lift", "sound", "check", "measure", "taste"];

export const DEFAULTS = { fps: 60, scale: 2, width: 1280, height: 720, gpu: "auto", crf: 12, voice: "am_michael", speed: 1, clock: "virtual" };

function fail(message) {
	throw new UsageError(message);
}

function integer(value, flag, min, max) {
	const number = Number(value);
	if (!Number.isInteger(number) || number < min || number > max) fail(`${flag} must be an integer from ${min} to ${max} (got "${value}")`);
	return number;
}

function decimal(value, flag, min, max) {
	const number = Number(value);
	if (!Number.isFinite(number) || number < min || number > max) fail(`${flag} must be a number from ${min} to ${max} (got "${value}")`);
	return number;
}

function required(values, key, flag) {
	const value = values[key];
	if (value === undefined || value === "") fail(`${flag} is required`);
	return value;
}

function positional(positionals, name, command) {
	const [first] = positionals;
	if (!first) fail(`wv ${command} needs a ${name}`);
	if (positionals.length > 1) fail(`wv ${command} takes one ${name} (got "${positionals.slice(1).join(" ")}")`);
	return first;
}

/**
 * Returns the normalised command, or { help: true } / { command, help: true }.
 * `compose` is passed through untouched: its options belong to compose.mjs.
 */
export function parseCommandLine(argv) {
	if (!Array.isArray(argv) || argv.length === 0) fail(`wv needs a subcommand: ${COMMAND_NAMES.join(", ")}. Try "wv --help".`);
	const [command, ...rest] = argv;
	if (command === "--help" || command === "-h" || command === "help") {
		if (rest[0] && FILM_COMMANDS.includes(rest[0])) return { command: rest[0], argv: [rest[0], "--help"], film: true };
		return rest[0] && COMMAND_NAMES.includes(rest[0]) ? { command: rest[0], help: true } : { help: true };
	}
	if (!COMMAND_NAMES.includes(command)) fail(`Unknown subcommand "${command}". Known subcommands: ${COMMAND_NAMES.join(", ")}. Try "wv --help".`);
	if (FILM_COMMANDS.includes(command)) return { command, argv, film: true };
	const wantsHelp = rest.includes("--help") || rest.includes("-h");
	if (wantsHelp) return { command, help: true };
	if (command === "compose" || command === "render" || command === "preview" || command === "review") return { command, argv };

	let parsed;
	try {
		parsed = parseArgs({ args: rest, allowPositionals: true, strict: true, options: OPTIONS[command] });
	} catch (error) {
		fail(`${command}: ${error.message}`);
	}
	const { values, positionals } = parsed;

	if (command === "setup") {
		if (positionals.length > 0) fail(`wv setup takes no arguments (got "${positionals.join(" ")}")`);
		return { command, check: Boolean(values.check), json: Boolean(values.json), music: Boolean(values.music) };
	}
	if (command === "capture") {
		// A draft is a cheap look at the take: wall clock, scale 1, 10 fps, and a contact sheet.
		if (values.draft) return { ...captureOptions(values, positionals, command), draft: true, scale: 1, clock: "real", fps: 10, crf: 28 };
		return captureOptions(values, positionals, command);
	}
	if (command === "voice") {
		return {
			command,
			script: positional(positionals, "script file", command),
			out: required(values, "out", "--out"),
			voice: values.voice ?? DEFAULTS.voice,
			speed: decimal(values.speed ?? DEFAULTS.speed, "--speed", 0.5, 2),
		};
	}
	return {
		command,
		project: positional(positionals, "project directory", command),
		capture: required(values, "capture", "--capture"),
		json: Boolean(values.json),
	};
}

function captureOptions(values, positionals, command) {
	return {
		command,
		flow: positional(positionals, "flow module", command),
		out: required(values, "out", "--out"),
		fps: integer(values.fps ?? DEFAULTS.fps, "--fps", 1, 240),
		scale: integer(values.scale ?? DEFAULTS.scale, "--scale", 1, 4),
		width: integer(values.width ?? DEFAULTS.width, "--width", 16, 8192),
		height: integer(values.height ?? DEFAULTS.height, "--height", 16, 8192),
		gpu: enumValue(values.gpu ?? DEFAULTS.gpu, "--gpu", ["auto", "on", "off"]),
		crf: integer(values.crf ?? DEFAULTS.crf, "--crf", 0, 51),
		clock: enumValue(values.clock ?? DEFAULTS.clock, "--clock", ["virtual", "real"]),
		textEvery: values["text-every"] === undefined ? 0 : integer(values["text-every"], "--text-every", 33, 60000),
		draft: false,
	};
}

function enumValue(value, flag, allowed) {
	if (!allowed.includes(value)) fail(`${flag} must be one of ${allowed.join(", ")} (got "${value}")`);
	return value;
}

const OPTIONS = {
	setup: { check: { type: "boolean" }, json: { type: "boolean" }, music: { type: "boolean" } },
	capture: {
		out: { type: "string" },
		fps: { type: "string" },
		scale: { type: "string" },
		width: { type: "string" },
		height: { type: "string" },
		gpu: { type: "string" },
		crf: { type: "string" },
		clock: { type: "string" },
		"text-every": { type: "string" },
		draft: { type: "boolean" },
	},
	voice: { out: { type: "string" }, voice: { type: "string" }, speed: { type: "string" } },
	gates: { capture: { type: "string" }, json: { type: "boolean" } },
};

const CAPTURE_USAGE = `Usage: wv capture <flow.mjs> --out <dir> [options]

Runs a flow against a page and writes capture.mp4, events.json and poster.png.

Options:
  --out <dir>       output directory (required)
  --fps <n>         frame rate, 1 to 240 (default ${DEFAULTS.fps})
  --scale <n>       device scale factor, 1 to 4 (default ${DEFAULTS.scale})
  --width <px>      viewport width (default ${DEFAULTS.width})
  --height <px>     viewport height (default ${DEFAULTS.height})
  --gpu auto|on|off beginFrame on the GPU, or fall back to software raster (default auto)
  --crf <n>         x264 quality, 0 to 51, lower is better (default ${DEFAULTS.crf})
  --clock virtual|real  virtual (default): the page's timers, animation frames and CSS
                    animations advance exactly one frame per captured frame, so a slow
                    host makes the capture slower, never jerkier. real: wall-clock
                    slots, and a missed slot repeats the last image.
  --draft           a cheap look at the take before the frame-exact capture: wall clock,
                    scale 1, 10 fps, and sheet.jpg (a frame every 0.5 s with its time). On a
                    slow page (WebGL in software) it shows a crash or a wall in seconds.
  --text-every <ms> also record the app's text every <ms> of app time (33 to 60000), not
                    only after each settled step, so a HUD value has a time series
                    (events.json "texts"; virtual clock only; a shot's follow reads it).

The flow module exports default async function (wv) { ... } and uses:
  await wv.goto(url, {name})              navigate and record a goto event
  await wv.click(selector, {name, label}) move the real mouse there, then click
  await wv.type(selector, text, {name, delayMs, secret}) click, then press keys (70 ms apart)
  await wv.hover(selector, {name})        move the real mouse onto the target
  await wv.scroll(selector | {y}, {name}) scroll an element into view or the page
  await wv.wait(ms, {name})               let the app run for ms of app time; the camera stays
  await wv.sleep(ms)                      let ms of app time pass, with no event (not page.waitForTimeout)
  await wv.key(key, {name})               press a key (Playwright key names); the mouse stays put
  await wv.waitFor(fn | selector, {name, timeoutMs, state}) wait for a page function or a selector
  await wv.mark(name, {selector, caption}) record a point for the composer; with a
                                          selector it records the box of the text, or of an
                                          input's value, not the whole element
  wv.say(text)                            add a cue line at the current frame
  await wv.secondary()                    a second, uncaptured Playwright Page (another user)
  wv.page, wv.fps, wv.viewport, wv.frames(), wv.dir

Every action waits for the DOM to be quiet (300 ms, 3 s cap) and records
startFrame, endFrame, settleFrame, target, caret, changed, fontPx and the text.

events.json also records what the frames show: stats.distinct (frames with a new
image), the stills (runs of repeated frames), stats.frameMs (draw time p50 and p95),
stats.load and stats.cores (the host), and stats.canvas. At the end, capture warns
when fewer than 5 % of the frames are new, or when the flow idled for over 10 s.`;

const USAGE = {
	root: `Usage: wv <subcommand> [options]

Subcommands:
  setup     install playwright-core, hyperframes, gsap, the browsers, ffmpeg use and the Kokoro voice into the cache; --music adds the optional music kit
  capture   record a flow as capture.mp4 plus events.json (the capture clock)
  voice     synthesize the narration script with the local Kokoro model
  compose   build the HyperFrames project from events.json and shots.json
  gates     run the measured gates on a project and its capture
  render    render the project to MP4 (or --gif) with HyperFrames
  preview   render a 640x360, 30 fps copy in about a minute, for a quick look
  review    write the HyperFrames review sheets and print their paths

The film kit (a film the author writes as code; see SKILL.md):
  film      film new|build|preview|render|stills: the project template, the bundle and the renders
  lift      read a live app's design tokens and save app states as markup with its own CSS
  sound     mix a cue sheet and a music bed offline; tempo, the biggest lift, the master
  check     block a film on objective defects (repeated frames at cuts, freezes, colors, text, loudness, private data)
  measure   the film's numbers next to the reference films (advice only)
  taste     print the taste file, or add an owner note to it

Options:
  --help, -h   show this text, or the text of one subcommand

Try "wv <subcommand> --help" for the options of a subcommand.`,
	setup: `Usage: wv setup [--check] [--json] [--music]

Installs the runtime into \${XDG_CACHE_HOME:-~/.cache}/pi-walkthrough-video:
playwright-core ${PLAYWRIGHT_CORE} and hyperframes ${HYPERFRAMES} exactly, gsap ${GSAP} and typescript
${TYPESCRIPT} for the film project, chromium-headless-shell and chromium, a uv venv with
${pythonPackageNames().join(", ")}, and the two Kokoro model files.
Reuses ~/.local/share/kokoro-tts when the SHA-256 matches. ffmpeg must be on PATH.

The music kit is optional: it holds the sampled instruments that wv sound score plays.
It needs git, cmake and a C++ compiler, and installs into <cache>/music-kit.

Options:
  --music   install the music kit only: build sfizz_render ${MUSIC_KIT_PINS.sfizz.commit.slice(0, 7)}
            (BSD-2-Clause), fetch VCSL ${MUSIC_KIT_PINS.vcsl.commit.slice(0, 7)} (CC0 1.0, 10 sample
            folders) and the Salamander Grand Piano V3 ${MUSIC_KIT_PINS.salamander.commit.slice(0, 7)}
            (CC BY 3.0), write kit.sfz, marimba.sfz and glock.sfz, trim the piano samples and run
            a smoke render of every SFZ. About ${formatBytes(MUSIC_KIT_DOWNLOAD_BYTES)} download and 10 min.
            Nothing downloads when the kit already passes --check. The staging folder moves into
            place only when every part passed, so a failure leaves no half kit.
  --check   report what is missing; install nothing (exit 1 if something is missing). With
            --music, report each part of the kit and its smoke render.
  --json    print the report as JSON

A published film that uses the piano carries: ${MUSIC_KIT_ATTRIBUTION}`,
	capture: CAPTURE_USAGE,
	voice: `Usage: wv voice <script.json> --out <dir> [--voice am_michael] [--speed 1.0]

script.json is [{"id": "l1", "text": "..."}]. Writes <dir>/<id>.wav (24 kHz)
and <dir>/voice.json with [{id, text, file, seconds}]. Runs only the local model.

Options:
  --out <dir>       output directory (required)
  --voice <name>    am_*, af_*, bm_* or bf_* Kokoro voice (default ${DEFAULTS.voice})
  --speed <n>       0.5 to 2.0 (default ${DEFAULTS.speed})`,
	gates: `Usage: wv gates <projectDir> --capture <captureDir> [--json]

Reads <projectDir>/plan.json and <captureDir>/events.json, then runs the measured gates.
Prints one line per gate with its id, pass, fail or skip, and the time it took.
A failing gate prints a "Fix:" line. Exit code 1 on any fail.

Options:
  --capture <dir>   the directory that wv capture wrote (required)
  --json            print one JSON object instead of lines`,
	compose: `Usage: wv compose <captureDir> --shots <shots.json> --out <projectDir> [--voice <voiceDir>]

Writes edit.mp4, plan.json and index.html (a HyperFrames project) from events.json and the shot list.`,
	render: `Usage: wv render <projectDir> [--out file.mp4] [--quality delivery|looks|draft] [--gif] [--keep-cache]

Renders with HyperFrames at the plan's fps and writes walkthrough.mp4 beside the project.
Before it starts, wv checks that the HyperFrames frame cache fits on the temp filesystem and
refuses with the numbers and the cache path when it does not. The render extracts into its own
folder there, and wv deletes that folder afterwards, also after a failure.

Options:
  --out <file>      output path (default <project>/walkthrough.mp4)
  --quality <name>  delivery, looks or draft
  --gif             a 15 fps GIF instead
  --keep-cache      keep this render's own frame cache folder (about 1 GB a minute at 1080p);
                    no later render reads it, so delete it by hand`,
	preview: `Usage: wv preview <projectDir> [--out file.mp4]

Writes <project>/preview.html (the same composition at 640x360) and renders it at 30 fps with
quality draft and no page motion blur. Use it for a quick look at the whole video; the delivery
render is still wv render. The frame cache folder of the preview is deleted afterwards.

Options:
  --out <file>      output path (default <project>/preview.mp4)`,
	review: `Usage: wv review <projectDir> [--out <dir>]

Writes the review sheets from plan.json: a beat sheet, a phone sheet and one seam sheet per shot
cut, then prints their paths. The stills come from one HyperFrames snapshot call, so it takes
seconds rather than minutes.

Options:
  --out <dir>   write the sheets here (default <project>/.hyperframes/artifacts/review-<stamp>)`,
};

export function usageText(command) {
	if (command === undefined) return USAGE.root;
	if (!USAGE[command]) fail(`Unknown subcommand "${command}". Known subcommands: ${COMMAND_NAMES.join(", ")}.`);
	return USAGE[command];
}

export { COMMAND_NAMES };
