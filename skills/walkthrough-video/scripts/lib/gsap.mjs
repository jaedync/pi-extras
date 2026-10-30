/**
 * Where wv gets GSAP. Never from a CDN: a script tag without an integrity hash
 * makes the page depend on the network at render time, and the docs promised a
 * local runtime. Compose copies the runtime's file into the project, and the
 * project's file is what preview, render and gates use.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GSAP, paths } from "./paths.mjs";

/** A dev checkout's GSAP, beside the skill, for a developer who did not run wv setup. */
function devGsap() {
	return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "node_modules", "gsap", "dist", "gsap.min.js");
}

/** The runtime's GSAP file, a dev checkout's, or null. */
export function runtimeGsap(env = process.env, home = homedir()) {
	for (const file of [join(paths(env, home).gsap, "dist", "gsap.min.js"), devGsap()]) if (existsSync(file)) return file;
	return null;
}

/** Why there is no GSAP to copy into a project, with the fix. */
export function runtimeGsapError(env = process.env, home = homedir()) {
	return `GSAP ${GSAP} is not installed at ${join(paths(env, home).gsap, "dist", "gsap.min.js")}. Run wv setup; wv does not load GSAP from a CDN, so a render stays local.`;
}

/** The project's own GSAP file, or an error: preview, render and gates need it. */
export function requireProjectGsap(project) {
	const file = join(project, "assets", "gsap.min.js");
	if (existsSync(file)) return file;
	throw new Error(`${file} is missing: the project has no local GSAP, and wv does not load one from a CDN. Run wv compose again (it copies the runtime's GSAP), or wv setup first.`);
}
