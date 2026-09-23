/**
 * Computer Use runs OpenAI's own signed binaries, installed by the ChatGPT app.
 * Their signatures are checked before every start: the client lives in a
 * user-writable directory, and it is about to control the user's apps.
 */
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";

export const OPENAI_TEAM_ID = "2DC432GLL2";
/** The Computer Use service only serves clients whose responsible process carries this signing identifier. */
const CODEX_SIGNING_ID = "codex";

export const CODEX_CANDIDATES = [
	"/Applications/ChatGPT.app/Contents/Resources/codex",
	"/Applications/Codex.app/Contents/Resources/codex",
];

export function clientPath(home: string): string {
	return join(home, ".codex", "computer-use", "Codex Computer Use.app", "Contents", "SharedSupport", "SkyComputerUseClient.app", "Contents", "MacOS", "SkyComputerUseClient");
}

export interface Signature {
	readonly valid: boolean;
	readonly identifier?: string;
	readonly teamId?: string;
}

export function readSignature(path: string): Signature {
	const verify = spawnSync("/usr/bin/codesign", ["--verify", "--strict", path], { stdio: "ignore", timeout: 15_000 });
	const details = spawnSync("/usr/bin/codesign", ["-dv", path], { encoding: "utf8", timeout: 15_000 }).stderr ?? "";
	return {
		valid: verify.status === 0,
		identifier: details.match(/^Identifier=(.+)$/m)?.[1],
		teamId: details.match(/^TeamIdentifier=(.+)$/m)?.[1],
	};
}

export type Located = { ok: true; codex: string; client: string } | { ok: false; problem: string };

interface LocateOptions {
	readonly read?: (path: string) => Signature;
	readonly exists?: (path: string) => boolean;
	readonly realpath?: (path: string) => string;
}

const notOpenAi = (path: string) => `${path} is not signed by OpenAI (team ${OPENAI_TEAM_ID}); computer use will not run it`;

export function locateBinaries(home: string, options: LocateOptions = {}): Located {
	const read = options.read ?? readSignature;
	const exists = options.exists ?? existsSync;
	const realpath = options.realpath ?? realpathSync;

	const codexPath = CODEX_CANDIDATES.find(exists);
	if (!codexPath) return { ok: false, problem: "computer use needs the ChatGPT app for macOS in /Applications, which provides the signed codex helper" };
	const client = clientPath(home);
	if (!exists(client)) return { ok: false, problem: "Computer Use is not installed yet: turn it on in the ChatGPT app, which installs it under ~/.codex/computer-use" };

	// Verify the file that will actually run, not a symlink that could be swapped.
	const codex = realpath(codexPath);
	const codexSignature = read(codex);
	if (!codexSignature.valid || codexSignature.teamId !== OPENAI_TEAM_ID) return { ok: false, problem: notOpenAi(codex) };
	if (codexSignature.identifier !== CODEX_SIGNING_ID) return { ok: false, problem: `${codex} is not the codex helper Computer Use accepts (signed as ${codexSignature.identifier ?? "unknown"})` };
	const realClient = realpath(client);
	const clientSignature = read(realClient);
	if (!clientSignature.valid || clientSignature.teamId !== OPENAI_TEAM_ID) return { ok: false, problem: notOpenAi(realClient) };
	return { ok: true, codex, client: realClient };
}
