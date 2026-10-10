/**
 * OpenCode Go usage caps. Go limits are dollar amounts per model: each model
 * has a monthly cap, the five-hour window allows 20% of it and the weekly
 * window 50%. The usage endpoint reports one percentage per window and no
 * plan, so the plan and any changed caps come from settings.
 *
 * Source: https://opencode.ai/docs/go/ "Usage limits", read 2026-10-10.
 * Free preview models are unlimited and are left out.
 */

export type OpenCodeGoPlan = "go" | "go-plus";

export const OPENCODE_GO_PLANS: readonly OpenCodeGoPlan[] = ["go", "go-plus"];

/** Monthly cap in USD per model id, [Go, Go Plus]. */
const MONTHLY_CAPS: Record<string, readonly [number, number]> = {
	"glm-5.3-flash": [60, 180],
	"glm-5.3": [15, 120],
	"glm-5.2": [60, 180],
	"kimi-k3": [15, 60],
	"kimi-k2.7-code": [60, 180],
	"kimi-k2.6": [60, 240],
	"longcat-2.0": [60, 240],
	"mimo-v2.6-flash": [60, 120],
	"mimo-v2.6-pro": [15, 60],
	"mimo-v2.5": [60, 120],
	"mimo-v2.5-pro": [15, 60],
	"minimax-m3": [60, 180],
	"minimax-m2.7": [60, 240],
	"muse-spark-1.3-contributor": [60, 120],
	"muse-spark-1.2-contributor": [60, 120],
	"qwen3.8-max": [15, 60],
	"qwen3.8-flash": [30, 90],
	"qwen3.7-plus": [60, 180],
	"deepseek-v4.1-flash": [60, 120],
	"deepseek-v4-pro": [15, 60],
	"deepseek-v4-flash": [30, 120],
	"deepseek-v4-flash-vision-exp": [15, 60],
	"hy4-preview": [30, 120],
	"hy3": [60, 240],
	"space-bunny": [30, 120],
	"grok-4.7": [15, 60],
	"grok-4.6": [15, 60],
	"gpt-6-luna": [15, 60],
	"gpt-5.6-luna": [15, 60],
	"claude-haiku-5-5": [15, 60],
};

/** Share of the monthly cap each usage-endpoint window allows. */
export const OPENCODE_GO_WINDOW_SHARE: Record<string, number> = { rolling: 0.2, weekly: 0.5, monthly: 1 };

export function isOpenCodeGoPlan(value: unknown): value is OpenCodeGoPlan {
	return typeof value === "string" && (OPENCODE_GO_PLANS as readonly string[]).includes(value);
}

/** A settings override wins; an unknown model has no cap. */
export function openCodeGoMonthlyCap(
	modelId: string,
	plan: OpenCodeGoPlan,
	overrides: Readonly<Record<string, number>> = {},
): number | undefined {
	const override = overrides[modelId];
	if (typeof override === "number" && Number.isFinite(override) && override > 0) return override;
	const caps = MONTHLY_CAPS[modelId];
	return caps ? caps[plan === "go" ? 0 : 1] : undefined;
}
