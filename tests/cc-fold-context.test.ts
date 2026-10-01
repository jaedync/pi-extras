import assert from "node:assert/strict";
import test from "node:test";
import { buildContextEntries, initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { registerToolDisplay, TOOL_NAMES } from "../lib/tool-display/index.ts";
import { DEFAULT_SETTINGS } from "../lib/tool-display/settings.ts";

initTheme("dark");
const assistant = (id: string) => ({ role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: { path: `${id}.txt` } }] });
const result = (id: string) => ({ role: "toolResult", toolCallId: id, isError: false, content: [{ type: "text", text: "content" }] });
const branch = [assistant("before"), result("before"), assistant("kept"), result("kept"), { role: "assistant", content: [{ type: "text", text: "done" }] }].map((message, i) => ({ type: "message", id: String(i), parentId: i ? String(i - 1) : null, message }));
const compacted = [...branch, { type: "compaction", id: "compact", parentId: "4", firstKeptEntryId: "2", summary: "Earlier work", tokensBefore: 100 }];
function fixture(initial: readonly unknown[]) {
 const handlers = new Map<string, Function[]>();
 let entries = initial;
 const definitions = Object.fromEntries(TOOL_NAMES.map(name => [name, { name, parameters: {}, description: name, execute: async () => ({ content: [] }) }]));
 const ctx = { mode: "tui", ui: { requestRender() {} }, sessionManager: { getBranch: () => entries, buildContextEntries: () => buildContextEntries(entries as never), buildSessionProjection: () => ({ messages: [] }) } };
 registerToolDisplay({ on: (name: string, fn: Function) => handlers.set(name, [...(handlers.get(name) ?? []), fn]), events: { on: () => () => {}, emit() {} }, registerTool: (tool: { name: string }) => { definitions[tool.name] = tool as never; }, getAllTools: () => TOOL_NAMES.map(name => ({ name, sourceInfo: { source: "builtin" } })), registerCommand() {}, appendEntry() {} } as never, {
  tools: () => ({ definitions: definitions as never, fullscreen: true }), settings: { read: () => DEFAULT_SETTINGS, write() {} }, writeToolCount() {},
  host: { expandHint: () => "ctrl+o", highlight: code => code.split("\n"), language: () => undefined, diff: d => d, fileUrl: () => undefined, now: () => 0 },
 });
 const fire = (name: string, event: object = {}) => { for (const fn of handlers.get(name) ?? []) fn({ type: name, compactionEntry: compacted.at(-1), ...event }, ctx); };
 const row = (id: string, args: object = { path: `${id}.txt` }) => {
  const tool = new ToolExecutionComponent("read", id, args, {}, definitions.read as never, ctx.ui as never, "/work");
  tool.updateResult(result(id) as never, false);
  return tool;
 };
 return { fire, row, setEntries: (next: readonly unknown[]) => { entries = next; } };
}
const draw = (row: ToolExecutionComponent) => stripTerminalSequences(row.render(70).join("\n"));
for (const event of ["session_start", "session_compact", "session_tree"]) {
 test(`${event} uses Pi's compacted context when a cut falls inside a tool chain`, () => {
  const f = fixture(event === "session_start" ? compacted : branch);
  try {
   if (event !== "session_start") f.fire("session_start");
   f.setEntries(compacted); f.fire(event);
   assert.match(draw(f.row("kept")), /Read 1 file/);
  } finally { f.fire("session_shutdown"); }
 });
}
test("resume replay matches live grouping after compaction", () => {
 const live = fixture([]);
 let before: string;
 try {
  live.fire("session_start");
  for (const message of branch.map(entry => entry.message)) live.fire("message_end", { message });
  live.setEntries(compacted); live.fire("session_compact");
  before = draw(live.row("kept"));
  assert.match(before, /Read 1 file/);
 } finally { live.fire("session_shutdown"); }
 const resumed = fixture(compacted);
 try { resumed.fire("session_start"); assert.equal(draw(resumed.row("kept")), before); }
 finally { resumed.fire("session_shutdown"); }
});
