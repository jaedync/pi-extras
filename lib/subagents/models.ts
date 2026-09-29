/**
 * Which models a subagent may run on, how a short name like "luna" finds one,
 * and which thinking level it gets when the call names none. The allowed set is
 * the session's scoped models (`enabledModels`), so the user curates it in one
 * place Pi already has.
 */

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type Thinking = (typeof THINKING_LEVELS)[number];

/** The parts of Pi's Model this module reads. */
export interface ModelLike {
	provider: string;
	id: string;
	name?: string;
}

export interface ModelChoice {
	ref: string;
	model: ModelLike;
	/** A level written into the `enabledModels` pattern itself, as in `luna:low`. */
	patternThinking?: Thinking;
}

export interface ThinkingSettings {
	modelThinkingLevels?: Record<string, Thinking | string>;
	defaultThinkingLevel?: Thinking | string;
}

export type Resolution = { ok: true; choice: ModelChoice } | { ok: false; error: string };

export const refOf = (model: ModelLike): string => `${model.provider}/${model.id}`;

export function isThinking(value: unknown): value is Thinking {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/**
 * Scoped models in their configured order. Pi treats an empty scope as "every
 * model", which is too many to offer, so then only the parent's model is.
 */
export function allowedModels(
	scoped: readonly { model: ModelLike; thinkingLevel?: string }[],
	parent: ModelLike | undefined,
): ModelChoice[] {
	const source = scoped.length > 0 ? scoped : parent ? [{ model: parent }] : [];
	const seen = new Set<string>();
	const choices: ModelChoice[] = [];
	for (const entry of source) {
		const ref = refOf(entry.model);
		if (seen.has(ref)) continue;
		seen.add(ref);
		const thinking = (entry as { thinkingLevel?: unknown }).thinkingLevel;
		choices.push(isThinking(thinking) ? { ref, model: entry.model, patternThinking: thinking } : { ref, model: entry.model });
	}
	return choices;
}

// "GPT 6.1" and "gpt-6.1" should find the same model.
const normalize = (text: string): string => text.toLowerCase().trim().replace(/[\s_]+/g, "-");

function listed(allowed: readonly ModelChoice[]): string {
	return allowed.map((choice) => choice.ref).join(", ") || "(none)";
}

/** Exact reference, then bare id, then a unique partial match on id or display name. */
export function resolveModel(query: string, allowed: readonly ModelChoice[]): Resolution {
	const wanted = normalize(query);
	if (allowed.length === 0) return { ok: false, error: `No models are allowed for subagents. Scope some with enabledModels.` };
	const exact = allowed.find((choice) => normalize(choice.ref) === wanted || normalize(choice.model.id) === wanted);
	if (exact) return { ok: true, choice: exact };
	const partial = allowed.filter((choice) =>
		normalize(choice.model.id).includes(wanted) || normalize(choice.model.name ?? "").includes(wanted));
	if (partial.length === 1) return { ok: true, choice: partial[0]! };
	if (partial.length > 1) {
		return { ok: false, error: `"${query}" matches ${partial.length} models: ${listed(partial)}. Name one exactly.` };
	}
	return { ok: false, error: `"${query}" is not one of the allowed models: ${listed(allowed)}.` };
}

/** Undefined leaves the choice to Pi, which clamps to what the model supports. */
export function thinkingFor(choice: ModelChoice, perCall: Thinking | undefined, settings: ThinkingSettings): Thinking | undefined {
	if (perCall) return perCall;
	if (choice.patternThinking) return choice.patternThinking;
	const perModel = settings.modelThinkingLevels?.[choice.ref];
	if (isThinking(perModel)) return perModel;
	return isThinking(settings.defaultThinkingLevel) ? settings.defaultThinkingLevel : undefined;
}

/** One line per model for the tool description. */
export function modelTable(allowed: readonly ModelChoice[], settings: ThinkingSettings): string {
	return allowed.map((choice) => {
		const name = choice.model.name && choice.model.name !== choice.model.id ? ` (${choice.model.name})` : "";
		const thinking = thinkingFor(choice, undefined, settings);
		return `- ${choice.ref}${name}${thinking ? `, thinking ${thinking}` : ""}`;
	}).join("\n");
}
