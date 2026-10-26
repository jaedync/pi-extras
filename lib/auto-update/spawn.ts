/**
 * Starts `cli.ts check` as a detached process with a lower CPU and disk
 * priority, so a session that reloads or exits never stops a running cycle.
 */
import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

function onPath(name: string, path = process.env.PATH ?? ""): string | undefined {
	for (const dir of path.split(delimiter).filter(Boolean)) {
		try {
			accessSync(join(dir, name), constants.X_OK);
			return join(dir, name);
		} catch {
			// Not in this folder.
		}
	}
	return undefined;
}

/** `ionice -c3 nice -n 10`, with the parts this system has. */
export function lowPriority(): string[] {
	const nice = onPath("nice");
	const ionice = process.platform === "linux" ? onPath("ionice") : undefined;
	return [...(ionice ? [ionice, "-c3"] : []), ...(nice ? [nice, "-n", "10"] : [])];
}

/** Started in the store root: the session's project folder (and its .npmrc) must not affect the cycle. */
export function spawnCycle(extrasDir: string, storeRoot: string, force: boolean, onError: (error: Error) => void): void {
	const [command, ...args] = [...lowPriority(), process.execPath, join(extrasDir, "lib", "auto-update", "cli.ts"), "check", ...(force ? ["--force"] : [])];
	// The restart token belongs to this session's launcher, not to the cycle.
	const { PI_EXTRAS_RESTART_TOKEN: _token, PI_EXTRAS_LAUNCHER_PID: _launcher, PI_EXTRAS_RESTART_COUNT: _count, PI_EXTRAS_RESTART_TARGET: _target, ...env } = process.env;
	const child = spawn(command!, args, { cwd: existsSync(storeRoot) ? storeRoot : tmpdir(), detached: true, stdio: "ignore", env });
	child.on("error", onError);
	child.unref();
}
