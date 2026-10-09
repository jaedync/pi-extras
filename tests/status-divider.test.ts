import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { DEFAULT_VERBS, renderRunStatus, type RunLine } from "../lib/cc-phase.ts";
import { renderStatusDivider } from "../lib/status-divider.ts";
const paint={border:(s:string)=>s,total:(s:string)=>s};
const model={status:"⢎⡱⣉ Thinking… 00:12.4 ↓ 212 tokens",withoutTokens:"⢎⡱⣉ Thinking… 00:12.4",elapsedMs:15800,metrics:{ttftMinMs:700,ttftMaxMs:700,throughput:{outputTokens:1093,requestMs:10000}}};
test("divider prioritizes the step clock, dropping TPS, TTFT, tokens, then Time without wrapping",()=>{
 const full=renderStatusDivider(model,130,paint);assert.match(full,/Thinking… 00:12.4 ↓ 212 tokens/);assert.match(full,/TPS 109.3/);assert.match(full,/TTFT 0.7s/);assert.match(full,/Time 00:15.8/);
 for(let width=0;width<=150;width++){
  const row=renderStatusDivider(model,width,paint);assert.ok(visibleWidth(row)<=width);assert.ok(!row.includes("\n"));
  assert.ok((row.match(/Time /g)??[]).length<=1);
  if(row.includes("TPS"))assert.ok(row.includes("TTFT"));
  if(row.includes("TTFT"))assert.ok(row.includes("tokens"));
  if(!row.includes("tokens")&&width>=30)assert.match(row,/Thinking… 00:12\.4/);
  if(row.includes("Time "))assert.match(row,/00:12\.4/);
  if(row.includes("tokens"))assert.ok(row.includes("Time "));
  if(width>=30)assert.match(row,/00:12\.4/);
 }
});
test("long tool names and playful details retire before the step clock",()=>{
 const theme={fg:(_key:string,text:string)=>text};
 for(const phase of ["tool","run"] as const)for(const verb of [undefined,DEFAULT_VERBS[0]]){
  const run:RunLine={verb,phase,pendingTool:"mcp_"+"x".repeat(56),tools:["mcp_"+"x".repeat(56)],elapsedMs:5000,phaseMs:1200,tokens:12,clockMs:0,reduced:true};
  const status={status:renderRunStatus(run,theme),withoutTokens:renderRunStatus(run,theme,false),compactStatus:renderRunStatus(run,theme,false,true),elapsedMs:5000};
  const minimum=visibleWidth(`─ ⣏⠀⣹ ${verb?"Proofing":phase==="tool"?"Writing":"Running"}… 00:01.2`);
  for(let width=20;width<=150;width++){
   const row=renderStatusDivider(status,width,paint);
   assert.ok(visibleWidth(row)<=width);assert.ok(!row.includes("\n"));
   if(width>=minimum)assert.match(row,/00:01\.2/,`width ${width}: ${row}`);
  }
 }
});
test("the step clock stays when the total timer and its hidden-line count retire",()=>{
 const row=renderStatusDivider({...model,hiddenLineCount:3},30,paint);
 assert.match(row,/Thinking… 00:12\.4/);assert.doesNotMatch(row,/TPS|TTFT|tokens|Time|↑ 3/);
});
test("the editor's hidden-line count sits beside Time and retires with it",()=>{
 const scrolled={...model,hiddenLineCount:3};
 assert.match(renderStatusDivider(scrolled,130,paint),/↑ 3 Time 00:15\.8 ─$/);
 for(let width=0;width<=150;width++){
  const row=renderStatusDivider(scrolled,width,paint);assert.ok(visibleWidth(row)<=width);
  assert.equal(row.includes("↑ 3"),row.includes("Time "),`width ${width}: ${row}`);
 }
});
test("an idle status without a prompt total still shows the hidden-line count",()=>{
 const idle={status:"⢎⡱⣉ Compacting context 00:01.5",withoutTokens:"⢎⡱⣉ Compacting context 00:01.5",hiddenLineCount:3};
 const row=renderStatusDivider(idle,130,paint);
 assert.match(row,/↑ 3 ─$/);assert.doesNotMatch(row,/Time /);
 assert.doesNotMatch(renderStatusDivider({...idle,hiddenLineCount:0},130,paint),/↑|Time /);
});
test("a live rate replaces the average and keeps one width, so the rail does not jump",()=>{
 const fast=renderStatusDivider({...model,liveTps:150.04},130,paint),slow=renderStatusDivider({...model,liveTps:9.5},130,paint);
 assert.match(fast,/TPS 150\.0 ─ TTFT/);assert.doesNotMatch(fast,/109\.3/);
 assert.match(slow,/TPS {3}9\.5 ─ TTFT/);
 assert.equal(slow.indexOf("TPS"),fast.indexOf("TPS"));
 assert.match(renderStatusDivider({...model,metrics:undefined,liveTps:80},130,paint),/TPS {2}80\.0 ─ Time/);
 assert.match(renderStatusDivider(model,130,paint),/TPS 109\.3/);
});
