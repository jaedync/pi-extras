import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { agentRoot } from "./support/pi-runtime.mjs";
import { fingerprint } from "../lib/cache-compaction/core.ts";
import { foldProjection, foldSystem } from "../lib/cache-compaction/system-fold.ts";
const ai = await import(pathToFileURL(join(agentRoot, "node_modules/@earendil-works/pi-ai/dist/index.js")).href);
const tool = (name: string, description = name) => ({ name, description, parameters: { type: "object", properties: {} } });
const user = { role: "user", content: "Fixture user.", timestamp: 8 };

for (const [name, messages] of Object.entries({
	empty: [],
	"no system": [user],
	"empty system": [{ role: "system", content: "", timestamp: 0 }],
	"content, sections and tool deltas": [
		{ role: "custom", customType: "startup", content: "Fixture metadata.", display: false, timestamp: 0 },
		{ role: "system", content: [{ type: "text", text: "First block." }, { type: "text", text: "Second block." }], sections: { old: "remove", change: "before", unchanged: "stay" }, toolsAdded: [tool("remove"), tool("replace"), tool("stay")], timestamp: 2 },
		user,
		{ role: "system", content: "Later addition.", sections: { old: null, change: "after", added: "new" }, toolsRemoved: [{ name: "remove" }], toolsAdded: [tool("replace", "replacement"), tool("new")], timestamp: 3 },
		{ role: "system", content: "", sections: { added: null }, toolsRemoved: [{ name: "stay" }], timestamp: 4 },
	],
	"fully removed state": [{ role: "system", content: "", sections: { one: "value" }, toolsAdded: [tool("one")], timestamp: 0 }, { role: "system", content: "", sections: { one: null }, toolsRemoved: [{ name: "one" }], timestamp: 1 }],
})) test(`system fold matches native Pi exactly: ${name}`, () => {
	const before = structuredClone(messages);
	assert.deepEqual(foldSystem(messages as any), ai.getCurrentSystemMessage(messages));
	assert.deepEqual(messages, before);
});

test("the exact native fold maps every original system entry to the leading checkpoint", () => {
	const messages: any[] = [{ role: "custom", customType: "fixture", content: "metadata", display: false, timestamp: 0 }, { role: "system", content: "Base.", timestamp: 1 }, user, { role: "system", content: "Delta.", timestamp: 3 }];
	const request = [ai.getCurrentSystemMessage(messages), ...messages.filter((message) => message.role !== "system")];
	const folded = foldProjection(messages, request, fingerprint);
	assert.deepEqual(folded.messages, request);
	assert.deepEqual(folded.indices, [1, 0, 2, 0]);
});

for (const change of ["content", "timestamp", "extra system", "non-leading head"]) test(`system projection rejects anything other than the exact native fold: ${change}`, () => {
	const messages: any[] = [{ role: "system", content: "Base.", timestamp: 1 }, user, { role: "system", content: "Delta.", timestamp: 3 }];
	const head = ai.getCurrentSystemMessage(messages);
	const request = change === "extra system" ? [head, user, messages[2]] : change === "non-leading head" ? [user, head] : [{ ...head, ...(change === "content" ? { content: "Rewritten prompt." } : { timestamp: 99 }) }, user];
	const folded = foldProjection(messages, request, fingerprint);
	assert.equal(folded.messages, messages);
	assert.deepEqual(folded.indices, [0, 1, 2]);
});

test("system projection leaves system-free canonical messages unchanged", () => {
	const messages: any[] = [user];
	assert.equal(foldProjection(messages, messages, fingerprint).messages, messages);
});
