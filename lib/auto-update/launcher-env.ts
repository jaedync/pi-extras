/**
 * What the launcher tells the Pi it starts, through environment variables:
 * the restart token, its own pid, and the restart count for a target. Read
 * once per process and then removed from process.env: a bash tool, an MCP
 * server or a shell job that Pi starts must not inherit the token (a Pi
 * started from there could then ask this launcher for a restart). The values
 * stay on globalThis, because each reload loads the extension again.
 */

export interface LauncherEnv {
	readonly token: string | undefined;
	/** The launcher is this process's parent: only then can a restart request reach it. */
	readonly launchedByLauncher: boolean;
	/** How often in a row the launcher restarted Pi for `target`. */
	readonly restarted: { readonly count: number; readonly target: string } | undefined;
}

export const LAUNCHER_VARS = ["PI_EXTRAS_RESTART_TOKEN", "PI_EXTRAS_LAUNCHER_PID", "PI_EXTRAS_RESTART_COUNT", "PI_EXTRAS_RESTART_TARGET"] as const;

/** Versioned: a later pi-extras that keeps other data here picks a new symbol. */
const SLOT = Symbol.for("pi-extras.auto-update.launcher-env.v1");

function parse(env: NodeJS.ProcessEnv): LauncherEnv {
	const count = Number.parseInt(env.PI_EXTRAS_RESTART_COUNT ?? "", 10);
	const target = env.PI_EXTRAS_RESTART_TARGET;
	return {
		token: env.PI_EXTRAS_RESTART_TOKEN || undefined,
		launchedByLauncher: env.PI_EXTRAS_LAUNCHER_PID !== undefined && env.PI_EXTRAS_LAUNCHER_PID === String(process.ppid),
		restarted: Number.isSafeInteger(count) && count > 0 && target ? { count, target } : undefined,
	};
}

/** The launcher's values for this process; the first call takes them out of `env`. */
export function launcherEnv(env: NodeJS.ProcessEnv): LauncherEnv {
	const slot = globalThis as { [SLOT]?: LauncherEnv };
	if (slot[SLOT]) return slot[SLOT];
	const values = parse(env);
	for (const name of LAUNCHER_VARS) delete env[name];
	slot[SLOT] = values;
	return values;
}
