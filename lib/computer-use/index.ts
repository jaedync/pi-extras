/**
 * Opt-in computer use on macOS through OpenAI's signed Computer Use service,
 * installed by the ChatGPT app. PI_COMPUTER_USE=on enables it; nothing is
 * registered otherwise.
 */
import { homedir } from "node:os";
import { dirname } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { locateBinaries } from "./binaries.ts";
import { CodeExecutor, type CodeResult, type RunOptions } from "./executor.ts";
import { guiSessionAvailable, spawnGuiJob, sweepStaleJobs } from "./gui-job.ts";
import { type Approval, SkySession } from "./session.ts";

const ENABLED = new Set(["1", "on", "true", "yes"]);
/** Close the client after this long without a call; the next call restarts it in well under a second. */
const IDLE_MS = 5 * 60_000;
/** Same bound the official integration gives a single Computer Use call. */
const CALL_TIMEOUT_MS = 120_000;

export function computerUseEnabled(platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>): boolean {
	return platform === "darwin" && ENABLED.has((env.PI_COMPUTER_USE ?? "").trim().toLowerCase());
}

const DESCRIPTION = `Run JavaScript that composes OpenAI's official signed macOS Computer Use methods in one call. No nested model is used.

Available globals:
- sky.list_apps() -> text app inventory
- sky.get_app_state({ app, disableDiff? }) -> { app, text, screenshot }
- sky.click({ app, element_index?, x?, y?, mouse_button?, click_count? })
- sky.perform_secondary_action({ app, element_index, action })
- sky.set_value({ app, element_index, value })
- sky.select_text({ app, element_index, text, prefix?, suffix?, selection? })
- sky.scroll({ app, element_index, direction, pages? })
- sky.drag({ app, from_x, from_y, to_x, to_y })
- sky.press_key({ app, key })
- sky.type_text({ app, text })
- emit(value) returns text or JSON to Pi
- emitImage(state.screenshot) returns a screenshot to Pi
- store is a persistent JSON object shared across calls

element_index identifiers are strings (e.g. "7") from the latest accessibility tree, and stay valid across calls until the app changes.
get_app_state may return an accessibility-tree diff after the first inspection. Pass disableDiff: true for a fresh full tree.
The first use of each app asks the user to allow it.

Example:
const state = await sky.get_app_state({ app: "TextEdit" });
emit(state.text);

Batch known actions sequentially, then inspect again before deciding the next step.`;

const CHOICES: Record<string, Approval> = { "Allow once": "once", "Always allow": "always", "Don't allow": "deny" };

function approver(ctx: ExtensionContext | undefined): RunOptions["approve"] {
	return async (message, canRemember) => {
		if (!ctx?.hasUI) return "deny";
		const options = Object.keys(CHOICES).filter((label) => canRemember || CHOICES[label] !== "always");
		const picked = await ctx.ui.select(message, options);
		return picked ? CHOICES[picked] ?? "deny" : "deny";
	};
}

export interface ComputerUseDeps {
	readonly executor: Pick<CodeExecutor, "execute">;
	readonly close: () => Promise<void>;
	readonly status: () => string[];
}

function failure(result: CodeResult): Error {
	const text = result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
	const images = result.content.length - result.content.filter((block) => block.type === "text").length;
	return new Error(images > 0 ? `${text}\n(${images} emitted image${images === 1 ? "" : "s"} omitted)` : text);
}

export function registerComputerUse(pi: ExtensionAPI, deps: ComputerUseDeps): void {
	pi.registerTool({
		name: "computer_use",
		label: "Computer use",
		description: DESCRIPTION,
		parameters: Type.Object({
			code: Type.String({ description: "JavaScript body to execute. Use await sky.<method>(args), emit(value), emitImage(screenshot), and store for state shared across calls." }),
		}, { additionalProperties: false }),
		async execute(_id, params, signal, _update, ctx) {
			const result = await deps.executor.execute(params.code, { approve: approver(ctx), signal });
			if (result.error) throw failure(result);
			return { content: result.content, details: { calls: result.calls } };
		},
	});
	pi.registerCommand("computer-use", {
		description: "Show whether computer use can run on this Mac",
		handler: async (_args, ctx) => ctx.ui.notify(deps.status().join("\n"), "info"),
	});
	pi.on("session_shutdown", () => deps.close());
}

export function productionDeps(): ComputerUseDeps {
	let swept = false;
	const session = new SkySession({
		idleMs: IDLE_MS,
		callTimeoutMs: CALL_TIMEOUT_MS,
		launch: async () => {
			const found = locateBinaries(homedir());
			if (!found.ok) throw new Error(found.problem);
			if (!guiSessionAvailable()) throw new Error("computer use needs someone logged in to this Mac's desktop");
			if (!swept) { swept = true; await sweepStaleJobs(); }
			// Full access: the sandbox would keep the client from reaching the Computer Use service.
			// The client stays a child of codex, which is what the service authenticates.
			return spawnGuiJob(found.codex, ["sandbox", "-c", 'sandbox_mode="danger-full-access"', found.client, "mcp"], {
				HOME: homedir(),
				PATH: `${dirname(found.codex)}:/usr/bin:/bin:/usr/sbin:/sbin`,
			});
		},
	});
	return {
		executor: new CodeExecutor({ session }),
		close: () => session.close(),
		status: () => {
			const found = locateBinaries(homedir());
			const desktop = guiSessionAvailable();
			return [
				found.ok ? `Computer Use: signed client found (${found.client})` : `Computer Use: ${found.problem}`,
				desktop ? "Desktop session: available" : "Desktop session: nobody is logged in to this Mac's desktop",
				`Client: ${session.state === "ready" ? "running" : session.state}`,
			];
		},
	};
}

export default function (pi: ExtensionAPI): void {
	if (!computerUseEnabled(process.platform, process.env)) return;
	registerComputerUse(pi, productionDeps());
}
