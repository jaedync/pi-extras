/**
 * The launch options a restarted Pi gets again. The session builds the list
 * from its own argv (here, in Node, not in sh) and writes it into the
 * restart request, one argument per line. Only options on the allowlist are
 * kept; session options and messages are dropped, because the restart picks
 * the session with `--session`. Anything else (an extension flag, a secret
 * such as `--api-key`, a newline) means no restart: the session shows the
 * "restart to use it" notice instead. Option names follow Pi 1.4
 * (docs/cli.md and dist/cli/args.js).
 */

/** Options that take the next argument as their value, and are safe to repeat. */
const KEEP_WITH_VALUE = new Set([
	"--provider", "--model", "--thinking", "--models",
	"-t", "--tools", "-xt", "--exclude-tools",
	"-e", "--extension", "--skill", "--prompt-template", "--theme", "--use-theme",
	"--system-prompt", "--append-system-prompt", "--session-dir", "--tui-mode",
]);

const KEEP_FLAGS = new Set([
	"-nt", "--no-tools", "-nbt", "--no-builtin-tools", "-ne", "--no-extensions", "--no-mcp",
	"-ns", "--no-skills", "-np", "--no-prompt-templates", "--no-themes", "-nc", "--no-context-files",
	"--verbose", "-a", "--approve", "-na", "--no-approve", "--offline",
]);

/** Session selection: the restart gives `--session <file>` itself. */
const DROP_WITH_VALUE = new Set(["--session", "--session-id", "--fork", "-n", "--name"]);
const DROP_FLAGS = new Set(["-c", "--continue", "-r", "--resume", "--no-session"]);

export type Replay = { readonly ok: true; readonly args: readonly string[] } | { readonly ok: false; readonly reason: string };

const refuse = (reason: string): Replay => ({ ok: false, reason });

export function replayArgs(argv: readonly string[]): Replay {
	const args: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		// After "--" every argument is a message.
		if (arg === "--") break;
		if (DROP_FLAGS.has(arg)) continue;
		if (DROP_WITH_VALUE.has(arg)) {
			i++;
			continue;
		}
		if (KEEP_FLAGS.has(arg)) {
			args.push(arg);
			continue;
		}
		if (KEEP_WITH_VALUE.has(arg) || arg === "--mode") {
			const value = argv[i + 1];
			if (value === undefined) return refuse(`${arg} has no value`);
			// Only the terminal UI restarts; any other mode would not come back as one.
			if (arg === "--mode" && value !== "text") return refuse(`--mode ${value}`);
			if (/[\r\n]/.test(value)) return refuse(`the value of ${arg} has a line break`);
			args.push(arg, value);
			i++;
			continue;
		}
		// A message or an @file: the session already has them.
		if (!arg.startsWith("-")) continue;
		// Never the value: it can be a secret (for example --api-key).
		return refuse(`the option ${arg.split("=")[0]} is not one that a restart repeats`);
	}
	return { ok: true, args };
}
