/**
 * The handover contract (contract.ts): what one evaluation of the package
 * calls on objects another one made across a /reload. Its declarations are
 * pinned to `HOST_VERSION`, so changing one without a bump fails here. On a
 * deliberate change: bump HOST_VERSION in lib/subagents/contract.ts, then put
 * the new version and the digest this test prints into PINNED.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { HOST_VERSION } from "../lib/subagents/contract.ts";
import { MainMail } from "../lib/subagents/deliver.ts";
import { Team } from "../lib/subagents/team.ts";
import { ToolActivity } from "../lib/subagents/tool-activity.ts";

const PINNED = { version: 1, digest: "63b54ad3f6e403ac8facecf8738f60e3ceab3933f44279f7d4ebf1cebf119c56" };

/** Every declaration that crosses from one evaluation to the next, by the file that declares it. */
const CONTRACT: Record<string, readonly string[]> = {
	"lib/subagents/contract.ts": ["HostTeam", "HostMail", "HostActivity", "HostMessage", "ModelScope", "HostPorts", "HostState", "ParkedHost"],
	"lib/subagents/types.ts": ["AgentState", "Usage", "AgentWork", "FailureKind", "FallbackStep", "Worktree", "AgentRecord", "SpawnRequest", "ChildHandle", "ChildHooks", "Launcher"],
	"lib/subagents/team.ts": ["SendResult"],
	"lib/subagents/deliver.ts": ["Route", "MainContext", "OutgoingMessage", "MailDetails", "ReportSummary", "PendingItem"],
	"lib/subagents/tool-activity.ts": ["Watched"],
	"lib/subagents/models.ts": ["THINKING_LEVELS", "Thinking", "ModelLike", "ModelChoice"],
	"lib/subagents/stamp.ts": ["LaunchStamp"],
};

/** The text of `export interface`, `type` or `const` `name` up to where it closes, with comments and spacing dropped. */
function declaration(text: string, file: string, name: string): string {
	// Comments go first: a brace in one would count.
	const source = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
	const start = source.search(new RegExp(`^export (interface|type|const) ${name}\\b`, "m"));
	assert.ok(start >= 0, `${file} no longer declares ${name}; update CONTRACT and bump HOST_VERSION`);
	let depth = 0;
	for (let i = start; i < source.length; i++) {
		const char = source[i];
		if (char === "{" || char === "(" || char === "[") depth++;
		else if (char === "}" || char === ")" || char === "]") {
			depth--;
			if (depth === 0 && source.startsWith("interface", start + "export ".length)) return normalize(source.slice(start, i + 1));
		} else if (char === ";" && depth === 0) return normalize(source.slice(start, i + 1));
	}
	assert.fail(`${name} in ${file} does not close`);
}

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

function digest(): string {
	const hash = createHash("sha256");
	for (const [file, names] of Object.entries(CONTRACT)) {
		const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
		for (const name of names) hash.update(`${file}#${name}\n${declaration(source, file, name)}\n`);
	}
	return hash.digest("hex");
}

test("the handover contract matches HOST_VERSION", () => {
	const now = digest();
	assert.equal(HOST_VERSION, PINNED.version, `HOST_VERSION changed: pin { version: ${HOST_VERSION}, digest: "${now}" } here`);
	assert.equal(now, PINNED.digest, `The handover contract changed (digest ${now}). Bump HOST_VERSION in lib/subagents/contract.ts and pin the new version and digest here.`);
});

test("the classes a later module calls have every method of their side of the contract", () => {
	const methods = (source: string, name: string) => {
		const body = declaration(source, "lib/subagents/contract.ts", name);
		return [...body.matchAll(/[{;] (\w+)\(/g)].map((match) => match[1]!);
	};
	const contract = readFileSync(new URL("../lib/subagents/contract.ts", import.meta.url), "utf8");
	for (const [name, prototype] of [["HostTeam", Team.prototype], ["HostMail", MainMail.prototype], ["HostActivity", ToolActivity.prototype]] as const) {
		const wanted = methods(contract, name);
		assert.ok(wanted.length > 3, `read the methods of ${name}`);
		for (const method of wanted) assert.equal(typeof (prototype as unknown as Record<string, unknown>)[method], "function", `${name}.${method}`);
	}
});
