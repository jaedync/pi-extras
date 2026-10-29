/**
 * Claude Code's own login, read only to poll the plan that the claude-code
 * provider bills. That provider runs the Claude Code CLI, so its requests
 * never pass Pi's auth store or show Pi their rate-limit headers: the token
 * lives in Claude Code's credentials file. Only Claude Code refreshes the
 * token: one that expires within a minute reads as no login, and the file is
 * read again at each poll, never cached.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeCodeLogin {
	token: string;
	expiresAtMs?: number;
}

export interface ClaudeCodePaths {
	credentials: string;
}

/** A credentials file larger than this is not Claude Code's: it is not read. */
const MAX_CREDENTIALS_BYTES = 64 * 1024;
/** A token this close to its expiry could lapse during the poll. */
const EXPIRY_MARGIN_MS = 60_000;

/**
 * Claude Code keeps its credentials in its config directory when one is set,
 * else in ~/.claude. pi-claude-code gives the CLI PI_CLAUDE_CODE_CONFIG_DIR
 * as that directory, before CLAUDE_CONFIG_DIR.
 */
export function claudeCodePaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): ClaudeCodePaths {
	const dir = env.PI_CLAUDE_CODE_CONFIG_DIR || env.CLAUDE_CONFIG_DIR || join(home, ".claude");
	return { credentials: join(dir, ".credentials.json") };
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		if (statSync(file).size > MAX_CREDENTIALS_BYTES) return undefined;
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

/** Undefined on macOS too, where Claude Code keeps the login in the Keychain instead of a file. */
export function readClaudeCodeLogin(paths = claudeCodePaths(), now = Date.now()): ClaudeCodeLogin | undefined {
	const oauth = readJson(paths.credentials)?.claudeAiOauth as Record<string, unknown> | undefined;
	const token = typeof oauth?.accessToken === "string" && oauth.accessToken ? oauth.accessToken : undefined;
	if (!token) return undefined;
	const expiresAtMs = typeof oauth?.expiresAt === "number" ? oauth.expiresAt : undefined;
	if (expiresAtMs !== undefined && expiresAtMs - EXPIRY_MARGIN_MS <= now) return undefined;
	return { token, ...(expiresAtMs !== undefined ? { expiresAtMs } : {}) };
}
