import { statSync } from "node:fs";

/**
 * Changes when the file is written, replaced or removed. A stat, so a caller
 * can tell that a file changed without reading it or taking its lock.
 */
export function fileIdentity(path: string): string {
	try {
		const stat = statSync(path);
		return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// A file that can't be read now may be readable at the next look; that is a change too.
		return code === "ENOENT" || code === "ENOTDIR" ? "absent" : `unreadable:${code ?? "unknown"}`;
	}
}
