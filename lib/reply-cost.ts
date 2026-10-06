/** What a reply cost: Pi's recorded figure, else an estimate from the model's prices (as Status Plus does). */
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { estimateUsageCost } from "./status-plus-logic.ts";

export interface PricedReply {
	readonly usage?: { readonly output?: number; readonly cost?: { readonly total?: number } };
	readonly provider?: string;
	readonly model?: string;
}

export function replyCost(ctx: Pick<ExtensionContext, "modelRegistry"> | undefined, message: PricedReply): number {
	const recorded = message.usage?.cost?.total ?? 0;
	if (recorded > 0 || !ctx || !message.usage || !message.provider || !message.model) return recorded;
	const model = ctx.modelRegistry.find(message.provider, message.model);
	return model ? estimateUsageCost(message.usage as Parameters<typeof estimateUsageCost>[0], model.cost) : recorded;
}
