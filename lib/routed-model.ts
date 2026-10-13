/**
 * Pi's virtual models (api "pi-virtual") pick a physical model for each
 * request. Extensions see only the selection in ctx.model, and Pi keeps the
 * routed model to itself (AgentSession.routedModel). Limits, quotas and
 * provider caches belong to the physical model, so this finds it as Pi does:
 * the model of the latest successful response on the branch. Before any
 * response, or when the registry no longer has that model, the selection
 * stands in, as in Pi.
 */

export const VIRTUAL_MODEL_API = "pi-virtual";

export interface SelectedModel {
	provider: string;
	id: string;
	api?: string;
}

export interface RoutingContext<M extends SelectedModel> {
	model?: M;
	sessionManager?: { getBranch?: () => readonly unknown[] };
	modelRegistry?: { find?: (provider: string, id: string) => M | undefined };
}

export const isVirtualModel = (model: { api?: string } | undefined): boolean => model?.api === VIRTUAL_MODEL_API;

interface ResponseLike { role?: unknown; provider?: unknown; model?: unknown; stopReason?: unknown }

/**
 * The provider and model id of the latest successful response; failed and
 * aborted requests are skipped unless `failed` is set (the latest request of any outcome).
 */
export function latestResponse(branch: readonly unknown[], failed = false): { provider: string; id: string } | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const message = (branch[i] as { type?: unknown; message?: ResponseLike } | null)?.message;
		if ((branch[i] as { type?: unknown } | null)?.type !== "message" || message?.role !== "assistant") continue;
		if (!failed && (message.stopReason === "error" || message.stopReason === "aborted")) continue;
		if (typeof message.provider === "string" && typeof message.model === "string") return { provider: message.provider, id: message.model };
	}
	return undefined;
}

/**
 * The physical model behind the selection: the selection itself unless it is
 * virtual. `failed` also counts a failed request, for code that handles its error.
 */
export function routedModel<M extends SelectedModel>(ctx: RoutingContext<M>, failed = false): M | undefined {
	const selected = ctx.model;
	if (!selected || !isVirtualModel(selected) || typeof ctx.sessionManager?.getBranch !== "function") return selected;
	const latest = latestResponse(ctx.sessionManager.getBranch(), failed);
	const found = latest && typeof ctx.modelRegistry?.find === "function" ? ctx.modelRegistry.find(latest.provider, latest.id) : undefined;
	return found && !isVirtualModel(found) ? found : selected;
}
