import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentRoot } from "./pi-runtime.mjs";

// Pi transforms each TypeScript file of an extension with jiti (Babel) and caches the result in `$TMPDIR/jiti`. A test
// that gives Pi a new TMPDIR pays the whole transform again: for all of pi-extras 40 s of CPU, 51 to 62 s on a loaded
// op01. jiti keys each cached file by its content, so one cache can serve every run of this checkout.

const versionOf = (packageJson) => (existsSync(packageJson) ? JSON.parse(readFileSync(packageJson, "utf8")).version : undefined);

// jiti's key holds the source and its own format version, not the Babel setup or Pi's options: a Pi or jiti upgrade
// gets a new folder. Pi nests jiti, or npm hoists it next to the scope folder.
function cacheName() {
	const pi = versionOf(join(agentRoot, "package.json"));
	if (!pi) throw new Error(`Cannot read the Pi version at ${agentRoot}`);
	const jiti = [join(agentRoot, "node_modules", "jiti"), join(agentRoot, "..", "..", "jiti")].map((dir) => versionOf(join(dir, "package.json"))).find(Boolean);
	return `pi-extras-test-jiti-pi-${pi}${jiti ? `-jiti-${jiti}` : ""}`;
}

export const TEST_TRANSFORM_CACHE = join(fileURLToPath(new URL("../../node_modules/.cache/", import.meta.url)), cacheName());

/** Makes `<tmpDir>/jiti` a link to the checkout's transform cache, so a new TMPDIR keeps a warm cache. */
export function linkTransformCache(tmpDir) {
	mkdirSync(TEST_TRANSFORM_CACHE, { recursive: true });
	symlinkSync(TEST_TRANSFORM_CACHE, join(tmpDir, "jiti"), "dir");
}
