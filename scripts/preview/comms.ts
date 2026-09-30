/** Credential-free communication samples: node scripts/preview/comms.ts > /tmp/comms-purple/comms.ansi */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { CompactionSummaryMessageComponent, getMarkdownTheme, initTheme } from "@earendil-works/pi-coding-agent";
import { createMessageRenderer, createReportRenderer, messageCallRow } from "../../lib/subagents/render.ts";
import { installCompactionBand } from "../../lib/tool-display/compaction.ts";
import { foreignRenderers } from "../../lib/tool-display/foreign.ts";
import { createMeshMessageRenderer } from "../../lib/tool-display/mesh.ts";
import type { RenderContext } from "../../lib/tool-display/kit.ts";
import { agentRoot } from "../../tests/support/pi-runtime.mjs";
import { harness, text } from "../../tests/support/tool-rows.ts";

initTheme("dark");
const { theme } = await import(pathToFileURL(join(agentRoot, "dist/modes/interactive/theme/theme.js")).href);
const width = 100;
const mesh = createMeshMessageRenderer(() => getMarkdownTheme());
const mail = createMessageRenderer(() => getMarkdownTheme());
const options = { expanded: false } as never;
const meshMessage = (re?: string) => ({ content: `[agent-network] message from "/workspace/demo@scout" (id=msg-1${re ? `, re=${re}` : ""}):\n${re ? "**Reply:** yes, the synthetic fixtures cover both Pi versions." : "Found **three** places that render agent mail.\n\n- Mesh envelopes\n- Subagent notes\n- Message calls"}\n\n${re ? "(This is a reply to a previous message of yours.)" : '(If a reply is expected, call agent_send with to="/workspace/demo@scout" and re="msg-1".)'}` });
const samples: string[] = [];
const add = (label: string, lines: string[]) => samples.push(label, ...lines, "");

add("Incoming mesh message", mesh(meshMessage() as never, options, theme)!.render(width));
add("Incoming mesh reply", mesh(meshMessage("prior-2") as never, options, theme)!.render(width));

for (const isError of [false, true]) {
	const h = harness();
	const renderer = foreignRenderers(h.kit, { name: "agent_send" });
	const args = { to: "/workspace/demo@scout", message: "Please check the synthetic fixtures." };
	const context: RenderContext = { args, toolCallId: "mesh-call", state: {}, lastComponent: undefined, cwd: "/workspace/demo",
		executionStarted: true, argsComplete: true, isPartial: true, expanded: false, isError: false, invalidate() {} };
	const call = renderer.renderCall(args, theme, context);
	call.render(width);
	h.advance(1_100);
	const result = renderer.renderResult(text(isError ? "Peer is unavailable. Try again after it reconnects." : "Delivered to scout."),
		{ expanded: false, isPartial: false }, theme, { ...context, isPartial: false, isError });
	add(`agent_send (${isError ? "error" : "ok"})`, [...call.render(width), ...result.render(width)]);
	h.kit.clock.stop();
}

add("Subagent message call", messageCallRow({ to: "reader", text: "Check the parser fallback.", expectReply: true }, theme,
	{ state: { delivered: "steered" }, isPartial: false }).render(width));
for (const kind of ["note", "question"] as const) {
	add(`Incoming subagent ${kind}`, mail({ details: { id: "mail-1", kind, from: "reader",
		text: kind === "question" ? "Should **unparseable envelopes** stay visible as raw text?" : "The fallback preserves the **full model-facing content**." } } as never, options, theme)!.render(width));
}

const undo = installCompactionBand({ enabled: () => true, theme: () => theme, moreHint: () => "click for all",
	lookup: () => ({ entryId: "compaction-1", reason: "threshold", tokensAfter: 42_000, durationMs: 12_500, cost: 0.0123 }) });
try {
	add("Compaction (unchanged purple comparison)", new CompactionSummaryMessageComponent({ role: "compactionSummary",
		summary: "## Goal\n\nKeep the envelope in model context and the human view concise.", tokensBefore: 385_625, timestamp: 0 }).render(width));
} finally { undo(); }

const reports = createReportRenderer(() => getMarkdownTheme());
add("Report (outcome colors retained)", reports({ details: { kind: "report", reports: [{ name: "reader", model: "synthetic/model",
	state: "idle", report: "All focused checks passed.", cost: 0.01, startedAt: 0, endedAt: 5_000 }] } } as never, options, theme)!.render(width));
process.stdout.write(samples.join("\n") + "\n");
