/**
 * shell-jobs-launch: how a job's process starts. A job runs as Pi's bash tool
 * would run the same command: Pi's shell (its `shellPath` setting, else bash),
 * Pi's `shellCommandPrefix`, Pi's bin directory first in PATH, and the
 * PI_ session variables of this session rather than any a parent left behind.
 * Pure, so the rules can be tested without a session.
 */
import { delimiter } from "node:path";

/** The variables Pi's bash tool drops from what it inherits and sets for its own session. */
export const SESSION_VARIABLES = ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"] as const;

export interface SessionFacts {
	readonly sessionId?: string;
	readonly sessionFile?: string;
	readonly provider?: string;
	readonly model?: string;
	readonly thinkingLevel?: string;
}

/** Pi's shell resolution, as `getShellConfig` returns it. */
export interface ShellConfig {
	readonly shell: string;
	readonly args: readonly string[];
	readonly commandTransport?: "argv" | "stdin";
}

export interface Launch {
	readonly shell: string;
	readonly args: readonly string[];
	readonly env: NodeJS.ProcessEnv;
}

/** The prefix goes on its own line before the command, as Pi's bash tool puts it. */
export function launchArgs(config: ShellConfig, command: string, prefix: string | undefined): string[] {
	// Jobs have no stdin, so a shell that reads its script from stdin cannot run one.
	if (config.commandTransport === "stdin") throw new Error(`${config.shell} reads commands from stdin, which background jobs do not have`);
	return [...config.args, prefix ? `${prefix}\n${command}` : command];
}

/** PATH with Pi's bin directory first, and the session variables of this session only. */
export function jobEnv(base: NodeJS.ProcessEnv, binDir: string, session: SessionFacts): NodeJS.ProcessEnv {
	const pathKey = Object.keys(base).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const current = base[pathKey] ?? "";
	const path = current.split(delimiter).filter(Boolean).includes(binDir) ? current : [binDir, current].filter(Boolean).join(delimiter);
	const env: NodeJS.ProcessEnv = { ...base, [pathKey]: path };
	for (const key of SESSION_VARIABLES) delete env[key];
	const values: Record<(typeof SESSION_VARIABLES)[number], string | undefined> = {
		PI_SESSION_ID: session.sessionId,
		PI_SESSION_FILE: session.sessionFile,
		PI_PROVIDER: session.provider,
		PI_MODEL: session.model,
		PI_REASONING_LEVEL: session.thinkingLevel,
	};
	for (const [key, value] of Object.entries(values)) if (value) env[key] = value;
	return env;
}
