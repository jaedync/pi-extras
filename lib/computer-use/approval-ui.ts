/**
 * The places a person decides what the agent may operate: the prompt the
 * Computer Use client asks for on an app's first use, and /computer-use, which
 * sets the apps mode and the apps that are always allowed. Both fail closed:
 * no UI, a dismissed prompt or an unconfirmed change all leave access as it
 * was or narrower. Where Pi cannot show custom components (RPC mode), plain
 * select dialogs stand in.
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ApprovalPrompt } from "./approval-prompt.ts";
import type { ApprovalState, ListedApp } from "./approvals.ts";
import { painter } from "./paint.ts";
import { ALLOW_ALL_WARNING, AppsPanel, MODE_LABEL, type PanelResult, type StatusItem } from "./panel.ts";
import type { Approval, ApprovalRequest, CallOptions } from "./session.ts";
import { MODES, type AppsMode } from "./settings.ts";

type Ui = Pick<ExtensionContext["ui"], "select" | "confirm" | "notify"> & Partial<Pick<ExtensionContext["ui"], "custom">>;
type Context = { readonly hasUI: boolean; readonly ui?: Ui } | undefined;

export interface MenuDeps {
	readonly status: () => StatusItem[];
	readonly approvals: {
		read(): ApprovalState;
		allow(bundleId: string): void;
		revoke(bundleId: string): void;
	};
	readonly appName: (bundleId: string) => string;
	readonly listApps: () => Promise<ListedApp[]>;
	readonly mode: { read(): AppsMode; write(mode: AppsMode): void };
	/** Restart the client, dropping the per-session approvals it holds. */
	readonly restart: () => Promise<void>;
}

/** "Don't allow" comes first so a stray Enter while the dialog appears refuses. */
const FALLBACK_CHOICES: ReadonlyArray<readonly [string, Approval]> = [["Don't allow", "deny"], ["Allow for this session", "once"], ["Always allow", "always"]];
const SHARED = "Always allow also applies to ChatGPT and Codex computer use, until you remove it with /computer-use.";

/** The select-dialog form of the prompt, for UIs without custom components. */
export function approvalDialog(request: ApprovalRequest): { title: string; options: string[] } {
	const lines = [request.app ? `Allow the agent to use ${request.app}?` : `Computer Use asks: ${request.message}`];
	if (request.warning) lines.push("", `${request.highRisk ? "High risk: " : ""}${request.warning}`);
	if (request.canRemember) lines.push("", SHARED);
	const options = FALLBACK_CHOICES.filter(([, answer]) => answer !== "always" || request.canRemember).map(([label]) => label);
	return { title: lines.join("\n"), options };
}

/** Answers approval requests for one tool call; `notes` collects what the model should be told. */
export function approver(ctx: Context, notes: Set<string>, mode: AppsMode = "ask"): CallOptions["approve"] {
	return async (request) => {
		if (mode === "all") return "auto";
		if (!ctx?.hasUI || !ctx.ui) {
			notes.add(`${request.app || "This app"} is not allowed for computer use, and this Pi session has no UI to ask in. Allow it, or turn on Allow all, with /computer-use in an interactive Pi session.`);
			return "deny";
		}
		if (request.signal.aborted) return "deny";
		const ui = ctx.ui;
		// Resolves undefined only where custom components are unsupported; the prompt itself always answers.
		const answer = await ui.custom?.<Approval>((_tui, theme, _keys, done) => {
			const prompt = new ApprovalPrompt(request, painter(theme), done);
			// A listener added after the abort never fires, so check again once the prompt is up.
			request.signal.addEventListener("abort", () => prompt.finish("deny"), { once: true });
			if (request.signal.aborted) queueMicrotask(() => prompt.finish("deny"));
			return prompt;
		});
		if (answer !== undefined) return answer;
		const { title, options } = approvalDialog(request);
		const picked = await ui.select(title, options, { signal: request.signal });
		return FALLBACK_CHOICES.find(([label]) => label === picked)?.[1] ?? "deny";
	};
}

export async function computerUseMenu(ctx: { readonly ui: Ui }, deps: MenuDeps): Promise<void> {
	const state = deps.approvals.read();
	const allowed = state.ids.map((bundleId) => ({ bundleId, name: deps.appName(bundleId) }));
	const mode = deps.mode.read();
	const locked = state.writable ? undefined : state.problem;
	const result = await ctx.ui.custom?.<PanelResult | "cancel">((tui, theme, _keys, done) => new AppsPanel({
		status: deps.status(), mode, allowed, apps: deps.listApps(), locked, requestRender: () => tui.requestRender(),
	}, painter(theme), done));
	try {
		if (result === undefined) await fallbackMenu(ctx, deps, mode, allowed, locked);
		else if (result !== "cancel") await apply(ctx, deps, mode, result);
	} catch (error) {
		ctx.ui.notify(`Computer use: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function apply(ctx: { readonly ui: Ui }, deps: MenuDeps, before: AppsMode, result: PanelResult): Promise<void> {
	if (result.mode === before && result.allow.length === 0 && result.revoke.length === 0) return;
	for (const id of result.revoke) deps.approvals.revoke(id);
	for (const id of result.allow) deps.approvals.allow(id);
	if (result.mode !== before) deps.mode.write(result.mode);
	// A running client keeps session approvals, so narrowing access must restart it to take effect now.
	if (result.revoke.length > 0 || (before === "all" && result.mode !== "all")) await deps.restart();
	const changes = [
		...(result.mode !== before ? [`apps set to ${MODE_LABEL[result.mode]}`] : []),
		...(result.allow.length ? [`always allowing ${result.allow.map(deps.appName).join(", ")}`] : []),
		...(result.revoke.length ? [`no longer always allowing ${result.revoke.map(deps.appName).join(", ")}`] : []),
	];
	ctx.ui.notify(`Computer use: ${changes.join("; ")}.`, "info");
}

const ALLOW_APP = "Always allow an app…";
const REVOKE_APP = "Stop always allowing an app…";
const label = (name: string, bundleId: string) => `${name} (${bundleId})`;

/** The same choices as the panel, one at a time, for UIs that can only show select dialogs. */
async function fallbackMenu(ctx: { readonly ui: Ui }, deps: MenuDeps, mode: AppsMode, allowed: Array<{ bundleId: string; name: string }>, locked?: string): Promise<void> {
	const summary = [...deps.status().map((item) => item.text), `Apps: ${MODE_LABEL[mode]}`, `Always allowed: ${allowed.map((app) => app.name).join(", ") || "none"}`];
	const change = `Change apps mode (now ${MODE_LABEL[mode]})…`;
	const options = locked ? [change] : allowed.length ? [ALLOW_APP, REVOKE_APP, change] : [ALLOW_APP, change];
	const picked = await ctx.ui.select([...summary, ...(locked ? [`Can't change the always-allowed apps here: ${locked}.`] : [])].join("\n"), options);
	if (picked === change) {
		const pickedMode = await ctx.ui.select("Apps", MODES.map((candidate) => MODE_LABEL[candidate]));
		const chosen = MODES.find((candidate) => MODE_LABEL[candidate] === pickedMode);
		if (!chosen || chosen === mode) return;
		if (chosen === "all" && !await ctx.ui.confirm("Turn on Allow all?", ALLOW_ALL_WARNING)) return;
		await apply(ctx, deps, mode, { mode: chosen, allow: [], revoke: [] });
	} else if (picked === REVOKE_APP) {
		const choice = await ctx.ui.select("Stop always allowing which app?", allowed.map((app) => label(app.name, app.bundleId)));
		const app = allowed.find((candidate) => label(candidate.name, candidate.bundleId) === choice);
		if (app && await ctx.ui.confirm(`Stop always allowing ${app.name}?`, `The agent will have to ask again before it uses ${app.name}, in Pi and in ChatGPT and Codex computer use.`)) {
			await apply(ctx, deps, mode, { mode, allow: [], revoke: [app.bundleId] });
		}
	} else if (picked === ALLOW_APP) {
		const ids = new Set(allowed.map((app) => app.bundleId));
		const apps = (await deps.listApps()).filter((app) => !ids.has(app.bundleId));
		if (apps.length === 0) return ctx.ui.notify("Every app Computer Use lists is already always allowed. Open an app first if it is not listed.", "info");
		const choice = await ctx.ui.select("Always allow which app? Running and recently used apps are listed.", apps.map((app) => label(app.name, app.bundleId)));
		const app = apps.find((candidate) => label(candidate.name, candidate.bundleId) === choice);
		const warning = `The agent will be able to read and operate ${app?.name} without asking, in every Pi session and in ChatGPT and Codex computer use. Browsers, mail and messaging apps carry a prompt injection risk: text shown in them can steer the agent.`;
		if (app && await ctx.ui.confirm(`Always allow ${app.name}?`, warning)) await apply(ctx, deps, mode, { mode, allow: [app.bundleId], revoke: [] });
	}
}
