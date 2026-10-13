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

const PINNED = { version: 4, digest: "1a0ab86dcd23af32725a2d1ae195b29a30270a089169ef1761804ef850a950ec" };

/**
 * Every declaration that crosses from one evaluation to the next, by the file
 * that declares it: the shapes either side calls, the values both sides match
 * on (a renamed message type would leave old mail pending for good), the
 * globalThis slots and what they hold, and the mail the index keeps for a
 * start of another version.
 */
const CONTRACT: Record<string, readonly string[]> = {
	"lib/subagents/contract.ts": ["HostTeam", "HostMail", "HostActivity", "HeldMail", "HostMessage", "ModelScope", "HostPorts", "HostState", "ParkedHost"],
	"lib/subagents/types.ts": ["AgentState", "ACTIVE_STATES", "LIVE_STATES", "Usage", "AgentWork", "FailureKind", "FallbackStep", "Worktree", "AgentRecord", "CheckSpec", "CheckUpdate", "CheckResult", "CheckRun", "SpawnRequest", "ChildHandle", "ChildHooks", "Launcher"],
	"lib/subagents/team.ts": ["SendResult"],
	"lib/subagents/deliver.ts": ["MESSAGE_TYPE", "REPORT_TYPE", "Route", "MainContext", "OutgoingMessage", "MailDetails", "ReportSummary", "PendingItem"],
	"lib/subagents/tool-activity.ts": ["Watched"],
	"lib/subagents/models.ts": ["THINKING_LEVELS", "Thinking", "ModelLike", "ModelChoice"],
	"lib/subagents/stamp.ts": ["LaunchStamp"],
	"lib/subagents/host.ts": ["Registry", "REGISTRY"],
	"lib/subagents/fresh-models.ts": ["ModelsRead", "READS"],
};

/** The text of the interface, type or const `name`, exported or not, up to where it closes, with comments and spacing dropped. */
function declaration(text: string, file: string, name: string): string {
	// Comments go first: a brace in one would count.
	const source = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
	const found = new RegExp(`^(?:export )?(interface|type|const) ${name}\\b`, "m").exec(source);
	assert.ok(found, `${file} no longer declares ${name}; update CONTRACT and bump HOST_VERSION`);
	const start = found.index;
	let depth = 0;
	for (let i = start; i < source.length; i++) {
		const char = source[i];
		if (char === "{" || char === "(" || char === "[") depth++;
		else if (char === "}" || char === ")" || char === "]") {
			depth--;
			if (depth === 0 && found[1] === "interface") return normalize(source.slice(start, i + 1));
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
