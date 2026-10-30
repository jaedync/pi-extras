/**
 * Camera motion of a rendered film, measured by the python estimator.
 * `cameraMoves` hands scripts/py/motion.py the video and the cut frames and
 * returns its JSON: the zoom and pan inside each shot, the moves with their
 * ease peak, and the film totals that `wv measure` reports.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "../lib/paths.mjs";
import { run } from "../lib/proc.mjs";

const SCRIPT = join(dirname(dirname(fileURLToPath(import.meta.url))), "py", "motion.py");
/** A 30 s 1080p60 film measures in under three minutes; a long film may take more. */
const TIMEOUT_MS = 30 * 60_000;
const MISSING_CV2 = /No module named ['"]?cv2|ModuleNotFoundError:.*cv2/;

function fail(message) {
	throw new Error(`motion: ${message}`);
}

/** True when the interpreter can import cv2, so the estimator can run at all. */
export function estimatorReady(python = paths().python) {
	if (!existsSync(python)) return false;
	const probe = spawnSync(python, ["-I", "-c", "import cv2, numpy"], { stdio: "ignore", timeout: 60_000 });
	return probe.status === 0;
}

/**
 * Measures the camera in `video`.
 *
 * @param {string} video path to the rendered film
 * @param {{fps: number, cuts: number[]}} plan the film's fps and the first frame of each new shot
 * @param {{log?: (line: string) => void, timeoutMs?: number}} [options]
 * @returns {Promise<any>} the estimator JSON
 */
export async function cameraMoves(video, { fps, cuts } = /** @type {any} */ ({}), { log = (_line) => {}, timeoutMs = TIMEOUT_MS } = {}) {
	if (typeof video !== "string" || !video) fail("needs a video path");
	if (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0) fail(`needs the film fps as a number above 0 (got ${JSON.stringify(fps)})`);
	const cutFrames = cuts ?? [];
	if (!Array.isArray(cutFrames) || !cutFrames.every((frame) => Number.isInteger(frame) && frame >= 0)) fail(`cuts must be whole frame numbers (got ${JSON.stringify(cuts)})`);
	if (!existsSync(video)) fail(`${video} does not exist`);
	const python = paths().python;
	if (!existsSync(python)) fail(`the runtime venv is missing at ${python}; run wv setup`);

	const work = mkdtempSync(join(tmpdir(), "wv-motion-"));
	const cutsFile = join(work, "cuts.json");
	try {
		writeFileSync(cutsFile, `${JSON.stringify({ fps, cuts: cutFrames })}\n`);
		const result = await run(python, ["-I", SCRIPT, video, "--cuts", cutsFile], { timeoutMs });
		for (const line of result.stderr.split("\n")) if (line.trim()) log(line.trim());
		if (result.code !== 0) {
			if (MISSING_CV2.test(result.stderr)) fail(`the runtime venv has no cv2 at ${python}; run wv setup`);
			const last = result.stderr.trim().split("\n").pop() || `python exited with ${result.code}`;
			fail(`the estimator failed on ${video}: ${last}`);
		}
		let read;
		try {
			read = JSON.parse(result.stdout);
		} catch {
			fail(`the estimator did not print JSON for ${video}: ${result.stdout.slice(0, 200)}`);
		}
		if (!read || !Array.isArray(read.shots)) fail(`the estimator printed no shots for ${video}`);
		return read;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}
