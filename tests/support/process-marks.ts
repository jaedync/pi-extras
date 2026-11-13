/**
 * Marks for the processes of one test: each test runs `sleep <marker>`, a
 * length no other process uses, so a scan of /proc finds its processes only,
 * and SIGKILLs them at its end, pass or fail, so a test run cannot leak.
 */
import { readdirSync } from "node:fs";
import { after } from "node:test";
import { readIfThere, signal } from "../../lib/process-tree.ts";

const markers: string[] = [];
after(() => { for (const value of markers) killMarked(value); });

export function marker(base: number): string {
	const value = `${base + markers.length}.${process.pid}${Math.floor(Math.random() * 1e6)}`;
	markers.push(value);
	return value;
}

/** Live (not zombie) processes whose command line holds the marker. */
export function marked(value: string): number[] {
	return readdirSync("/proc").filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid).filter((name) => {
		const cmdline = readIfThere(`/proc/${name}/cmdline`);
		const stat = readIfThere(`/proc/${name}/stat`);
		if (cmdline === undefined || stat === undefined || !cmdline.split("\0").some((arg) => arg.includes(value))) return false;
		const state = stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
		return state !== "Z" && state !== "X";
	}).map(Number);
}

/** The marked processes still alive after up to `waitMs`. */
export async function survivors(value: string, waitMs = 1500): Promise<number[]> {
	const deadline = Date.now() + waitMs;
	let left = marked(value);
	while (left.length > 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 25));
		left = marked(value);
	}
	return left;
}

export function killMarked(value: string): void {
	for (const pid of marked(value)) signal(pid, "SIGKILL");
}
