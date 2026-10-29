/**
 * Claude Code's own login, read only to poll the plan that the claude-code
 * provider bills. That provider runs the Claude Code CLI, so its requests
 * never pass Pi's auth store or show Pi their rate-limit headers: the token
 * and the account it names live in Claude Code's files. Only Claude Code
 * refreshes the token: an expired one reads as no login, and the file is read
 * again at each poll, never cached.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ClaudeCodeLogin {
	token: string;
	expiresAtMs?: number;
	accountUuid?: string;
	organizationUuid?: string;
}

export interface ClaudeCodePaths {
	credentials: string;
	account: string;
}

/**
 * Claude Code keeps both files in its config directory when one is set, else
 * in ~/.claude and ~/.claude.json. pi-claude-code gives the CLI
 * PI_CLAUDE_CODE_CONFIG_DIR as that directory, before CLAUDE_CONFIG_DIR.
 */
export function claudeCodePaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): ClaudeCodePaths {
	const dir = env.PI_CLAUDE_CODE_CONFIG_DIR || env.CLAUDE_CONFIG_DIR;
	return dir
		? { credentials: join(dir, ".credentials.json"), account: join(dir, ".claude.json") }
		: { credentials: join(home, ".claude", ".credentials.json"), account: join(home, ".claude.json") };
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);

/** Undefined on macOS too, where Claude Code keeps the login in the Keychain instead of a file. */
export function readClaudeCodeLogin(paths = claudeCodePaths(), now = Date.now()): ClaudeCodeLogin | undefined {
	const oauth = readJson(paths.credentials)?.claudeAiOauth as Record<string, unknown> | undefined;
	const token = text(oauth?.accessToken);
	if (!token) return undefined;
	const expiresAtMs = typeof oauth?.expiresAt === "number" ? oauth.expiresAt : undefined;
	if (expiresAtMs !== undefined && expiresAtMs <= now) return undefined;
	const account = readJson(paths.account)?.oauthAccount as Record<string, unknown> | undefined;
	const accountUuid = text(account?.accountUuid);
	const organizationUuid = text(account?.organizationUuid);
	return {
		token,
		...(expiresAtMs !== undefined ? { expiresAtMs } : {}),
		...(accountUuid ? { accountUuid } : {}),
		...(organizationUuid ? { organizationUuid } : {}),
	};
}
