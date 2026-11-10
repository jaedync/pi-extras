import { readFileSync } from "node:fs";

/**
 * A child index as a test reads it while Pi runs. Pi writes the index in the
 * background (lib/subagents/restore.ts), so the file can be missing for a moment
 * after the first spawn: that reads as an index with no records, and a polling
 * wait tries again.
 */
export function readChildIndex(file: string): { records: any[]; [key: string]: any } {
	let text: string;
	try { text = readFileSync(file, "utf8"); }
	catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return { records: [] };
		throw error;
	}
	return JSON.parse(text);
}
