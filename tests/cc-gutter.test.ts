import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { renderBand, ROW_MARGIN } from "../lib/band/band.ts";
import { BULLET_GLYPH, THOUGHT_GLYPH } from "../lib/band/glyph.ts";
import { BODY_INDENT } from "../lib/tool-display/row.ts";
import { assistantText, installThinkingTail } from "../lib/tool-display/thinking.ts";
initTheme("dark");
test("thinking marks share the bullet column, while abort/error text shares the text column",()=>{
 const undo=installThinkingTail({mode:()=>"tail",hiddenAtStart:()=>true,theme:()=>undefined,gutter:()=>true,summary:()=>`${THOUGHT_GLYPH} Thought for 1s`});
 try{
  const thought=new AssistantMessageComponent({role:"assistant",content:[{type:"thinking",thinking:"private"}],stopReason:"stop"} as never,true);
  assert.equal(thought.render(80).map(stripTerminalSequences).find(line=>line.includes("Thought")),`${THOUGHT_GLYPH} Thought for 1s`);
  for(const stopReason of ["aborted","error"]){
   const reply=new AssistantMessageComponent({role:"assistant",content:[],stopReason,errorMessage:"fixture failure"} as never,true);
   const row=reply.render(80).map(stripTerminalSequences).find(line=>line.includes("fixture failure"));
   assert.ok(row?.startsWith("  "));assert.ok(!row?.startsWith("   "));
  }
 }finally{undo();}
});
test("a 2000-message transcript does no additional gutter formatting per unchanged frame",()=>{
 let paints=0;
 const inputs=Array.from({length:2000},(_,i)=>[`message ${i}`]);
 const host={mode:()=>"tail" as const,hiddenAtStart:()=>false,theme:()=>paint};
 const paint={fg:(_key:string,text:string)=>{paints++;return text;}};
 const wrappers=inputs.map((_,i)=>assistantText({render:()=>inputs[i]!,invalidate(){}},true,host));
 const initial=wrappers.map(row=>row.render(80));assert.equal(paints,2000);
 for(let frame=0;frame<20;frame++)wrappers.forEach((row,i)=>assert.equal(row.render(80),initial[i]));
 assert.equal(paints,2000);
 inputs[0]=["changed"];
 wrappers.forEach(row=>row.render(80));assert.equal(paints,2001);
 wrappers[0]!.render(40);assert.equal(paints,2002);
});
const theme={fg:(_key:string,text:string)=>text,bg:(_key:string,text:string)=>text,getFgAnsi:()=>"",getBgAnsi:()=>"",getColorMode:()=>"truecolor" as const};
const band=(clockMs:number,kind:"running"|"writing"|"queued"|"done"="running",motion:"full"|"reduced"="full",toolName="read")=>stripTerminalSequences(renderBand(theme,undefined,{width:50,phase:kind==="running"?{kind,elapsedMs:clockMs,timeoutMs:toolName==="bash"?2000:undefined}:kind==="done"?{kind,outcome:"ok",sinceMs:1000}:{kind},segs:[{text:"header",color:"text"}],rail:[],clockMs,motion,margin:true,toolName}));
test("unknown tool kinds stay still even if their title looks like a peer",()=>{
 const line=stripTerminalSequences(renderBand(theme,undefined,{width:30,phase:{kind:"running",elapsedMs:0},segs:[{text:"subagent",color:"text"}],rail:[],clockMs:0,margin:true}));
 assert.ok(line.startsWith(`${BULLET_GLYPH} subagent`));
});
test("one gutter aligns all rows, with still file markers and timed shell fill",()=>{
 assert.equal(ROW_MARGIN,2);
 assert.equal(BODY_INDENT,ROW_MARGIN+2);
 assert.ok(band(0).startsWith(`${BULLET_GLYPH} header`));
 assert.ok(band(500).startsWith(`${BULLET_GLYPH} header`));
 assert.ok(band(500,"running","full","bash").startsWith("◔ header"));
 assert.ok(band(1000).startsWith(`${BULLET_GLYPH} header`));
 for(const kind of ["writing","queued","done"] as const)assert.ok(band(500,kind).startsWith(`${BULLET_GLYPH} header`));
 assert.ok(band(500,"running","reduced").startsWith(`${BULLET_GLYPH} header`));
 const undo=installThinkingTail({mode:()=>"tail",hiddenAtStart:()=>false,theme:()=>undefined,gutter:()=>true});
 try{
  const message={role:"assistant",content:[{type:"text",text:"header\n\nA paragraph that wraps across multiple lines, with π and 界."}],stopReason:"stop"} as never;
  const component=new AssistantMessageComponent(message,false);
  const lines=component.render(25).map(stripTerminalSequences).filter(x=>x.trim());
  assert.equal(lines[0]?.slice(0,8),`${BULLET_GLYPH} header`);
  assert.ok(lines.slice(1).every(line=>line.startsWith("  ")));
  for(let width=0;width<85;width++)assert.ok(component.render(width).every(line=>visibleWidth(line)<=width),`${width}`);
 }finally{undo();}
});
