/** The `~/.local/bin/pi` launcher: rendering it from launcher.sh, recognizing it, installing it atomically. */
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const LAUNCHER_MARKER = "# pi-extras auto-update launcher v1";
const TEMPLATE = new URL("./launcher.sh", import.meta.url);

export interface LauncherValues {
	readonly store: string;
	readonly fallbackPi: string;
	readonly fallbackExtras: string;
	readonly node: string;
}

/** A value inside single quotes in sh. */
const shQuoted = (value: string): string => value.replace(/'/g, "'\\''");

export function renderLauncher(values: LauncherValues): string {
	const fill: Record<string, string> = { STORE: values.store, FALLBACK_PI: values.fallbackPi, FALLBACK_EXTRAS: values.fallbackExtras, NODE: values.node };
	return readFileSync(TEMPLATE, "utf8").replace(/@([A-Z_]+)@/g, (match, name: string) => (name in fill ? shQuoted(fill[name]!) : match));
}

/** True when `path` is a launcher this code installed (a file with the marker on line 2). */
export function isLauncher(path: string): boolean {
	try {
		if (!lstatSync(path).isFile()) return false;
		return readFileSync(path, "utf8").split("\n", 2)[1] === LAUNCHER_MARKER;
	} catch {
		return false;
	}
}

function tempBeside(path: string): string {
	return join(dirname(path), `.${randomBytes(4).toString("hex")}.pi-extras.tmp`);
}

/** Writes the launcher over `path` (a symlink or an older launcher) with one rename. */
export function installLauncher(path: string, text: string): void {
	const temp = tempBeside(path);
	try {
		writeFileSync(temp, text, { mode: 0o755, flag: "wx" });
		chmodSync(temp, 0o755);
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/** Puts a symlink to `target` at `path` with one rename. */
export function restoreLink(path: string, target: string): void {
	const temp = tempBeside(path);
	try {
		symlinkSync(target, temp);
		renameSync(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}

/** The raw link text at `path`, or undefined when it is not a symlink. */
export function linkAt(path: string): string | undefined {
	try {
		return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
	} catch {
		return undefined;
	}
}
