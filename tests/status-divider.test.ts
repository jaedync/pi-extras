import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderStatusDivider } from "../lib/status-divider.ts";
const paint={border:(s:string)=>s,total:(s:string)=>s};
const model={status:"⢎⡱⣉ Thinking… ↓ 212 tokens",withoutTokens:"⢎⡱⣉ Thinking…",elapsedMs:15800,metrics:{ttftMinMs:700,ttftMaxMs:700,throughput:{outputTokens:1093,requestMs:10000}}};
test("divider keeps one timer and drops TPS, TTFT, then tokens, without wrapping",()=>{
 const full=renderStatusDivider(model,130,paint);assert.match(full,/Thinking… ↓ 212 tokens/);assert.match(full,/TPS 109.3/);assert.match(full,/TTFT 0.7s/);assert.match(full,/Time 00:15.8/);
 for(let width=0;width<=150;width++){
  const row=renderStatusDivider(model,width,paint);assert.ok(visibleWidth(row)<=width);assert.ok(!row.includes("\n"));
  assert.ok((row.match(/Time /g)??[]).length<=1);
  if(row.includes("TPS"))assert.ok(row.includes("TTFT"));
  if(row.includes("TTFT"))assert.ok(row.includes("tokens"));
  if(!row.includes("tokens")&&width>=30)assert.match(row,/Thinking…/);
 }
});
test("the editor's hidden-line count sits beside Time and retires with it",()=>{
 const scrolled={...model,hiddenLineCount:3};
 assert.match(renderStatusDivider(scrolled,130,paint),/↑ 3 Time 00:15\.8 ─$/);
 for(let width=0;width<=150;width++){
  const row=renderStatusDivider(scrolled,width,paint);assert.ok(visibleWidth(row)<=width);
  assert.equal(row.includes("↑ 3"),row.includes("Time "),`width ${width}: ${row}`);
 }
});
