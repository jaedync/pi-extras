/**
 * Starts the package's Windows PowerShell scripts from WSL. Read over
 * \\wsl.localhost, host.ps1 took 4 s to first answer live; from a copy on the
 * Windows disk, 1 s. So they run from a staged copy when one can be made.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClientProcess } from "../computer-use/mcp-link.ts";

const WINDOWS_POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

const WINDOWS_CMD = "/mnt/c/Windows/System32/cmd.exe";
/**
 * An older version's folder is removed once this old. Not sooner: host.ps1
 * loads ocr.psm1 only when first needed, so a long-running session on that
 * version may still read it.
 */
const STALE_MS = 30 * 24 * 60 * 60 * 1000;

/** Staged together: host.ps1 loads ocr.psm1 and guest-bootstrap.ps1 from its own folder. */
export const SCRIPTS = ["host.ps1", "tunnel.ps1", "ocr.psm1", "guest-bootstrap.ps1"] as const;

/**
 * Copies the named files from source into a folder under localAppData named
 * for their content, and returns that folder. Each version gets its own
 * folder, so a session still running an older one keeps reading its files.
 */
export function stageScripts(source: string, names: readonly string[], localAppData: string): string {
	if (!existsSync(localAppData)) throw new Error(`the Windows folder ${localAppData} doesn't exist`);
	const files = names.map((name) => ({ name, bytes: readFileSync(join(source, name)) }));
	const hash = createHash("sha256");
	for (const { name, bytes } of files) hash.update(`${name}\0${bytes.length}\0`).update(bytes);
	const root = join(localAppData, "pi-extras", "windows-use", "scripts");
	const dir = join(root, hash.digest("hex").slice(0, 16));
	mkdirSync(dir, { recursive: true });
	for (const { name, bytes } of files) {
		const path = join(dir, name);
		// Compared every launch: a copy changed on disk must not run in the package's name.
		if (existsSync(path) && readFileSync(path).equals(bytes)) continue;
		// Renamed into place, so a concurrent launch never reads a half-written script.
		const temporary = `${path}.${process.pid}.tmp`;
		writeFileSync(temporary, bytes);
		renameSync(temporary, path);
	}
	prune(root, dir);
	return dir;
}

/** Removes older versions' folders; one that can't be removed now is tried again next start. */
function prune(root: string, keep: string): void {
	for (const name of readdirSync(root)) {
		const path = join(root, name);
		if (path === keep) continue;
		try {
			if (Date.now() - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true });
		} catch {
			// Only disk space is at stake, and a file in use on Windows can't be removed yet.
		}
	}
}

/** The staged folder, or the package's own folder and why no copy could be made. */
export function chooseFolder(source: string, localAppData: () => string): { readonly folder: string; readonly error?: string } {
	try {
		return { folder: stageScripts(source, SCRIPTS, localAppData()) };
	} catch (error) {
		return { folder: source, error: error instanceof Error ? error.message : String(error) };
	}
}

/** The Windows %LOCALAPPDATA% as a WSL path. */
function findLocalAppData(exe: string): string {
	// The fixed path first: powershell.exe may be found on PATH through a shim.
	const cmd = [WINDOWS_CMD, join(dirname(dirname(dirname(realpathSync(exe)))), "cmd.exe")].find((path) => existsSync(path));
	if (!cmd) throw new Error("cmd.exe wasn't found beside Windows PowerShell");
	// /u: cmd writes UTF-16 to a pipe, so a non-ASCII profile name survives; its OEM code page would not.
	const windows = execFileSync(cmd, ["/u", "/d", "/c", "echo %LOCALAPPDATA%"], { cwd: existsSync("/mnt/c/Windows") ? "/mnt/c/Windows" : undefined, timeout: 10_000 }).toString("utf16le").trim();
	if (!/^[A-Za-z]:\\/.test(windows)) throw new Error(`cmd.exe reported LOCALAPPDATA as '${windows}'`);
	return execFileSync("wslpath", ["-u", windows], { encoding: "utf8" }).trim();
}

export function powershellPath(): string | undefined {
	for (const dir of (process.env.PATH ?? "").split(":")) {
		const candidate = `${dir}/powershell.exe`;
		if (dir && existsSync(candidate)) return candidate;
	}
	return existsSync(WINDOWS_POWERSHELL) ? WINDOWS_POWERSHELL : undefined;
}

/** The Windows %LOCALAPPDATA%, or why it can't be found; looked up once, as a failure blocks for up to 10 s. */
let localAppData: string | Error | undefined;
/** Why the scripts last ran from the package's own folder, for /windows-use. */
let lastStageError: string | undefined;

/**
 * The folder to run the scripts from: a copy on the Windows disk, or the
 * package's own folder over \\wsl.localhost, which works but starts seconds slower.
 */
function scriptFolder(exe: string): string {
	const { folder, error } = chooseFolder(fileURLToPath(new URL(".", import.meta.url)), () => {
		if (localAppData === undefined) {
			try { localAppData = findLocalAppData(exe); } catch (failure) { localAppData = failure instanceof Error ? failure : new Error(String(failure)); }
		}
		if (localAppData instanceof Error) throw localAppData;
		return localAppData;
	});
	lastStageError = error;
	return folder;
}

/** Starts one of the package's Windows PowerShell scripts on the Hyper-V host. */
export function launchScript(name: string): () => ClientProcess {
	return () => {
		const exe = powershellPath();
		if (!exe) throw new Error("windows_use needs powershell.exe through WSL interop (Windows PowerShell 5.1 on the Hyper-V host)");
		const windowsPath = execFileSync("wslpath", ["-w", join(scriptFolder(exe), name)], { encoding: "utf8" }).trim();
		// A Windows working directory keeps Windows tools from warning about UNC paths.
		return spawn(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", windowsPath], {
			cwd: existsSync("/mnt/c/Windows") ? "/mnt/c/Windows" : undefined,
			stdio: ["pipe", "pipe", "pipe"],
		});
	};
}

export function stageError(): string | undefined {
	return lastStageError;
}
