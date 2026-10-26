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
import { runCycle, type CycleOutcome } from "./cycle.ts";
import { fileLog } from "./log.ts";
import { agentDirFrom, EXTRAS_DIR, storePaths, storeRootFrom } from "./paths.ts";
import { runCommand } from "./run.ts";
import { smokeTest } from "./smoke.ts";
import { readState } from "./state.ts";
import { statusLines } from "./status.ts";
import { mkdirSync } from "node:fs";

const USAGE = "Usage: node lib/auto-update/cli.ts <check [--force] | status | rollback | gc | enable | disable>";
const FAILED: ReadonlySet<CycleOutcome> = new Set(["error", "smoke-failed"]);

function context() {
	const home = process.env.HOME || homedir();
	const paths = storePaths(storeRootFrom(process.env, home));
	const agentDir = agentDirFrom(process.env, home);
	const now = () => Date.now();
	const out = (line: string) => process.stdout.write(`${line}\n`);
	return { home, paths, agentDir, now, out, log: fileLog(paths.log, now) };
}

async function main(argv: readonly string[]): Promise<number> {
	const [command, ...rest] = argv;
	const ctx = context();
	// Only status reads without writing; every other command may create the store.
	if (command !== "status") mkdirSync(ctx.paths.root, { recursive: true, mode: 0o700 });
	switch (command) {
		case "check": {
			const result = await runCycle({ ...ctx, config: readConfig(ctx.agentDir), runner: runCommand, smoke: smokeTest }, { force: rest.includes("--force") });
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
			await enable({ ...ctx, runner: runCommand, smoke: smokeTest, extrasDir: EXTRAS_DIR, node: process.execPath, platform: process.platform });
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
