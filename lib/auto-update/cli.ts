/**
 * The auto-update command line:
 *   node lib/auto-update/cli.ts <check [--force] | status | rollback | gc | enable | disable>
 *
 * Runs as a plain Node process (Node >= 22.18 strips the types), so nothing
 * here imports Pi. Sessions start `check` detached, with a lower priority.
 */
import { homedir } from "node:os";
import { CommandError, disable, enable } from "./enable.ts";
import { gc, rollback } from "./commands.ts";
import { readConfig } from "./config.ts";
import { armHardLimit, CYCLE_LIMIT_MS, runCycle, type CycleOutcome } from "./cycle.ts";
import { fileLog } from "./log.ts";
import { agentDirFrom, EXTRAS_DIR, storePaths, storeRootFrom } from "./paths.ts";
import { inFolder, killRunning, runCommand } from "./run.ts";
import { smokeTest } from "./smoke.ts";
import { readState } from "./state.ts";
import { statusLines } from "./status.ts";
import { mkdirSync, realpathSync } from "node:fs";

const USAGE = "Usage: node lib/auto-update/cli.ts <check [--force] | status | rollback | gc | enable | disable>";
const FAILED: ReadonlySet<CycleOutcome> = new Set(["error", "smoke-failed"]);

/** The store's real path: settings.json, leases and the launcher all name it, so a symlink on the way cannot make two names for one folder. */
function realRoot(root: string): string {
	try {
		return realpathSync(root);
	} catch {
		// `status` before the store exists: nothing names it yet.
		return root;
	}
}

function context(command: string | undefined) {
	const home = process.env.HOME || homedir();
	const root = storeRootFrom(process.env, home);
	// Only status reads without writing; every other command may create the store.
	if (command !== "status") mkdirSync(root, { recursive: true, mode: 0o700 });
	const paths = storePaths(realRoot(root));
	const agentDir = agentDirFrom(process.env, home);
	const now = () => Date.now();
	const out = (line: string) => process.stdout.write(`${line}\n`);
	return { home, paths, agentDir, now, out, log: fileLog(paths.log, now) };
}

async function main(argv: readonly string[]): Promise<number> {
	const [command, ...rest] = argv;
	const ctx = context(command);
	switch (command) {
		case "check": {
			// The cycle's tests must end before the hard limit, so it gets the limit's own end time.
			const deadline = ctx.now() + CYCLE_LIMIT_MS;
			const disarm = armHardLimit({ ms: CYCLE_LIMIT_MS, paths: ctx.paths, now: ctx.now, log: ctx.log, kill: killRunning, exit: (code) => process.exit(code) });
			const result = await runCycle({ ...ctx, config: readConfig(ctx.agentDir), runner: inFolder(runCommand, ctx.paths.root), smoke: smokeTest, deadline }, { force: rest.includes("--force") }).finally(disarm);
			ctx.out(result.message);
			return FAILED.has(result.outcome) ? 1 : 0;
		}
		case "status":
			for (const line of statusLines(readState(ctx.paths.state), readConfig(ctx.agentDir), ctx.now())) ctx.out(line);
			return 0;
		case "rollback":
			rollback(ctx);
			return 0;
		case "gc":
			gc(ctx);
			return 0;
		case "enable":
			await enable({ ...ctx, runner: inFolder(runCommand, ctx.paths.root), smoke: smokeTest, extrasDir: EXTRAS_DIR, node: process.execPath, platform: process.platform });
			return 0;
		case "disable":
			await disable(ctx);
			return 0;
		default:
			process.stderr.write(`${USAGE}\n`);
			return 2;
	}
}

try {
	process.exitCode = await main(process.argv.slice(2));
} catch (error) {
	// A CommandError is a message for the user; anything else is a bug, with its first line only (it can name paths).
	const message = error instanceof CommandError ? error.message : `auto-update failed: ${(error as Error).message?.split("\n")[0] ?? String(error)}`;
	process.stderr.write(`${message}\n`);
	process.exitCode = 1;
}
