import { test } from "node:test";
import assert from "node:assert/strict";
import { stripAnsi } from "../lib/ansi.ts";
import { meshText, splitMeshStatuses } from "../lib/status-plus-mesh.ts";

const paint = { fg: (tone: string, text: string) => `<${tone}>${text}</${tone}>` };

test("remote-pi slots fold into one mesh state, other statuses pass through", () => {
	const { mesh, others } = splitMeshStatuses([
		["subagents", "subagents: 2 running"],
		["remote-pi:session", "📡 backend (2)"],
		["remote-pi:relay", "🟢 relay"],
		["remote-pi:peer-active", "📱 ab12"],
	]);
	assert.deepEqual(mesh, { session: "backend", peerCount: 2, relay: "paired", device: "ab12" });
	assert.deepEqual(others, ["subagents: 2 running"]);
});

test("relay waiting for pairing reads as unpaired, and cleared slots vanish", () => {
	const { mesh } = splitMeshStatuses([
		["remote-pi:relay", "🟡 relay waiting for pairing"],
		["remote-pi:session", ""],
	]);
	assert.deepEqual(mesh, { relay: "unpaired" });
	assert.equal(splitMeshStatuses([["remote-pi:session", ""]]).mesh, undefined);
	assert.equal(splitMeshStatuses([]).mesh, undefined);
});

test("wording survives icon changes and unknown slots do not crash", () => {
	const { mesh } = splitMeshStatuses([
		["remote-pi:session", "backend (0)"],
		["remote-pi:peer-active", "phone-7"],
		["remote-pi:future", "whatever"],
	]);
	assert.deepEqual(mesh, { session: "backend", peerCount: 0, device: "phone-7" });
});

test("mesh cell tones each part by meaning and stays empty without state", () => {
	assert.equal(meshText(paint, undefined, false), "");
	const full = meshText(paint, { session: "backend", peerCount: 2, relay: "paired", device: "ab12" }, false);
	assert.equal(full, "<text>backend</text><dim> (2)</dim><dim> · </dim><success>relay</success><dim> · </dim><accent>ab12</accent>");
	assert.equal(stripAnsi(full), "<text>backend</text><dim> (2)</dim><dim> · </dim><success>relay</success><dim> · </dim><accent>ab12</accent>");
	assert.equal(meshText(paint, { relay: "unpaired" }, false), "<warning>relay unpaired</warning>");
	assert.equal(meshText(paint, { relay: "unpaired", session: "x" }, true), "<text>x</text><dim> </dim><warning>relay ?</warning>");
});
