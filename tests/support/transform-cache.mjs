import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Pi transforms each TypeScript file of an extension with jiti (Babel) and caches the result in `$TMPDIR/jiti`. A test
// that gives Pi a new TMPDIR pays the whole transform again: for all of pi-extras 40 s of CPU, 51 to 62 s on a loaded
// op01. jiti keys each cached file by its content, so one cache can serve every run of this checkout.
export const TEST_TRANSFORM_CACHE = fileURLToPath(new URL("../../node_modules/.cache/pi-extras-test-jiti", import.meta.url));

/** Makes `<tmpDir>/jiti` a link to the checkout's transform cache, so a new TMPDIR keeps a warm cache. */
export function linkTransformCache(tmpDir) {
	mkdirSync(TEST_TRANSFORM_CACHE, { recursive: true });
	symlinkSync(TEST_TRANSFORM_CACHE, join(tmpDir, "jiti"), "dir");
}
