/**
 * Default bash timeout. Pi runs shell commands with no timeout unless the
 * model passes one, so a runaway `find /` blocks the turn until someone aborts
 * it. This patches a default onto every bash and powershell call that omits
 * `timeout`; an explicit value is left alone, also an invalid one, so Pi
 * reports it. Metadata-only and fail-open: no data leaves the box.
 *
 * PI_BASH_DEFAULT_TIMEOUT overrides the default in seconds. `0` or `off`
 * disables the extension for that session.
 *
 * Pi's own schema says the timeout is optional with no default, so the model
 * is told the real default in each active shell tool's guidelines; without
 * that it learns of the limit only when a long command is cut off.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const DEFAULT_TIMEOUT_SECONDS = 120;
/** Pi's shell tools that take a `timeout` in seconds. */
export const TIMEOUT_TOOLS: ReadonlySet<string> = new Set(["bash", "powershell"]);
/** The longest timer Node (and so Pi's shell tools) can set: 2^31 - 1 ms. */
const MAX_TIMEOUT_SECONDS = 2_147_483_647 / 1000;
const DISABLED = new Set(["0", "off", "false", "none"]);

/** Seconds to apply, or undefined when the operator disabled the default. */
export function resolveDefaultSeconds(raw: string | undefined): number | undefined {
	const value = raw?.trim().toLowerCase();
	if (value === undefined || value === "") return DEFAULT_TIMEOUT_SECONDS;
	if (DISABLED.has(value)) return undefined;
	const seconds = Number(value);
	// A value Pi would refuse would fail every call that omits a timeout, so it counts as unset.
	return Number.isFinite(seconds) && seconds > 0 && seconds <= MAX_TIMEOUT_SECONDS ? seconds : DEFAULT_TIMEOUT_SECONDS;
}

/** Mutates the tool input in place, as Pi's tool_call contract requires. Returns true when a default was applied. */
export function applyDefaultTimeout(input: unknown, seconds: number): boolean {
	if (typeof input !== "object" || input === null) return false;
	const args = input as Record<string, unknown>;
	// Any value the model gave is its own: Pi validates it and names the problem.
	if (args.timeout !== undefined && args.timeout !== null) return false;
	args.timeout = seconds;
	return true;
}

/** The rule each active shell tool gets in the system prompt. */
export function timeoutGuideline(toolName: string, seconds: number): string {
	return `A ${toolName} call with no \`timeout\` stops after ${seconds} ${seconds === 1 ? "second" : "seconds"}. Pass a larger \`timeout\` (in seconds) for a longer command.`;
}

/** Adds the rule to each selected shell tool, once, after the tool's own rules. Mutates `options` in place, as Pi's before_agent_start contract asks. */
export function addTimeoutGuidelines(options: { selectedTools?: readonly string[]; toolGuidelines?: Record<string, string[]> }, seconds: number): void {
	if (!options.toolGuidelines) return;
	for (const toolName of options.selectedTools ?? []) {
		if (!TIMEOUT_TOOLS.has(toolName)) continue;
		const rule = timeoutGuideline(toolName, seconds);
		const rules = options.toolGuidelines[toolName] ?? [];
		if (!rules.includes(rule)) options.toolGuidelines[toolName] = [...rules, rule];
	}
}

export default function bashDefaultTimeout(pi: ExtensionAPI): void {
	const seconds = resolveDefaultSeconds(process.env.PI_BASH_DEFAULT_TIMEOUT);
	if (seconds === undefined) return;
	pi.on("before_agent_start", (event) => {
		addTimeoutGuidelines(event.systemPromptOptions, seconds);
	});
	pi.on("tool_call", async (event) => {
		if (!TIMEOUT_TOOLS.has(event.toolName)) return;
		applyDefaultTimeout(event.input, seconds);
	});
}
