import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { installThinkingTail, renderThinkingTail, tailLines, thoughtLabel, type ThinkingHost } from "../lib/tool-display/thinking.ts";
import { GLOW_MS, noteText } from "../lib/band/glow.ts";
initTheme("dark");
const text="First thought.\n\nSecond thought.\n\nLast thought.";
const msg=(answer=false)=>({role:"assistant",content:[{type:"thinking",thinking:text},...(answer?[{type:"text",text:"Answer."}]:[])],stopReason:"stop"}) as never;
const plain=(component:AssistantMessageComponent,width=60)=>component.render(width).map(stripTerminalSequences).map(x=>x.trim());
const finishedRows=["","∴ Thought for 12s","","Answer."];
const host:ThinkingHost={mode:()=>"tail",hiddenAtStart:()=>true,theme:()=>undefined,summary:()=>"∴ Thought for 12s"};
test("live thinking is absent from the transcript; finished thinking is display-only summary",()=>{
 const undo=installThinkingTail(host);
 try {
  const component=new AssistantMessageComponent(undefined,true);
  component.updateContent(msg(),true);
  assert.deepEqual(plain(component),[]);
  component.updateContent(msg(true),true);
  assert.deepEqual(plain(component),finishedRows);
  component.updateContent(msg(true),false);
  component.setHideThinkingBlock(false);
  assert.ok(plain(component).includes("First thought."));
  component.setHideThinkingBlock(true);
  assert.deepEqual(plain(component),finishedRows);
  component.updateContent(msg(),true);
  assert.deepEqual(plain(component),[],"hiding live thinking must not reserve its leading spacer");
  component.updateContent(msg(),false);
  assert.deepEqual(plain(component),["","∴ Thought for 12s"],"finished thinking restores normal message spacing");
 }finally{undo();}
});
test("a summary click expands only its thinking, while full mode still hides live thinking",()=>{
 let mode:"tail"|"full"="tail";
 const undo=installThinkingTail({...host,mode:()=>mode});
 try{
  const component=new AssistantMessageComponent(msg(true),true);
  component.render(60);
  component.handleMouse({type:"click",button:"left",x:2,y:1,screenX:2,screenY:1,width:60,height:20} as never);
  assert.ok(plain(component).includes("Last thought."));
  mode="full";
  const live=new AssistantMessageComponent(undefined,true);
  live.updateContent(msg(),true);
  assert.deepEqual(plain(live),[]);
  const finished=new AssistantMessageComponent(msg(true),true);
  assert.ok(plain(finished).includes("First thought."));
  finished.setHideThinkingBlock(false);
  assert.deepEqual(plain(finished),finishedRows);
 }finally{undo();}
});
test("the dim italic live tail keeps newest three wrapped lines and every row fits",()=>{
 const theme={fg:(_key:string,text:string)=>text,italic:(text:string)=>text};
 for(let width=0;width<85;width++){
  const lines=renderThinkingTail("thought ".repeat(80)+"newest",width,theme);
  assert.ok(lines.length<=3);
  assert.ok(lines.every(line=>visibleWidth(line)<=width),`${width}: ${lines}`);
 }
 const unsafe=renderThinkingTail("safe\x1b[2J\x1b]0;injected\x07 next",40,theme).join("\n");
 assert.ok(!unsafe.includes("\x1b"),"streamed model thinking cannot inject terminal controls");
 const lines=renderThinkingTail("thought ".repeat(80)+"newest",40,theme);
 assert.ok(lines[0]?.trimStart().startsWith("… "));
 assert.ok(lines.at(-1)?.endsWith("newest"));
});

test("new thinking shows brighter for a moment, then fades to the tail's dim",()=>{
 const theme={fg:(key:string,text:string)=>`<${key}>${text}`,italic:(text:string)=>text,
  getFgAnsi:(key:string)=>key==="text"?"\x1b[38;2;240;240;240m":"\x1b[38;2;100;100;100m",getColorMode:()=>"truecolor" as const};
 const old="thought ".repeat(3), now=old+"newest";
 const trail=noteText(noteText(undefined,"thinking",old.length,0),"thinking",now.length,1000);
 const lit=renderThinkingTail(now,60,theme,{trail,now:1000}).join("");
 assert.match(lit,/\x1b\[38;2;240;240;240mnewest\x1b\[39m/,"the six new characters, at full brightness");
 assert.ok(lit.includes("<dim>thought"),"the old ones keep the dim");
 assert.equal(tailLines(now,58),tailLines(now,58),"each glowing frame reuses the wrapped tail");
 const faded=renderThinkingTail(now,60,theme,{trail,now:1000+GLOW_MS});
 assert.deepEqual(faded,renderThinkingTail(now,60,theme),"faded: the same as without a glow");
});

test("the label keeps tenths below a second, so a fast model never thought for 0s",()=>{
 assert.equal(thoughtLabel(undefined),"∴ Thought");
 assert.equal(thoughtLabel(430),"∴ Thought for 0.4s");
 assert.equal(thoughtLabel(30),"∴ Thought for 0.1s");
 assert.equal(thoughtLabel(12_300),"∴ Thought for 12s");
});
test("a reply that folded mode expands shows its thinking in full, and a click folds it to the label",()=>{
 const undo=installThinkingTail({...host,expands:()=>true});
 try{
  const component=new AssistantMessageComponent(msg(true),true);
  assert.ok(plain(component).includes("Last thought."));
  component.handleMouse({type:"click",button:"left",x:2,y:1,screenX:2,screenY:1,width:60,height:20} as never);
  assert.deepEqual(plain(component),finishedRows);
 }finally{undo();}
});
