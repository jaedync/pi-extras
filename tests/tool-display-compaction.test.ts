import assert from "node:assert/strict";
import { BULLET_GLYPH } from "../lib/band/glyph.ts";
import test from "node:test";
import { CompactionSummaryMessageComponent, estimateTokens, getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { COMPACTION_ENTRY, estimateAfter, installCompactionBand, matchCompaction, registerCompaction, type CompactionHost } from "../lib/tool-display/compaction.ts";

import { bgOf, fgOf, quiet } from "./support/quiet-theme.ts";

initTheme("dark");
const base = quiet();
const theme = { ...base, getBgAnsi: (key: string) => key === "customMessageBg" ? bgOf("#30233e") : base.getBgAnsi(key), getFgAnsi: (key: string) => key === "customMessageLabel" ? fgOf("#bc9ce8") : base.getFgAnsi(key) };
const timestamp = "2026-06-01T10:00:00.000Z";
const summary = "## Goal\n\nKeep the summary readable.\n\n- First task\n- Second task\n\n## Next\n\nRun the checks.";
const message = { role: "compactionSummary", summary, tokensBefore: 385625, timestamp: Date.parse(timestamp) } as const;
const entry = { type: "compaction", id: "cmp-1", timestamp, summary, tokensBefore: message.tokensBefore, firstKeptEntryId: "kept", usage: { cost: { total: 0.0123 } } };
const record = { entryId: entry.id, reason: "threshold", startedAt: Date.parse(timestamp) - 12500, durationMs: 12500, tokensAfter: 42000 } as const;
const host = (over: Partial<CompactionHost> = {}): CompactionHost => ({ enabled: () => true, theme: () => theme, moreHint: () => "click for all", lookup: () => ({ ...record, cost: 0.0123 }), ...over });
const plain = (lines: string[]) => lines.map((line) => stripTerminalSequences(line).trimEnd());
const click = (row: CompactionSummaryMessageComponent, y = 0) => row.handleMouse({ type: "click", button: "left", x: 2, y, screenX: 2, screenY: y, width: 84, height: 30 } as never);

test("compaction is a purple band over a three-line Markdown preview on the compaction purple", () => {
	const undo = installCompactionBand(host());
	try {
		const row = new CompactionSummaryMessageComponent(message);
		const raw = row.render(84);
		const lines = plain(raw);
		assert.ok(lines[0]!.startsWith(`${BULLET_GLYPH} compaction auto`));
		assert.match(lines[0]!, /386k → ~42k\s+\$0.012\s+12.5s$/);
		assert.ok(raw[0]!.includes("\x1b[1m"));
		assert.equal(lines.length, 5);
		assert.ok(lines[1]!.startsWith("    Goal"));
		assert.match(lines.at(-1)!, /^    … \d+ more lines \(click for all\)$/);
		assert.ok(raw[1]!.startsWith(theme.getBgAnsi("customMessageBg")), "the body keeps Pi's compaction purple, apart from tool rows");
		// The band leans well into the label's mauve, so it reads as the row's header.
		const [r, g, b] = /48;2;(\d+);(\d+);(\d+)m/.exec(raw[0]!)!.slice(1).map(Number);
		assert.deepEqual([r, g, b], [79, 62, 99], "extracting the shared purple palette must not change compaction");
		assert.ok(r! - 0x30 >= 18 && b! - 0x3e >= 18 && b! > g!, `band ${r},${g},${b}`);
		assert.ok(raw[0]!.includes(theme.getFgAnsi("mdHeading")), "slow time uses the warm color");
	} finally { undo(); }
});

test("invalidating a row rebuilds its theme-dependent Markdown drawing", () => {
	const undo = installCompactionBand(host());
	try {
		const row = new CompactionSummaryMessageComponent(message);
		const first = row.render(84);
		assert.equal(row.render(84), first, "an unchanged frame keeps its drawing");
		row.invalidate();
		assert.notEqual(row.render(84), first, "theme invalidation rebuilds the drawing");
	} finally { undo(); }
});

test("Pi's expansion and clicks show full Markdown and collapse again", () => {
	const undo = installCompactionBand(host());
	try {
		const row = new CompactionSummaryMessageComponent(message, getMarkdownTheme());
		row.render(84);
		assert.ok(click(row));
		assert.ok(plain(row.render(84)).some((line) => line.includes("Run the checks.")));
		assert.ok(click(row, 1));
		assert.equal((row as unknown as { expanded: boolean }).expanded, false);
		row.setExpanded(true);
		assert.ok(plain(row.render(84)).some((line) => line.includes("Run the checks.")));
		row.setExpanded(false);
		assert.match(plain(row.render(84)).at(-1)!, /more lines/);
	} finally { undo(); }
});

test("old sessions show before tokens without inventing a reason, time or after size", () => {
	const undo = installCompactionBand(host({ lookup: () => undefined }));
	try {
		const row = new CompactionSummaryMessageComponent(message);
		assert.ok(plain(row.render(84))[0]!.startsWith(`${BULLET_GLYPH} compaction`));
		assert.match(plain(row.render(84))[0]!, /386k$/);
		for (const width of [1, 2, 3, 8, 20, 40, 84]) assert.ok(row.render(width).every((line) => visibleWidth(line) <= width), `width ${width}`);
	} finally { undo(); }
});

test("narrow bands preserve the rail, cutting the title; missing themes degrade safely", () => {
	const undo = installCompactionBand(host({ theme: () => ({ fg: () => { throw new Error("missing"); }, bg: () => { throw new Error("missing"); }, getFgAnsi: () => { throw new Error("missing"); }, getBgAnsi: () => { throw new Error("missing"); }, getColorMode: () => "truecolor", bold: (text: string) => text } as never) }));
	try {
		const row = new CompactionSummaryMessageComponent(message);
		assert.match(plain(row.render(40))[0]!, /386k → ~42k\s+\$0.012\s+12.5s$/);
		assert.ok(row.render(40).every((line) => visibleWidth(line) <= 40));
	} finally { undo(); }
});

test("reload owns one patch, old undo cannot disable it, off and undo pass through", () => {
	let enabled = true;
	const first = installCompactionBand(host());
	const patched = CompactionSummaryMessageComponent.prototype.render;
	const second = installCompactionBand(host({ enabled: () => enabled }));
	try {
		assert.equal(CompactionSummaryMessageComponent.prototype.render, patched);
		first();
		const row = new CompactionSummaryMessageComponent(message);
		assert.match(plain(row.render(84))[0]!, /compaction auto/);
		enabled = false;
		assert.ok(plain(row.render(84)).some((line) => line.includes("[compaction]")));
		enabled = true;
		second();
		assert.ok(plain(row.render(84)).some((line) => line.includes("[compaction]")));
	} finally { second(); }
});

test("unexpected internals and a broken host keep Pi's own renderer", () => {
	const undo = installCompactionBand(host({ lookup: () => { throw new Error("unexpected"); } }));
	try {
		assert.ok(plain(new CompactionSummaryMessageComponent(message).render(84)).some((line) => line.includes("[compaction]")));
	} finally { undo(); }
	const target = { render: () => ["native"], handleMouse: () => undefined };
	const stop = installCompactionBand(host(), target);
	try { assert.deepEqual(target.render(), ["native"]); } finally { stop(); }
	assert.doesNotThrow(() => installCompactionBand(host(), {})());
});

test("match prefers exact timestamp and otherwise only a unique summary/tokens pair", () => {
	const saved = { type: "custom", customType: COMPACTION_ENTRY, data: record };
	assert.deepEqual(matchCompaction(message, [entry, saved] as never), { ...record, cost: 0.0123 });
	assert.deepEqual(matchCompaction({ ...message, timestamp: message.timestamp + 20 }, [entry, saved] as never), { ...record, cost: 0.0123 });
	const duplicate = { ...entry, id: "cmp-2", timestamp: "2026-06-01T11:00:00Z" };
	assert.equal(matchCompaction({ ...message, timestamp: message.timestamp + 20 }, [entry, duplicate, saved] as never), undefined);
	assert.deepEqual(matchCompaction(message, [entry] as never), { entryId: entry.id, cost: 0.0123 });
	assert.deepEqual(matchCompaction(message, [entry, { ...saved, data: { ...record, durationMs: -1 } }] as never), { entryId: entry.id, cost: 0.0123 });
	assert.equal(matchCompaction({ ...message, summary: "unmatched" }, [entry, saved] as never), undefined);
});

test("summaries cannot inject terminal controls, and overflow keeps its reason", () => {
	const undo = installCompactionBand(host({ lookup: () => ({ entryId: "cmp", reason: "overflow", durationMs: 500 }) }));
	try {
		const row = new CompactionSummaryMessageComponent({ ...message, summary: "safe\u001b]0;bad title\u0007\u001b[2J\nnext" });
		const raw = row.render(84).join("\n");
		assert.ok(!raw.includes("\u001b]0;") && !raw.includes("\u001b[2J"));
		assert.match(stripTerminalSequences(raw), /compaction overflow\s+386k\s+500ms/);
	} finally { undo(); }
});

test("after size sums Pi estimates, ignoring stale usage and superseded system entries", () => {
	const system = { role: "system", content: "active system" };
	const user = { role: "user", content: "kept context" };
	const assistant = { role: "assistant", content: [{ type: "text", text: "previous answer" }], usage: { input: 900000 } };
	assert.equal(estimateAfter([{ role: "system", content: "old" }, system, user, assistant] as never), estimateTokens(system as never) + estimateTokens(user as never) + estimateTokens(assistant as never));
});

function harness() {
	let now = 1000;
	let branch: unknown[] = [];
	const handlers = new Map<string, Function>();
	const notices: string[] = [];
	const appended: unknown[] = [];
	let failSave = false;
	const pi = { on: (event: string, handler: Function) => handlers.set(event, handler), appendEntry: (customType: string, data: unknown) => { if (failSave) throw new Error("read-only"); const saved = { type: "custom", customType, data }; appended.push(saved); branch = [...branch, saved]; } };
	const ctx = { mode: "tui", ui: { theme, notify: (text: string) => notices.push(text) }, sessionManager: { getBranch: () => branch, buildSessionProjection: () => ({ messages: [{ role: "user", content: "post-compaction context" }] }) } };
	const display = registerCompaction(pi as never, { enabled: () => true, now: () => now, moreHint: () => "click for all" });
	display.start(ctx as never);
	return { display, appended, notices, ctx, fire: (name: string, event: object = {}) => handlers.get(name)!(event, ctx), setNow: (value: number) => { now = value; }, setBranch: (value: unknown[]) => { branch = value; }, failSave: () => { failSave = true; } };
}

test("success saves start, duration, reason and estimated after size, then resume restores them", () => {
	const h = harness();
	try {
		h.fire("session_before_compact", { reason: "manual", signal: new AbortController().signal });
		h.setNow(3500);
		h.setBranch([entry]);
		h.fire("session_compact", { compactionEntry: entry, reason: "manual" });
		const saved = h.appended[0] as { data: Record<string, unknown> };
		assert.deepEqual(saved.data, { entryId: entry.id, reason: "manual", startedAt: 1000, durationMs: 2500, tokensAfter: 6 });
		h.display.stop();
		h.display.start(h.ctx as never);
		assert.match(plain(new CompactionSummaryMessageComponent(message).render(84))[0]!, /compaction manual\s+386k → ~6\s+\$0.012\s+2.5s/);
	} finally { h.display.stop(); }
});

test("branch changes drop abandoned records, and non-terminal sessions keep Pi's renderer", () => {
	const h = harness();
	try {
		h.setBranch([entry, { type: "custom", customType: COMPACTION_ENTRY, data: record }]);
		assert.match(plain(new CompactionSummaryMessageComponent(message).render(84))[0]!, /compaction auto/);
		h.setBranch([]);
		assert.ok(plain(new CompactionSummaryMessageComponent(message).render(84))[0]!.startsWith(`${BULLET_GLYPH} compaction`));
		h.display.start({ ...h.ctx, mode: "print" } as never);
		assert.ok(plain(new CompactionSummaryMessageComponent(message).render(84)).some((line) => line.includes("[compaction]")));
	} finally { h.display.stop(); }
});

test("failed and aborted runs do not leak timing into later success; save failures are reported", () => {
	const h = harness();
	try {
		const controller = new AbortController();
		h.fire("session_before_compact", { reason: "threshold", signal: controller.signal });
		controller.abort();
		h.fire("session_compact_failed");
		h.setNow(10000);
		h.setBranch([entry]);
		h.fire("session_compact", { compactionEntry: entry, reason: "overflow" });
		assert.equal((h.appended[0] as { data: { durationMs?: number } }).data.durationMs, undefined);
		h.failSave();
		h.fire("session_compact", { compactionEntry: entry, reason: "manual" });
		assert.match(h.notices[0]!, /Could not save compaction/);
	} finally { h.display.stop(); }
});
