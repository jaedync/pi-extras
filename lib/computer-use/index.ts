/**
 * Opt-in computer use on macOS through OpenAI's signed Computer Use service,
 * installed by the ChatGPT app. PI_COMPUTER_USE=on enables it; nothing is
 * registered otherwise.
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname } from "node:path";
import { highlightCode, keyHint, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { approver, computerUseMenu, type MenuDeps } from "./approval-ui.ts";
import { ApprovalStore, approvalsPath, isBundleId, parseAppList } from "./approvals.ts";
import { locateBinaries } from "./binaries.ts";
import { CodeExecutor, type CodeResult } from "./executor.ts";
import { guiSessionAvailable, spawnGuiJob, sweepStaleJobs } from "./gui-job.ts";
import { renderCall, renderResult, type Paint, type RowDetails } from "./render.ts";
import { SkySession } from "./session.ts";

const ENABLED = new Set(["1", "on", "true", "yes"]);
/** Close the client after this long without a call; the next call restarts it in well under a second. */
const IDLE_MS = 5 * 60_000;
/** Same bound the official integration gives a single Computer Use call. */
const CALL_TIMEOUT_MS = 120_000;
const LOOKUP_TIMEOUT_MS = 2_000;

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
The first use of each app asks the user to allow it; some apps, such as terminals, are never allowed.

Example:
const state = await sky.get_app_state({ app: "TextEdit" });
emit(state.text);

Batch known actions sequentially, then inspect again before deciding the next step.`;

export interface ComputerUseDeps extends MenuDeps {
	readonly executor: Pick<CodeExecutor, "execute">;
	readonly close: () => Promise<void>;
}

function failure(result: CodeResult): Error {
	const text = result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
	const images = result.content.length - result.content.filter((block) => block.type === "text").length;
	return new Error(images > 0 ? `${text}\n(${images} emitted image${images === 1 ? "" : "s"} omitted)` : text);
}

/** A theme missing a key degrades to plain text instead of breaking the row. */
function painter(theme: Theme): Paint {
	const safe = (paint: () => string, text: string) => { try { return paint(); } catch { return text; } };
	return { fg: (key, text) => safe(() => theme.fg(key, text), text), bold: (text) => safe(() => theme.bold(text), text) };
}

function expandHint(theme: Theme): string {
	try { return keyHint("app.tools.expand", "to expand"); } catch {
		const paint = painter(theme);
		return `${paint.fg("dim", "ctrl+o")}${paint.fg("muted", " to expand")}`;
	}
}

function highlight(code: string): string[] {
	try { return highlightCode(code, "javascript"); } catch { return code.split("\n"); }
}

const hasCalls = (details: unknown): details is RowDetails => !!details && typeof details === "object" && Array.isArray((details as RowDetails).calls);

export function registerComputerUse(pi: ExtensionAPI, deps: ComputerUseDeps): void {
	pi.registerTool({
		name: "computer_use",
		label: "Computer use",
		description: DESCRIPTION,
		parameters: Type.Object({
			code: Type.String({ description: "JavaScript body to execute. Use await sky.<method>(args), emit(value), emitImage(screenshot), and store for state shared across calls." }),
		}, { additionalProperties: false }),
		async execute(_id, params, signal, onUpdate, ctx) {
			const notes = new Set<string>();
			const result = await deps.executor.execute(params.code, {
				approve: approver(ctx, notes),
				signal,
				onProgress: (progress) => onUpdate?.({ content: [], details: progress }),
			});
			const content = [...result.content, ...[...notes].map((text) => ({ type: "text" as const, text }))];
			if (result.error) throw failure({ ...result, content });
			return { content, details: { calls: result.calls, durationMs: result.durationMs } };
		},
		renderCall: (args, theme, context) => renderCall(args, { expanded: context.expanded, paint: painter(theme), highlight, hint: expandHint(theme) }),
		renderResult: (result, options, theme, context) => {
			// A thrown error arrives without details, so keep the last streamed timeline for it.
			const state = context.state as { last?: RowDetails };
			if (hasCalls(result.details)) state.last = result.details;
			return renderResult(result, { expanded: options.expanded, isError: context.isError, partial: options.isPartial, paint: painter(theme), hint: expandHint(theme), last: state.last });
		},
	});
	pi.registerCommand("computer-use", {
		description: "Computer use status, and the apps the agent may always use",
		handler: async (_args, ctx) => {
			if (ctx.hasUI) await computerUseMenu(ctx, deps);
			else ctx.ui.notify(deps.status().join("\n"), "info");
		},
	});
	pi.on("session_shutdown", () => deps.close());
}

/** The app's name from Spotlight, falling back to its bundle identifier. */
function spotlightName(bundleId: string): string {
	if (!isBundleId(bundleId)) return bundleId;
	const found = spawnSync("mdfind", [`kMDItemCFBundleIdentifier == "${bundleId}"`], { encoding: "utf8", timeout: LOOKUP_TIMEOUT_MS });
	const path = found.status === 0 ? found.stdout.split("\n").find((line) => line.endsWith(".app")) : undefined;
	return path ? basename(path, ".app") : bundleId;
}

export function productionDeps(): ComputerUseDeps {
	let swept = false;
	const names = new Map<string, string>();
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
			return [
				found.ok ? "Computer Use client: signed by OpenAI" : `Computer Use client: ${found.problem}`,
				guiSessionAvailable() ? "Desktop session: available" : "Desktop session: nobody is logged in to this Mac's desktop",
				`Client: ${session.state === "ready" ? "running" : session.state === "starting" ? "starting" : "not running; starts on the first call"}`,
			];
		},
		approvals: new ApprovalStore(approvalsPath(homedir())),
		appName: (bundleId) => {
			if (!names.has(bundleId)) names.set(bundleId, spotlightName(bundleId));
			return names.get(bundleId)!;
		},
		listApps: async () => {
			// Listing apps never asks for approval; refuse anything that tries.
			const result = await session.call("list_apps", {}, { approve: async () => "deny" });
			const text = result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
			if (result.isError) throw new Error(text || "list_apps failed");
			return parseAppList(text);
		},
	};
}

export default function (pi: ExtensionAPI): void {
	if (!computerUseEnabled(process.platform, process.env)) return;
	registerComputerUse(pi, productionDeps());
}
