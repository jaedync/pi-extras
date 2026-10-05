/**
 * A subagent's tool allowlist: the `tools` its spawn names, out of the tools
 * it could have. Its team tools (`message`, and `subagent` and
 * `stop_subagent` when it may start subagents) are always kept, so naming
 * them is allowed and changes nothing.
 */
import { WRITE_TOOLS } from "./child.ts";

const TEAM_TOOLS: ReadonlySet<string> = new Set(["message", "subagent", "stop_subagent"]);

/** Its tools: what it could have, cut to its allowlist when it has one. */
export function allowedTools(available: readonly string[], allowlist: readonly string[] | undefined): string[] {
	return allowlist ? available.filter((name) => allowlist.includes(name)) : [...available];
}

/** The allowlist a spawn asked for, without team tools and repeats, or why it can't have it. */
export function checkAllowlist(requested: readonly string[], available: readonly string[], readOnly: boolean): { ok: true; tools: string[] } | { ok: false; error: string } {
	const can = `It can have: ${available.join(", ") || "(none)"}.`;
	if (requested.length === 0) return { ok: false, error: `tools is empty. List the tools the subagent needs, or leave tools out to give it all of them. ${can}` };
	const wanted = [...new Set(requested.map((name) => name.trim()))].filter((name) => !TEAM_TOOLS.has(name));
	const writes = wanted.filter((name) => WRITE_TOOLS.has(name));
	if (readOnly && writes.length > 0) {
		return { ok: false, error: `readOnly: true takes away bash, edit and write, so tools cannot list ${writes.join(", ")}. Remove ${writes.length === 1 ? "it" : "them"} from tools, or leave out readOnly.` };
	}
	const missing = wanted.filter((name) => !available.includes(name));
	if (missing.length > 0) {
		return { ok: false, error: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not available to this subagent. ${can} Its message tool is always included.` };
	}
	return { ok: true, tools: wanted };
}
