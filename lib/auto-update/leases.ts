/**
 * One lease file per running Pi process that loaded pi-extras, so GC never
 * removes a folder a process may still load from. A lease counts only while
 * its pid is alive with the same start time: a reused pid does not keep an
 * old lease alive.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "../json-file.ts";
import type { StorePaths } from "./paths.ts";

export interface Lease {
	readonly pid: number;
	/** The process start time, as the system reports it. */
	readonly start: string;
	readonly piVersion: string;
	/** The real folder of the running Pi (an npm prefix or the package root). */
	readonly piDir: string;
	/** The real package folders the process loaded. */
	readonly releases: readonly string[];
	readonly extrasDir: string;
	readonly mode: string;
	readonly sessionFile?: string;
	readonly updatedAt: number;
}

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

function linuxStart(pid: number): string | undefined {
	let stat: string;
	try {
		stat = readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "ESRCH") return undefined;
		throw error;
	}
	// The command name in parentheses may hold spaces; fields count from after it. Field 22 is the start time.
	const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
	return fields[19];
}

function psStart(pid: number): string | undefined {
	try {
		const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5_000 }).trim();
		return out || undefined;
	} catch {
		// ps exits 1 for a pid that does not exist.
		return undefined;
	}
}

/** The start time of `pid`, or undefined when no such process runs. */
export function processStart(pid: number): string | undefined {
	if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
	return process.platform === "linux" ? linuxStart(pid) : psStart(pid);
}

export function leaseFile(lease: Pick<Lease, "pid" | "start">): string {
	return `${lease.pid}-${lease.start.replace(/[^A-Za-z0-9]+/g, "_")}.json`;
}

export function writeLease(paths: StorePaths, lease: Lease): void {
	mkdirSync(paths.leases, { recursive: true, mode: 0o700 });
	writeJsonAtomic(join(paths.leases, leaseFile(lease)), lease);
}

export function removeLease(paths: StorePaths, lease: Pick<Lease, "pid" | "start">): void {
	rmSync(join(paths.leases, leaseFile(lease)), { force: true });
}

function parseLease(text: string): Lease | undefined {
	try {
		const value = JSON.parse(text) as Partial<Lease>;
		if (typeof value.pid !== "number" || typeof value.start !== "string" || typeof value.piDir !== "string" || !Array.isArray(value.releases)) return undefined;
		return value as Lease;
	} catch {
		return undefined;
	}
}

export type Liveness = (pid: number, start: string) => boolean;

export const isLive: Liveness = (pid, start) => processStart(pid) === start;

/** The leases of live processes. Removes dead and unreadable lease files. */
export function readLiveLeases(paths: StorePaths, alive: Liveness = isLive): Lease[] {
	let names: string[];
	try {
		names = readdirSync(paths.leases);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}
	const live: Lease[] = [];
	for (const name of names.filter((candidate) => candidate.endsWith(".json"))) {
		const file = join(paths.leases, name);
		let lease: Lease | undefined;
		try {
			lease = parseLease(readFileSync(file, "utf8"));
		} catch (error) {
			if (errorCode(error) === "ENOENT") continue;
			throw error;
		}
		if (lease && alive(lease.pid, lease.start)) live.push(lease);
		else rmSync(file, { force: true });
	}
	return live;
}
