/**
 * Where the runtime lives and what was installed. The install is a cache, so a
 * missing file reads as "not installed" and the next `wv setup` repairs it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const PLAYWRIGHT_CORE = "1.63.0";
export const HYPERFRAMES = "0.8.209";
/** The composer copies this into the project so a render needs no CDN. */
export const GSAP = "3.14.2";
/** wv film build type-checks the film project with it. */
export const TYPESCRIPT = "7.0.2";
// Exact versions, as tested on the author's machine (2026-10-27).
export const KOKORO_PACKAGES = ["kokoro-onnx==0.6.1", "soundfile==0.14.0", "numpy==2.5.4", "onnxruntime==1.31.1"];
/** The film kit's measures (camera estimator, sound mix) run in the same venv. */
export const FILM_PY_PACKAGES = ["opencv-python-headless==5.0.0.93"];
/** wv sound score: the synth voices and the hit check need scipy, the sampler path writes MIDI with mido, the master runs through pedalboard (GPL-3.0, used as an installed tool). */
export const SCORE_PY_PACKAGES = ["scipy==1.18.1", "mido==1.3.3", "pedalboard==0.9.26"];
/**
 * The music kit's tools (numpy scales a sample, soundfile reads and writes it)
 * and the score they serve, so `wv setup --music` alone can render a score with
 * a sampled part.
 */
export const KIT_PY_PACKAGES = [...KOKORO_PACKAGES.filter((spec) => ["numpy", "soundfile"].includes(String(spec).split("==")[0])), ...SCORE_PY_PACKAGES];
/** What the score and the kit tools must be able to import. */
export const SCORE_MODULES = ["numpy", "soundfile", "scipy", "mido", "pedalboard"];

/** The Python packages setup installs, by name, from the pinned lists. */
export const pythonPackageNames = (lists = [KOKORO_PACKAGES, FILM_PY_PACKAGES, SCORE_PY_PACKAGES]) => lists.flat().map((spec) => String(spec).split("==")[0]);

export const MODEL_FILES = {
	"kokoro-v1.0.onnx": "7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5",
	"voices-v1.0.bin": "bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d",
};
export const MODEL_RELEASE = "https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/";
export const SAMPLE_RATE = 24000;

export function cacheHome(env = process.env, home = homedir()) {
	return join(env.XDG_CACHE_HOME || join(home, ".cache"), "pi-walkthrough-video");
}

/**
 * The one music kit folder. WV_MUSIC_KIT wins, so `wv setup --music`, its check,
 * the setup status line and `wv sound score` can never disagree about where the
 * kit is: a repair command then repairs the folder that the score reads.
 */
export function musicKitPath(env = process.env, home = homedir()) {
	const override = String(env.WV_MUSIC_KIT ?? "").trim();
	return override ? resolve(override) : join(cacheHome(env, home), "music-kit");
}

export const paths = (env = process.env, home = homedir()) => {
	const root = cacheHome(env, home);
	return {
		root,
		state: join(root, "state.json"),
		lock: join(root, ".lock"),
		packageJson: join(root, "package.json"),
		playwright: join(root, "node_modules", "playwright-core"),
		hyperframes: join(root, "node_modules", "hyperframes"),
		gsap: join(root, "node_modules", "gsap"),
		typescript: join(root, "node_modules", "typescript"),
		venv: join(root, "venv"),
		python: join(root, "venv", "bin", "python"),
		models: join(root, "models"),
		musicKit: musicKitPath(env, home),
		kokoroShare: join(home, ".local", "share", "kokoro-tts"),
	};
};

/**
 * The installed HyperFrames binary, or null. wv never installs a package at run
 * time (an npx fallback pulls unpinned dependencies into a render).
 */
export function hyperframesBin(env = process.env, home = homedir()) {
	const bin = join(cacheHome(env, home), "node_modules", ".bin", "hyperframes");
	return existsSync(bin) ? bin : null;
}

/** Why there is no HyperFrames to run, with the fix. */
export function hyperframesMissing(env = process.env, home = homedir()) {
	return `HyperFrames ${HYPERFRAMES} is not installed at ${join(cacheHome(env, home), "node_modules", ".bin", "hyperframes")}. Run wv setup, then run the command again.`;
}

export function ensureHome(env = process.env, home = homedir()) {
	const root = cacheHome(env, home);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	return root;
}

export function readState(env = process.env, home = homedir()) {
	try {
		const parsed = JSON.parse(readFileSync(paths(env, home).state, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

export function writeState(next, env = process.env, home = homedir()) {
	const file = paths(env, home).state;
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}`;
	writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	renameSync(temp, file);
	return next;
}
