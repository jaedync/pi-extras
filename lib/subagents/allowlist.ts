/**
 * A subagent's tool allowlist: the `tools` its spawn names, out of the tools
 * it could have. Its team tools (`message`, `clock`, and `subagent` and
 * `stop_subagent` when it may start subagents) are always kept, so naming
 * them is allowed and changes nothing. A read-only subagent may have only
 * the tools in `READ_ONLY_TOOLS`.
 */

/** Pi's built-in tools that read files. A read-only child always has them, and the read guard checks their paths (hidden.ts). */
export const PI_READ_TOOLS: readonly string[] = ["read", "grep", "find", "ls"];
/**
 * All a read-only child may have: tools that can't change the user's files or
 * run commands that the model chooses. Pi's read tools, then this package's and
 * common search and fetch tools (`pull_link` runs only its own media tools). Any other tool, an extension's or an MCP server's, could write, so it
 * is left out; an allowlist, not a list of the tools that write.
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
	...PI_READ_TOOLS,
	"pull_link", "kagi_search", "web_search", "fetch_content", "get_search_content", "web_fetch",
]);
/** What a read-only child may have; with `shell`, bash too, which its sandbox keeps from writing (sandbox.ts). */
export const readOnlyTools = (shell: boolean): ReadonlySet<string> => (shell ? new Set([...READ_ONLY_TOOLS, "bash"]) : READ_ONLY_TOOLS);

/** The child tool that reads the time (tools.ts): every child has it, a read-only one included, so none needs a shell for `date -u`. */
export const CLOCK_TOOL = "clock";
const TEAM_TOOLS: ReadonlySet<string> = new Set(["message", CLOCK_TOOL, "subagent", "stop_subagent"]);

/** Its tools: what it could have, cut to its allowlist when it has one. */
export function allowedTools(available: readonly string[], allowlist: readonly string[] | undefined): string[] {
	return allowlist ? available.filter((name) => allowlist.includes(name)) : [...available];
}

/** The allowlist a spawn asked for, without team tools and repeats, or why it can't have it. */
export function checkAllowlist(requested: readonly string[], available: readonly string[], readOnly: boolean, shell = false): { ok: true; tools: string[] } | { ok: false; error: string } {
	const can = `It can have: ${available.join(", ") || "(none)"}.`;
	if (requested.length === 0) return { ok: false, error: `tools is empty. List the tools the subagent needs, or leave tools out to give it all of them. ${can}` };
	const wanted = [...new Set(requested.map((name) => name.trim()))].filter((name) => !TEAM_TOOLS.has(name));
	const allowed = readOnlyTools(shell);
	const writes = readOnly ? wanted.filter((name) => !allowed.has(name)) : [];
	if (writes.length > 0) {
		return { ok: false, error: `readOnly: true gives only tools that can't change your files or run commands that the model chooses, so tools cannot list ${writes.join(", ")}. Remove ${writes.length === 1 ? "it" : "them"} from tools, or leave out readOnly. ${can}` };
	}
	const missing = wanted.filter((name) => !available.includes(name));
	if (missing.length > 0) {
		return { ok: false, error: `${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} not available to this subagent. ${can} Its message tool is always included.` };
	}
	return { ok: true, tools: wanted };
}
