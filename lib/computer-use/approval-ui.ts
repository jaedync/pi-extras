/**
 * The two places a person decides what the agent may operate: the dialog the
 * Computer Use client asks for on an app's first use, and /computer-use, which
 * lists and changes the apps that are always allowed. Both fail closed: no UI,
 * a dismissed dialog or a declined confirmation all mean "not allowed".
 */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ApprovalState, ListedApp } from "./approvals.ts";
import type { Approval, ApprovalRequest, CallOptions } from "./session.ts";

/** "Don't allow" comes first so a stray Enter while the dialog appears refuses. */
const CHOICES: ReadonlyArray<readonly [string, Approval]> = [
	["Don't allow", "deny"],
	["Allow for this session", "once"],
	["Always allow", "always"],
];
const ALLOW_APP = "Always allow an app…";
const REVOKE_APP = "Stop always allowing an app…";
const SHARED = "Always allow also applies to ChatGPT and Codex computer use, until you remove it with /computer-use.";

type Ui = Pick<ExtensionContext["ui"], "select" | "confirm" | "notify">;
type Context = { readonly hasUI: boolean; readonly ui?: Ui } | undefined;

export interface MenuDeps {
	readonly status: () => string[];
	readonly approvals: {
		read(): ApprovalState;
		allow(bundleId: string): void;
		revoke(bundleId: string): void;
	};
	readonly appName: (bundleId: string) => string;
	readonly listApps: () => Promise<ListedApp[]>;
}

export function approvalDialog(request: ApprovalRequest): { title: string; options: string[] } {
	const lines = [request.app ? `Allow the agent to use ${request.app}?` : `Computer Use asks: ${request.message}`];
	if (request.warning) lines.push("", `${request.highRisk ? "High risk: " : ""}${request.warning}`);
	if (request.canRemember) lines.push("", SHARED);
	const options = CHOICES.filter(([, answer]) => answer !== "always" || request.canRemember).map(([label]) => label);
	return { title: lines.join("\n"), options };
}

/** Answers approval requests for one tool call; `notes` collects what the model should be told. */
export function approver(ctx: Context, notes: Set<string>): CallOptions["approve"] {
	return async (request) => {
		if (!ctx?.hasUI || !ctx.ui) {
			notes.add(`${request.app || "This app"} is not allowed for computer use, and this Pi session has no UI to ask in. Allow it with /computer-use in an interactive Pi session.`);
			return "deny";
		}
		const { title, options } = approvalDialog(request);
		const picked = await ctx.ui.select(title, options, { signal: request.signal });
		return CHOICES.find(([label]) => label === picked)?.[1] ?? "deny";
	};
}

const label = (name: string, bundleId: string) => `${name} (${bundleId})`;

export async function computerUseMenu(ctx: { readonly ui: Ui }, deps: MenuDeps): Promise<void> {
	const state = deps.approvals.read();
	const allowed = state.ids.map((id) => ({ id, name: deps.appName(id) }));
	const summary = [...deps.status(), `Always allowed: ${allowed.length ? allowed.map((app) => app.name).join(", ") : "none"}`];
	if (!state.writable) {
		ctx.ui.notify([...summary, `Can't change these here: ${state.problem}.`].join("\n"), "warning");
		return;
	}
	const picked = await ctx.ui.select(summary.join("\n"), allowed.length ? [ALLOW_APP, REVOKE_APP] : [ALLOW_APP]);
	try {
		if (picked === REVOKE_APP) await revoke(ctx, deps, allowed);
		else if (picked === ALLOW_APP) await allow(ctx, deps, new Set(state.ids));
	} catch (error) {
		ctx.ui.notify(`Computer use: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function revoke(ctx: { readonly ui: Ui }, deps: MenuDeps, allowed: Array<{ id: string; name: string }>): Promise<void> {
	const choice = await ctx.ui.select("Stop always allowing which app?", allowed.map((app) => label(app.name, app.id)));
	const app = allowed.find((candidate) => label(candidate.name, candidate.id) === choice);
	if (!app) return;
	if (!await ctx.ui.confirm(`Stop always allowing ${app.name}?`, `The agent will have to ask again before it uses ${app.name}, in Pi and in ChatGPT and Codex computer use.`)) return;
	deps.approvals.revoke(app.id);
	ctx.ui.notify(`${app.name} is no longer always allowed; the agent will ask again next time.`, "info");
}

async function allow(ctx: { readonly ui: Ui }, deps: MenuDeps, allowed: Set<string>): Promise<void> {
	const apps = (await deps.listApps()).filter((app) => !allowed.has(app.bundleId));
	if (apps.length === 0) {
		ctx.ui.notify("Every app Computer Use lists is already always allowed. Open an app first if it is not listed.", "info");
		return;
	}
	const choice = await ctx.ui.select("Always allow which app? Running and recently used apps are listed.", apps.map((app) => label(app.name, app.bundleId)));
	const app = apps.find((candidate) => label(candidate.name, candidate.bundleId) === choice);
	if (!app) return;
	const warning = `The agent will be able to read and operate ${app.name} without asking, in every Pi session and in ChatGPT and Codex computer use. Browsers, mail and messaging apps carry a prompt injection risk: text shown in them can steer the agent.`;
	if (!await ctx.ui.confirm(`Always allow ${app.name}?`, warning)) return;
	deps.approvals.allow(app.bundleId);
	ctx.ui.notify(`${app.name} is always allowed. Remove it any time with /computer-use.`, "info");
}
