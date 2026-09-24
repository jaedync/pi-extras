/**
 * "Always allow" answers live in a JSON file owned by OpenAI's Computer Use
 * service. It is undocumented, but it is also how the ChatGPT app's own
 * settings list and revoke apps: they rewrite `approvedBundleIdentifiers` and
 * the client rereads it on every call. Anything other than that exact shape is
 * shown read-only and never rewritten, so a future format is not clobbered.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

const CONTAINER = "Library/Group Containers/2DC432GLL2.com.openai.sky.CUAService";
const FILE = "Library/Application Support/Software/ComputerUseAppApprovals.json";
const KEY = "approvedBundleIdentifiers";
const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;
const UNFAMILIAR = "the approvals file has a format this version does not know; manage apps in the ChatGPT app instead";

export type ApprovalState =
	| { readonly writable: true; readonly ids: string[] }
	| { readonly writable: false; readonly ids: string[]; readonly problem: string };

export interface ListedApp {
	readonly name: string;
	readonly path: string;
	readonly bundleId: string;
	readonly running: boolean;
}

export function approvalsPath(home: string): string {
	return join(home, CONTAINER, FILE);
}

export function isBundleId(value: unknown): value is string {
	return typeof value === "string" && BUNDLE_ID.test(value);
}

export function parseApprovals(text: string | undefined): ApprovalState {
	if (text === undefined) return { writable: true, ids: [] };
	let data: unknown;
	try { data = JSON.parse(text); } catch { return { writable: false, ids: [], problem: UNFAMILIAR }; }
	if (!data || typeof data !== "object" || Array.isArray(data)) return { writable: false, ids: [], problem: UNFAMILIAR };
	const list = (data as Record<string, unknown>)[KEY];
	const ids = Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : [];
	const exact = Object.keys(data).length === 1 && Array.isArray(list) && ids.length === list.length;
	return exact ? { writable: true, ids } : { writable: false, ids, problem: UNFAMILIAR };
}

export class ApprovalStore {
	readonly path: string;

	constructor(path: string) {
		this.path = path;
	}

	read(): ApprovalState {
		return parseApprovals(existsSync(this.path) ? readFileSync(this.path, "utf8") : undefined);
	}

	allow(bundleId: string): void {
		this.update(bundleId, (ids) => ids.includes(bundleId) ? ids : [...ids, bundleId]);
	}

	revoke(bundleId: string): void {
		this.update(bundleId, (ids) => ids.filter((id) => id !== bundleId));
	}

	private update(bundleId: string, change: (ids: string[]) => string[]): void {
		if (!isBundleId(bundleId)) throw new Error(`${JSON.stringify(bundleId)} is not a bundle identifier`);
		const container = dirname(dirname(dirname(dirname(this.path))));
		if (!existsSync(container)) throw new Error("Computer Use has not been set up on this Mac; turn it on in the ChatGPT app first");
		// Read immediately before writing, so a change the ChatGPT app just made is kept.
		const state = this.read();
		if (!state.writable) throw new Error(state.problem);
		const ids = change(state.ids);
		if (ids.length === state.ids.length && ids.every((id, index) => id === state.ids[index])) return;
		const dir = dirname(this.path);
		mkdirSync(dir, { recursive: true });
		const mode = existsSync(this.path) ? statSync(this.path).mode & 0o777 : 0o644;
		const temp = join(dir, `.${basename(this.path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
		try {
			writeFileSync(temp, `${JSON.stringify({ [KEY]: ids }, null, 2)}`, { flag: "wx", mode });
			chmodSync(temp, mode);
			renameSync(temp, this.path);
		} catch (error) {
			rmSync(temp, { force: true });
			throw error;
		}
	}
}

/** Lines look like "Finder — /System/Library/CoreServices/Finder.app/ — com.apple.finder [running]". */
const APP_LINE = /^(.+?) — (\/.+?) — (\S+)(?: \[([^\]]*)\])?$/;

export function parseAppList(text: string): ListedApp[] {
	return text.split("\n").flatMap((line): ListedApp[] => {
		const match = APP_LINE.exec(line.trim());
		if (!match || !isBundleId(match[3])) return [];
		const name = match[1].replace(CONTROL, " ").replace(/\s+/g, " ").trim();
		const flags = (match[4] ?? "").split(",").map((flag) => flag.trim());
		return name ? [{ name, path: match[2], bundleId: match[3], running: flags.includes("running") }] : [];
	});
}
