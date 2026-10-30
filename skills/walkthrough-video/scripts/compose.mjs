// wv compose <captureDir> --shots shots.json --out <projectDir> [--voice <voiceDir>]
// Writes a HyperFrames project: edit.mp4 (the capture cut and retimed), index.html, plan.json.
import { run } from "./lib/proc.mjs";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { SPEC, layoutClips } from "./lib/compose-plan.mjs";
import { describeProblems, validateEvents, validateShots } from "./lib/schema.mjs";
import { buildCamera, buildCaptions, buildCursor, buildVoice } from "./lib/compose-timeline.mjs";
import { lookOf, renderHtml } from "./lib/compose-html.mjs";
import { projectFont } from "./lib/compose-font.mjs";

const USAGE = "Usage: wv compose <captureDir> --shots <shots.json> --out <projectDir> [--voice <voiceDir>]";
const readJson = (p, what) => {
	try {
		return JSON.parse(readFileSync(p, "utf8"));
	} catch (e) {
		throw new Error(`Cannot read ${what} at ${p}: ${e.message}`);
	}
};

/** Pure: events + shots (+ voice lines) to plan.json. */
export function buildPlan(capture, shots, voiceLines = []) {
	const problems = validateShots(shots, capture.events);
	if (problems.length) throw new Error(`shots.json: ${describeProblems(problems)}`);
	const source = { width: capture.viewport.width, height: capture.viewport.height, scale: capture.viewport.scale };
	const output = { width: shots.output?.width ?? SPEC.output.width, height: shots.output?.height ?? SPEC.output.height };
	// The video is drawn to fill the frame; another aspect ratio would stretch it under the camera.
	const skew = Math.abs(source.width / source.height / (output.width / output.height) - 1);
	if (skew > 0.005) throw new Error(`the capture is ${source.width}x${source.height}, which is not the output's ${output.width}x${output.height} aspect ratio (16:9 by default). Capture again with a 16:9 size, for example --width 1024 --height 576.`);
	const fps = capture.fps;
	const byId = new Map(capture.events.map((e) => [e.id, e]));
	const voiceById = new Map(voiceLines.map((v) => [v.id, v]));
	const introS = shots.intro?.title ? SPEC.introS : 0;
	const outroS = shots.outro?.title ? SPEC.outroS : 0;
	const editStart = introS ? introS - 0.35 : 0;
	const { clips, spans, end } = layoutClips(shots.shots, byId, capture, voiceById, editStart);
	// The last camera move goes back to the whole page under the outro card, so the last shot keeps its
	// focus until its caption and voice line end. With no outro, it arrives just before the last frame.
	const lastMoveArrives = end + (outroS ? SPEC.cameraMoveS : -SPEC.cameraMoveS);
	const { camera, focus, warnings } = buildCamera(spans, clips, capture, source, output, editStart, lastMoveArrives);
	const captions = buildCaptions(spans, { fps, source, output, clips, camera }, capture.events);
	return {
		version: 1, fps, output, source, introS, outroS,
		edit: { start: editStart, duration: Number((end - editStart).toFixed(3)) },
		clips, camera, focus,
		cursor: buildCursor(spans, clips, capture, source),
		captions,
		voice: buildVoice(spans),
		beats: spans.map((s) => ({ name: `shot-${s.index + 1}`, t: Number(s.start.toFixed(3)) })),
		// The frame range and the output length of every shot's picture: the smoothness gate needs
		// them to say which shot shows too few new frames.
		shots: spans.map((s) => ({ from: s.from, to: s.to, start: Number(s.start.toFixed(3)), end: Number(s.end.toFixed(3)), picture: Number((s.end - s.start - s.hold).toFixed(3)) })),
		warnings,
	};
}

/** ffmpeg filter that cuts, retimes and holds the capture so its clock equals the edit's clock. */
export function editFilter(clips, fps) {
	const parts = clips.map((c, i) => {
		const hold = c.hold ? `,tpad=stop_mode=clone:stop_duration=${c.hold}` : "";
		return `[0:v]trim=start_frame=${c.from}:end_frame=${c.to},setpts=(PTS-STARTPTS)/${c.speed}${hold},fps=${fps}[c${i}]`;
	});
	return `${parts.join(";")};${clips.map((_, i) => `[c${i}]`).join("")}concat=n=${clips.length}:v=1:a=0,format=yuv420p[out]`;
}

async function renderEdit(captureDir, plan, out) {
	const args = ["-v", "error", "-y", "-i", join(captureDir, "capture.mp4"), "-filter_complex", editFilter(plan.clips, plan.fps), "-map", "[out]", "-c:v", "libx264", "-crf", "14", "-preset", "medium", "-r", String(plan.fps), join(out, "edit.mp4")];
	// Through the tracked runner, not spawnSync: a 30 min edit must not block the signal path.
	const r = await run("ffmpeg", args, { timeoutMs: 30 * 60_000, stdio: "inherit" });
	if (r.timedOut) throw new Error("ffmpeg did not finish the edit in 30 min.");
	if (r.code !== 0) throw new Error(`ffmpeg failed (exit ${r.code}) while cutting edit.mp4.`);
}

async function writeProject(captureDir, out, plan, shots, voiceDir) {
	mkdirSync(join(out, "assets"), { recursive: true });
	await renderEdit(captureDir, plan, out);
	// A local GSAP only: a CDN copy has no integrity hash and makes the render need the network.
	const gsap = runtimeGsap();
	if (!gsap) throw new Error(runtimeGsapError());
	copyFileSync(gsap, join(out, "assets/gsap.min.js"));
	const gsapSrc = "assets/gsap.min.js";
	if (plan.voice.length) {
		mkdirSync(join(out, "assets/voice"), { recursive: true });
		for (const v of plan.voice) {
			const name = basename(v.file);
			copyFileSync(join(voiceDir, name), join(out, "assets/voice", name));
			v.file = `assets/voice/${name}`;
		}
	}
	const font = await projectFont(lookOf(shots).font, out);
	if (font.warning) plan.warnings.push(font.warning);
	const look = { ...shots, look: { ...shots.look, font: font.family } };
	// The plan keeps what the preview needs to rebuild the composition on its own: the look, the
	// two cards and the font rules. wv preview writes preview.html from plan.json only.
	plan.look = look.look;
	plan.cards = { intro: shots.intro ?? null, outro: shots.outro ?? null };
	plan.fontCss = font.css;
	writeFileSync(join(out, "plan.json"), `${JSON.stringify(plan, null, 1)}\n`);
	writeFileSync(join(out, "index.html"), renderHtml(plan, look, { src: "edit.mp4", ...plan.edit }, gsapSrc, font.css));
	writeFileSync(join(out, "hyperframes.json"), `${JSON.stringify({ paths: { blocks: "compositions", components: "compositions/components", assets: "assets" }, media: { autoProxy: true } }, null, 2)}\n`);
}

export async function main(argv) {
	const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { shots: { type: "string" }, out: { type: "string" }, voice: { type: "string" }, help: { type: "boolean" } } });
	if (values.help) return console.log(USAGE);
	if (positionals.length !== 1 || !values.shots || !values.out) throw new Error(USAGE);
	const captureDir = resolve(positionals[0]), out = resolve(values.out);
	const capture = readJson(join(captureDir, "events.json"), "events.json");
	// Name the bad field, and its path, before the planner reads it: a bare TypeError says nothing.
	const eventsCheck = validateEvents(capture);
	if (!eventsCheck.ok) throw new Error(`${join(captureDir, "events.json")} does not match the design:\n  ${describeProblems(eventsCheck.problems)}`);
	const shots = readJson(resolve(values.shots), "shots.json");
	const voiceDir = values.voice ? resolve(values.voice) : null;
	const voiceLines = voiceDir ? readJson(join(voiceDir, "voice.json"), "voice.json") : [];
	const plan = buildPlan(capture, shots, voiceLines);
	await writeProject(captureDir, out, plan, shots, voiceDir);
	console.log(`Wrote ${out}: ${plan.clips.length} clips, ${plan.camera.length} camera keys, ${plan.captions.length} captions, ${(plan.edit.start + plan.edit.duration + plan.outroS).toFixed(1)} s.`);
	for (const w of plan.warnings) console.log(`warning: ${w}`);
}
