/**
 * JSON settings files that several Pi sessions read and rewrite. A missing
 * file reads as empty, but a file that exists and cannot be read is never
 * rewritten from scratch: that would replace every setting in it with the
 * one being saved.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, lstatSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

type Json = Record<string, unknown>;

/** A new settings file can hold paths, proxies or cookies, so only its owner reads it. */
const NEW_FILE_MODE = 0o600;

const isObject = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

/** The file exists but is not a JSON object, so nothing was saved over it. */
export class UnreadableJsonError extends Error {
	readonly file: string;
	readonly reason: string;

	constructor(file: string, reason: string) {
		super(`${basename(file)} could not be read (${reason}), so nothing was saved. Fix or remove ${file}, then try again.`);
		this.name = "UnreadableJsonError";
		this.file = file;
		this.reason = reason;
	}
}

/** The object in `file`, or `{}` when there is no file. Throws `UnreadableJsonError` for anything else. */
export function readJsonObject(file: string): Json {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch (error) {
		if (errorCode(error) === "ENOENT") return {};
		throw new UnreadableJsonError(file, (error as Error).message);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (error) {
		throw new UnreadableJsonError(file, (error as Error).message);
	}
	if (!isObject(parsed)) throw new UnreadableJsonError(file, "it does not hold a JSON object");
	return parsed;
}

/** Like the system's own limit; a longer chain is almost certainly a mistake. */
const MAX_LINKS = 40;

/** `path` with its folder resolved, so `..` in a link means what the system makes it mean. */
function inRealFolder(path: string): string {
	try {
		return join(realpathSync(dirname(path)), basename(path));
	} catch (error) {
		if (errorCode(error) === "ENOENT") return path;
		throw error;
	}
}

/** Where the link at `path` points, or undefined when `path` is not a link. */
function linkTarget(path: string): string | undefined {
	try {
		if (!lstatSync(path).isSymbolicLink()) return undefined;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
	return resolve(dirname(inRealFolder(path)), readlinkSync(path));
}

/**
 * The real file behind `file`, so a write through a symlink replaces the
 * target and keeps every link. A chain of links that ends at a missing file
 * resolves to that file, which the write then creates.
 */
export function resolveTarget(file: string): string {
	let path = file;
	for (let depth = 0; depth <= MAX_LINKS; depth++) {
		try {
			return realpathSync(path);
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
		const next = linkTarget(path);
		if (next === undefined) return inRealFolder(path);
		path = next;
	}
	throw new Error(`${file} has more than ${MAX_LINKS} symbolic links in a chain.`);
}

function existingMode(target: string): number | undefined {
	try {
		return statSync(target).mode & 0o777;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

/**
 * Writes `value` through a temporary file in the target's directory and a
 * rename, so a reader never sees half a file. The temporary name is unique to
 * the process and the call, so two sessions never write the same one. The
 * file keeps its mode; a new one gets 0600.
 */
export function writeJsonAtomic(file: string, value: unknown): void {
	const target = resolveTarget(file);
	const mode = existingMode(target) ?? NEW_FILE_MODE;
	const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	try {
		const fd = openSync(temp, "wx", mode);
		try {
			writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		// The umask can narrow the mode given to open.
		chmodSync(temp, mode);
		renameSync(temp, target);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}
