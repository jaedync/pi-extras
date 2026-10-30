#!/usr/bin/env node
/**
 * wv: frame-exact walkthrough videos of web apps.
 *
 *   wv setup     install the runtime into the user cache
 *   wv capture   record a flow to capture.mp4 + events.json
 *   wv voice     synthesize narration with the local Kokoro model
 *   wv compose   build the HyperFrames project (compose.mjs)
 *   wv gates     run the measured gates on a project and its capture
 *   wv render    render with HyperFrames; wv preview renders a small quick copy
 *   wv review    write the review sheets
 *
 * The film kit (scripts/film/): film, lift, sound, check, measure, taste.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { UsageError, parseCommandLine, usageText } from "./lib/args.mjs";

const STDOUT = (text) => process.stdout.write(`${text}\n`);
const STDERR = (text) => process.stderr.write(`${text}\n`);

async function runSetup(options) {
	const log = options.json ? () => {} : STDERR;
	let report;
	if (options.music) {
		// The music kit is its own install: it builds a sampler and downloads sample sets.
		const { checkMusicKit, installMusicKit } = await import("./lib/music-kit.mjs");
		report = options.check ? await checkMusicKit({ log }) : await installMusicKit({ log });
	} else {
		const { checkSetup, installSetup } = await import("./lib/setup.mjs");
		report = options.check ? await checkSetup(log) : await installSetup(log);
	}
	if (options.json) STDOUT(JSON.stringify(report, null, 1));
	return report.ok ? 0 : 1;
}

async function runCapture(options) {
	const { capture } = await import("./lib/capture.mjs");
	const result = await capture({ ...options, log: (line) => STDERR(`capture: ${line}`) });
	STDOUT(`${result.eventsFile}\n${result.video}\n${result.poster}\n${result.frames} frames, ${result.stats.distinct} distinct, ${result.events.length} events, ${result.cues.length} cues, GPU ${result.gpu ? "on" : "off"}, host load ${(result.load ?? []).map((v) => v.toFixed(2)).join(" ") || "unknown"}`);
	// The warnings go to stdout with the paths, so an agent that reads only the last lines still sees them.
	for (const warning of result.warnings ?? []) STDOUT(`warning: ${warning}`);
	return 0;
}

async function runVoice(options) {
	const { voice } = await import("./lib/voice.mjs");
	const result = await voice({ ...options, log: (line) => STDERR(line) });
	STDOUT(`${result.out}/voice.json\n${result.lines.length} line(s), ${result.lines.reduce((sum, line) => sum + line.seconds, 0).toFixed(2)} s of speech`);
	return 0;
}

async function runGates(options) {
	const { runGates } = await import("./lib/gates-run.mjs");
	const result = await runGates({ ...options, log: options.json ? () => {} : STDOUT });
	if (options.json) STDOUT(JSON.stringify(result, null, 1));
	else STDOUT(result.ok ? "\nall gates pass" : "\nFAILED: fix the gates above, then run wv gates again");
	return result.ok ? 0 : 1;
}

async function runCompose(argv) {
	let compose;
	try {
		compose = await import("./compose.mjs");
	} catch (error) {
		if (/Cannot find module|ERR_MODULE_NOT_FOUND/.test(error?.message ?? "")) {
			STDERR("wv compose is not installed in this checkout: compose.mjs is missing beside wv.mjs.");
			return 2;
		}
		throw error;
	}
	if (typeof compose.main !== "function") {
		STDERR("compose.mjs does not export main(argv).");
		return 2;
	}
	const code = await compose.main(argv);
	return typeof code === "number" ? code : 0;
}

export async function main(argv) {
	let parsed;
	try {
		parsed = parseCommandLine(argv);
	} catch (error) {
		if (error instanceof UsageError) {
			STDERR(`wv: ${error.message}`);
			return 2;
		}
		throw error;
	}
	if (parsed.film) {
		try {
			const module = await import(`./film/${parsed.command}.mjs`);
			const code = await module.main(parsed.argv.slice(1));
			return typeof code === "number" ? code : 0;
		} catch (error) {
			STDERR(`wv ${parsed.command}: ${String(error?.message ?? error).trim()}`);
			return error instanceof UsageError ? 2 : 1;
		}
	}
	if (parsed.help) {
		STDOUT(usageText(parsed.command));
		return 0;
	}
	try {
		switch (parsed.command) {
			case "setup":
				return await runSetup(parsed);
			case "capture":
				return await runCapture(parsed);
			case "voice":
				return await runVoice(parsed);
			case "gates":
				return await runGates(parsed);
			case "render":
			case "preview":
			case "review": {
				const hf = await import("./hf.mjs");
				return await hf[parsed.command](parsed.argv.slice(1));
			}
			case "compose":
				// compose.mjs parses the args after the subcommand, like the other commands.
				return await runCompose(parsed.argv.slice(1));
			default:
				STDERR(`wv: unknown subcommand "${parsed.command}"`);
				return 2;
		}
	} catch (error) {
		STDERR(`wv ${parsed.command}: ${String(error?.message ?? error).trim()}`);
		return 1;
	}
}

/**
 * True when this file is the program, not a module that another file imported.
 * The paths are resolved first: a user links wv into ~/bin, and the link's path
 * never equals the real path of the file, which made wv a silent no-op.
 */
function invokedDirectly() {
	try {
		return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}
if (invokedDirectly()) {
	const { installSignalHandlers } = await import("./lib/signals.mjs");
	// Before any work: a host timeout or a Ctrl-C must not leave a preview file or a child behind.
	installSignalHandlers();
	const { raiseOomScore } = await import("./lib/oom.mjs");
	// A bad WV_OOM_SCORE_ADJ is the user's to fix; a refused write only means renders keep the default score.
	const oom = raiseOomScore();
	if (oom.error?.startsWith("WV_OOM_SCORE_ADJ")) STDERR(`wv: ${oom.error}`);
	process.exitCode = await main(process.argv.slice(2));
}
