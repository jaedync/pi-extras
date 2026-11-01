/**
 * The models children may use, read when needed (scope.ts): the live session
 * scope, the list a /reload resolves from changed settings, and why a known
 * model is refused.
 */
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { forgetScopeRecords, liveModelScope, reloadOverride, scopeHint, startedWithModels } from "../lib/subagents/scope.ts";

afterEach(() => forgetScopeRecords());

const model = (id: string, provider = "openai-codex") => ({ provider, id, name: id });
const scoped = (...ids: string[]) => ids.map((id) => ({ model: model(id) }));
const refs = (scope: { allowed: readonly { ref: string }[] }) => scope.allowed.map((choice) => choice.ref);

test("the scope is read again at each call, so /scoped-models changes it at once", () => {
	let live = scoped("gpt-6-luna");
	const models = liveModelScope({ read: () => ({ scoped: live, parent: model("gpt-6-luna") }), defaultModel: null });
	assert.deepEqual(refs(models()), ["openai-codex/gpt-6-luna"]);
	live = scoped("gpt-6-luna", "gpt-6.1-terra");
	assert.deepEqual(refs(models()), ["openai-codex/gpt-6-luna", "openai-codex/gpt-6.1-terra"]);
	live = scoped("gpt-6.1-terra");
	assert.deepEqual(refs(models()), ["openai-codex/gpt-6.1-terra"], "a model taken out of scope is refused");
	assert.equal(models().fallbackModel, "openai-codex/gpt-6.1-terra", "the parent's model left the scope, so the first one is the default");
});

test("the same scope gives the same list, and a context Pi replaced gives the last list read", () => {
	const live = scoped("gpt-6-luna");
	let stale = false;
	const models = liveModelScope({ read: () => { if (stale) throw new Error("stale ctx"); return { scoped: live, parent: undefined }; }, defaultModel: null });
	const first = models();
	assert.equal(models(), first, "nothing changed, so nothing is built again");
	stale = true;
	assert.equal(models(), first);
});

test("a configured default follows the live scope", () => {
	let live = scoped("gpt-6-luna");
	const models = liveModelScope({ read: () => ({ scoped: live, parent: model("gpt-6-luna") }), defaultModel: "terra" });
	assert.equal(models().fallbackModel, "openai-codex/gpt-6-luna", "out of scope: the parent's model");
	live = scoped("gpt-6-luna", "gpt-6.1-terra");
	assert.equal(models().fallbackModel, "openai-codex/gpt-6.1-terra");
});

test("an override applies while the session scope is the list it replaced, and a later /scoped-models wins", () => {
	const stale = scoped("gpt-6-luna");
	let live = stale;
	const override = { base: stale, scoped: scoped("gpt-6-luna", "gpt-6.1-terra") };
	const models = liveModelScope({ read: () => ({ scoped: live, parent: undefined }), defaultModel: null, override: () => override });
	assert.deepEqual(refs(models()), ["openai-codex/gpt-6-luna", "openai-codex/gpt-6.1-terra"]);
	live = scoped("gpt-6-sol");
	assert.deepEqual(refs(models()), ["openai-codex/gpt-6-sol"]);
});

/** One start of a session, as serve.ts makes it. */
function start(live: readonly { model: ReturnType<typeof model> }[], patterns: string[] | undefined, options: { reload?: boolean; cliModels?: boolean; resolved?: Array<{ model: ReturnType<typeof model> }>; fail?: boolean } = {}) {
	const asked: string[][] = [];
	return {
		asked,
		result: reloadOverride({
			sessionId: "s1", reload: options.reload ?? true, live, patterns, cliModels: options.cliModels ?? false,
			resolve: async (wanted) => {
				asked.push([...wanted]);
				if (options.fail) throw new Error("catalog timeout");
				return options.resolved ?? [];
			},
		}),
	};
}

test("a /reload after an enabledModels edit resolves the new patterns and uses them", async () => {
	const stale = scoped("gpt-6-luna");
	assert.deepEqual(await start(stale, ["gpt-6-luna"], { reload: false }).result, {}, "a start only records the patterns");
	const reload = start(stale, ["gpt-6-luna", "openai-codex/gpt-6.1-terra"], { resolved: scoped("gpt-6-luna", "gpt-6.1-terra") });
	const { override } = await reload.result;
	assert.deepEqual(reload.asked, [["gpt-6-luna", "openai-codex/gpt-6.1-terra"]]);
	assert.equal(override?.base, stale);
	assert.deepEqual(override?.scoped.map((entry) => entry.model.id), ["gpt-6-luna", "gpt-6.1-terra"]);
	const again = start(stale, ["gpt-6-luna", "openai-codex/gpt-6.1-terra"]);
	assert.deepEqual((await again.result).override, override, "a second reload keeps the list while Pi's scope is unchanged");
	assert.deepEqual(again.asked, [], "and does not resolve again");
});

test("a /reload with unchanged settings keeps a /scoped-models change that was not saved", async () => {
	const stale = scoped("gpt-6-luna");
	await start(stale, ["gpt-6-luna"], { reload: false }).result;
	const sessionOnly = scoped("gpt-6-luna", "gpt-6-sol");
	const reload = start(sessionOnly, ["gpt-6-luna"]);
	assert.deepEqual(await reload.result, {});
	assert.deepEqual(reload.asked, []);
});

test("a session scope from --models is never replaced by enabledModels", async () => {
	const live = scoped("gpt-6-luna");
	await start(live, ["gpt-6-luna"], { reload: false, cliModels: true }).result;
	const reload = start(live, ["gpt-6.1-terra"], { cliModels: true, resolved: scoped("gpt-6.1-terra") });
	assert.deepEqual(await reload.result, {});
	assert.deepEqual(reload.asked, []);
});

test("a resolution that fails is told, uses the live scope, and is tried again at the next /reload", async () => {
	const live = scoped("gpt-6-luna");
	await start(live, ["gpt-6-luna"], { reload: false }).result;
	const failed = await start(live, ["gpt-6.1-terra"], { fail: true }).result;
	assert.equal(failed.override, undefined);
	assert.match(failed.warning ?? "", /catalog timeout/);
	const retry = start(live, ["gpt-6.1-terra"], { resolved: scoped("gpt-6.1-terra") });
	assert.deepEqual((await retry.result).override?.scoped.map((entry) => entry.model.id), ["gpt-6.1-terra"]);
});

test("a /reload whose settings resolve to the live scope needs no override", async () => {
	const live = scoped("gpt-6-luna");
	const { result } = start(live, ["luna"], { resolved: scoped("gpt-6-luna") });
	assert.deepEqual(await result, {});
});

test("a known model out of scope gets the reason and the fix; an unknown model gets none", () => {
	const known = [model("gpt-6-luna"), model("gpt-6.1-terra")];
	const inSettings = new Set(["openai-codex/gpt-6.1-terra"]);
	assert.match(scopeHint("gpt-6.1-terra", { known, settingsRefs: inSettings, cliModels: false }) ?? "",
		/openai-codex\/gpt-6\.1-terra is in enabledModels but not in this session's model scope\. Run \/reload, or enable it with \/scoped-models\./);
	assert.match(scopeHint("terra", { known, settingsRefs: new Set(), cliModels: false }) ?? "",
		/openai-codex\/gpt-6\.1-terra is not in this session's model scope\. Enable it with \/scoped-models, or add it to enabledModels in settings\.json and run \/reload\./);
	assert.match(scopeHint("terra", { known, settingsRefs: inSettings, cliModels: true }) ?? "",
		/started with --models, so enabledModels does not apply/);
	assert.equal(scopeHint("gpt-9", { known, settingsRefs: inSettings, cliModels: false }), undefined);
});

test("patterns that resolve to no model are told and not used, so the next /reload tries again", async () => {
	const live = scoped("gpt-6-luna");
	await start(live, ["gpt-6-luna"], { reload: false }).result;
	const empty = await start(live, ["gpt-6.1-terra"], { resolved: [] }).result;
	assert.equal(empty.override, undefined);
	assert.match(empty.warning ?? "", /match no model with credentials/);
	const retry = start(live, ["gpt-6.1-terra"], { resolved: scoped("gpt-6.1-terra") });
	assert.ok((await retry.result).override);
});

test("a model /model appends to the session scope keeps the override and adds that model", () => {
	const stale = scoped("gpt-6-luna");
	const override = { base: stale, scoped: scoped("gpt-6-luna", "gpt-6.1-terra") };
	let live: Array<{ model: ReturnType<typeof model> }> = stale;
	const models = liveModelScope({ read: () => ({ scoped: live, parent: undefined }), defaultModel: null, override: () => override });
	// Pi's `_addPersistedDefaultToNonEmptyScope` makes `[...old, { model }]`.
	live = [...stale, { model: model("gpt-6-sol") }];
	assert.deepEqual(refs(models()), ["openai-codex/gpt-6-luna", "openai-codex/gpt-6.1-terra", "openai-codex/gpt-6-sol"]);
	assert.equal(models(), models(), "built once for the same list");
	live = [...stale, { model: model("gpt-6.1-terra") }];
	assert.deepEqual(refs(models()), ["openai-codex/gpt-6-luna", "openai-codex/gpt-6.1-terra"], "no model twice");
	// /scoped-models builds new entries, even for the models it keeps.
	live = [{ model: model("gpt-6-luna") }, { model: model("gpt-6-sol") }];
	assert.deepEqual(refs(models()), ["openai-codex/gpt-6-luna", "openai-codex/gpt-6-sol"], "a new list is not an append: /scoped-models wins");
});

test("an empty scope (all models in /scoped-models) gets its own hint", () => {
	const known = [model("gpt-6-luna"), model("gpt-6.1-terra")];
	assert.match(scopeHint("terra", { known, settingsRefs: new Set(), cliModels: false, scopeEmpty: true }) ?? "",
		/The session's model scope is empty \(all models\), so subagents may use only main's model\. Pick the models in \/scoped-models, or set enabledModels in settings\.json and run \/reload\./);
});

test("--models counts only with a value after it, as Pi reads it", () => {
	assert.equal(startedWithModels(["node", "pi", "--models", "luna"]), true);
	assert.equal(startedWithModels(["node", "pi", "--models"]), false);
	assert.equal(startedWithModels(["node", "pi", "-p", "hi"]), false);
});
