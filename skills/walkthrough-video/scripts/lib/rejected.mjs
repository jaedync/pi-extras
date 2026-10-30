/**
 * Sounds the owner rejected. The skill's list (references/rejected-sounds.json)
 * holds the owner's notes so far; a user list adds to it, so a new note needs
 * no package release: $WV_REJECTED_SOUNDS, else
 * ~/.config/pi-walkthrough-video/rejected-sounds.json. A sound matches by its
 * file name (a glob with *) or by the SHA-256 of its bytes, so a renamed copy
 * is still found.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SKILL_LIST = new URL("../../references/rejected-sounds.json", import.meta.url);

const EMPTY = { names: [], sha256: [], why: "" };

/** One list. A file that does not parse is the caller's to report: a silent drop lets a rejected sound pass. */
function readList(file, { required = false } = {}) {
	let raw;
	try {
		raw = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		if (required) throw new Error(`${file}: ${error.message}`);
		throw error;
	}
	return { names: Array.isArray(raw.names) ? raw.names.map(String) : [], sha256: Array.isArray(raw.sha256) ? raw.sha256.map((h) => String(h).toLowerCase()) : [], why: typeof raw.why === "string" ? raw.why : "" };
}

export function userListPath(env = process.env, home = homedir()) {
	return env.WV_REJECTED_SOUNDS || join(env.XDG_CONFIG_HOME || join(home, ".config"), "pi-walkthrough-video", "rejected-sounds.json");
}

/**
 * The skill's list and the user's list, merged. A user list that does not parse
 * is reported: silently dropping it would let a sound the owner rejected pass.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [home]
 * @param {(line: string) => void} [warn]
 */
export function loadRejected(env = process.env, home = homedir(), warn = () => {}) {
	const lists = [readList(SKILL_LIST, { required: true })];
	const user = userListPath(env, home);
	if (existsSync(user)) {
		try {
			lists.push(readList(user));
		} catch (error) {
			warn(`${user}: ${error.message} Its sounds do not count until the file is valid JSON.`);
			lists.push(EMPTY);
		}
	}
	return { names: [...new Set(lists.flatMap((l) => l.names))], sha256: [...new Set(lists.flatMap((l) => l.sha256))], why: lists.map((l) => l.why).filter(Boolean).join(" ") };
}

const glob = (pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`, "i");

/** The cues (with a `file` in `dir`) whose sound is on the rejected list. */
export function rejectedCues(cues, dir, rejected = loadRejected()) {
	const names = rejected.names.map(glob);
	const hashes = new Set(rejected.sha256);
	const byFile = new Map();
	return cues.filter((cue) => {
		const file = String(cue.file ?? "");
		if (!file) return false;
		if (names.some((re) => re.test(file))) return true;
		if (!byFile.has(file)) {
			const path = join(dir, file);
			byFile.set(file, existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null);
		}
		return hashes.has(byFile.get(file));
	});
}
