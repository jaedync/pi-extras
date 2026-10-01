import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { ToolGroups, installToolFolding, foldSummary } from "../lib/tool-display/fold.ts";
import { readRenderers } from "../lib/tool-display/files.ts";
import { withDisplay, applyArgs } from "../lib/tool-display/index.ts";
import { DEFAULT_SETTINGS } from "../lib/tool-display/settings.ts";
import { BULLET_GLYPH } from "../lib/band/glyph.ts";
import { harness } from "./support/tool-rows.ts";
initTheme("dark");
const plain=(row:ToolExecutionComponent,width=70)=>row.render(width).map(stripTerminalSequences).filter(x=>x.trim()).map(x=>x.trimEnd());
function fixture(){
 const groups=new ToolGroups();
 const animation=harness();
 const kit=animation.kit;
 const definition=withDisplay({name:"read",parameters:{},description:"read",execute:async()=>({content:[],details:undefined})} as never,readRenderers(kit) as never);
 const make=(id:string,error=false)=>{
  const args={path:`${id}.txt`};
  const row=new ToolExecutionComponent("read",id,args,{},definition as never,{requestRender(){}} as never,"/work");
  row.setArgsComplete();row.markExecutionStarted();
  row.updateResult({content:[{type:"text",text:error?"ENOENT":"real content"}],isError:error} as never,false);
  groups.call(id,"read",args);groups.finish(id,error);
  return row;
 };
 let enabled=true,expanded=false;
 const undo=installToolFolding({enabled:()=>enabled,groups,expanded:()=>expanded});
 return{groups,make,undo,animation,setEnabled:(value:boolean)=>{enabled=value;},setExpanded:(value:boolean)=>{expanded=value;}};
}
test("successful consecutive calls fold only after the model moves on, with the shared bullet",()=>{
 const f=fixture();try{
  const a=f.make("a"),b=f.make("b");
  assert.match(plain(a)[0]!,/read a.txt/);
  assert.equal(f.animation.running(),true,"the finished row has a flash timer");
  f.groups.moveOn();
  assert.deepEqual(plain(a),[`${BULLET_GLYPH} Read 2 files`]);
  assert.deepEqual(plain(b),[]);
  assert.equal(f.animation.running(),false,"folding releases finish timers even without another native render");
  for(let width=0;width<85;width++)assert.ok(a.render(width).every(line=>visibleWidth(line)<=width));
 }finally{f.undo();}
});
test("the first row actually rendered supplies a fold line even when the original leader is absent",()=>{
 const f=fixture();try{
  f.make("omitted");const kept=f.make("kept");f.groups.moveOn();
  assert.deepEqual(plain(kept),[`${BULLET_GLYPH} Read 2 files`]);
 }finally{f.undo();}
});
test("native Pi expanded flag unfolds all and toggling it back refolds; click unfolds just one group",()=>{
 const f=fixture();try{
  const a=f.make("a"),b=f.make("b");f.groups.moveOn();
  const c=f.make("c");f.groups.moveOn();
  a.render(70);
  a.handleMouse({type:"click",button:"left",x:3,y:1,screenX:3,screenY:1,width:70,height:15} as never);
  assert.match(plain(a)[0]!,/read a.txt/);assert.match(plain(b)[0]!,/read b.txt/);
  assert.deepEqual(plain(c),[`${BULLET_GLYPH} Read 1 file`]);
  f.setExpanded(true);for(const row of [a,b,c])row.setExpanded(true);
  for(const row of [a,b,c])assert.match(plain(row).join("\n"),/real content/);
  f.setExpanded(false);for(const row of [a,b,c])row.setExpanded(false);
  assert.deepEqual(plain(a),[`${BULLET_GLYPH} Read 2 files`]);assert.deepEqual(plain(b),[]);
 }finally{f.undo();}
});
test("a row's own expanded flag never resets a clicked-open group, including repeated frames",()=>{
 const f=fixture();try{
  const a=f.make("a"),b=f.make("b");f.groups.moveOn();a.render(70);
  a.handleMouse({type:"click",button:"left",x:3,y:1,width:70,height:15} as never);
  // Pi's result-region click changes only this row, not the global ctrl+o state.
  a.setExpanded(true);
  for(let frame=0;frame<5;frame++){
   assert.match(plain(a).join("\n"),/read a.txt/);
   assert.match(plain(b).join("\n"),/read b.txt/);
  }
 }finally{f.undo();}
});
test("reused provider IDs bind each row to its own assistant message, live and replayed",()=>{
 const f=fixture();try{
  f.groups.turn();const old=f.make("call_0");f.groups.moveOn();
  assert.deepEqual(plain(old),[`${BULLET_GLYPH} Read 1 file`]);
  f.groups.turn();const recent=f.make("call_0");
  assert.match(plain(recent).join("\n"),/read call_0.txt/,"a new finished call stays visible until the model moves on");
  f.groups.moveOn();assert.deepEqual(plain(recent),[`${BULLET_GLYPH} Read 1 file`]);
  old.render(70);old.handleMouse({type:"click",button:"left",x:3,y:1,width:70,height:15} as never);
  assert.match(plain(old).join("\n"),/read call_0.txt/);
  assert.deepEqual(plain(recent),[`${BULLET_GLYPH} Read 1 file`]);
 }finally{f.undo();}
 const args1={},args2={},groups=new ToolGroups();
 groups.replay([args1,args2].flatMap(arguments_=>[
  {type:"message",message:{role:"assistant",content:[{type:"toolCall",id:"call_0",name:"read",arguments:arguments_}]}},
  {type:"message",message:{role:"toolResult",toolCallId:"call_0",isError:false}},
  {type:"message",message:{role:"assistant",content:[{type:"text",text:"done"}]}},
 ]));
 groups.unfold("call_0",args1);
 assert.equal(groups.view("call_0",false,false,args1),undefined);
 assert.equal(groups.view("call_0",false,false,args2)?.summary,"Read 1 file");
});
test("a successful codemode result with nested failures remains visible beside folded successes",()=>{
 const f=fixture();try{
  const script=f.make("script"),ok=f.make("ok");
  f.groups.finish("script",false,{calls:[{id:"script/1",name:"bash",status:"error"}],complete:true});
  f.groups.moveOn();
  assert.match(plain(script).join("\n"),/read script.txt/,"the failed nested call's parent row stays visible even as leader");
  assert.match(plain(script).join("\n"),/Read 1 file/);
  assert.deepEqual(plain(ok),[]);
 }finally{f.undo();}
 const groups=new ToolGroups();
 groups.replay([
  {type:"message",message:{role:"assistant",content:[{type:"toolCall",id:"ok",name:"read"},{type:"toolCall",id:"code",name:"codemode"}]}},
  {type:"message",message:{role:"toolResult",toolCallId:"ok",isError:false}},
  {type:"message",message:{role:"toolResult",toolCallId:"code",isError:false,nestedCalls:{calls:[{name:"bash",status:"error"}],complete:true}}},
 ]);
 assert.equal(groups.view("code",false)?.hidden,false);
 assert.equal(groups.view("ok",false)?.summary,"Read 1 file");
});
test("failed rows remain below the fold line, and running or unfinished groups never disappear",()=>{
 const f=fixture();try{
  const bad=f.make("bad",true),ok=f.make("ok");f.groups.moveOn();
  assert.match(plain(bad)[0]!,/Read 1 file/);
  assert.match(plain(bad).join("\n"),/ENOENT/);
  assert.deepEqual(plain(ok),[]);
  const pending=f.make("pending");f.groups.call("running","bash");f.groups.moveOn();
  assert.match(plain(pending)[0]!,/read pending.txt/);
 }finally{f.undo();}
});
test("a failed fold leader forwards output clicks at the original row offset",()=>{
 const groups=new ToolGroups();groups.call("bad","bash");groups.finish("bad",true);groups.call("ok","read");groups.finish("ok",false);groups.moveOn();
 let forwarded:unknown;
 const target={render:()=>["","failed header","error output"],handleMouse:(event:unknown)=>{forwarded=event;return {handled:true};}};
 const row=Object.assign(Object.create(target),{toolCallId:"bad",isPartial:false,result:{isError:true}});
 const undo=installToolFolding({enabled:()=>true,groups},target);
 try{
  assert.deepEqual(row.render(70),["",`${BULLET_GLYPH} Read 1 file`,"failed header","error output"]);
  const event={type:"click",button:"left",x:3,y:3,screenY:12,width:70,height:4};
  row.handleMouse(event);
  assert.deepEqual(forwarded,{...event,y:2});assert.equal(event.y,3);
 }finally{undo();}
});
test("fold off restores every row; replay uses only rendering metadata and preserves unfinished calls",()=>{
 const f=fixture();try{
  const a=f.make("a"),b=f.make("b");f.groups.moveOn();
  f.setEnabled(false);
  assert.match(plain(a)[0]!,/read a.txt/);assert.match(plain(b)[0]!,/read b.txt/);
  f.setEnabled(true);assert.deepEqual(plain(a),[`${BULLET_GLYPH} Read 2 files`]);assert.deepEqual(plain(b),[]);
 }finally{f.undo();}
 const history=[{type:"message",message:{role:"assistant",content:[{type:"toolCall",id:"r",name:"read"},{type:"toolCall",id:"bad",name:"bash"}]}},{type:"message",message:{role:"toolResult",toolCallId:"bad",isError:true}},{type:"custom",customType:"mail",data:"mail stays visible"},{type:"message",message:{role:"toolResult",toolCallId:"r",isError:false}},{type:"message",message:{role:"assistant",content:[{type:"text",text:"answer"}]}}];
 const original=structuredClone(history),groups=new ToolGroups();
 groups.replay(history);assert.deepEqual(history,original);
 assert.equal(groups.view("r",false)?.summary,"Read 1 file");assert.equal(groups.view("bad",false)?.hidden,false);
 groups.replay([history[0]]);assert.equal(groups.view("r",false),undefined);
 assert.equal(foldSummary(["constructor"]),"Called 1 constructor");
});
test("subagent, message and mesh mail rows are excluded and split groups; summaries phrase known tools",()=>{
 const groups=new ToolGroups();
 for(const [id,name] of [["r1","read"],["mail","message"],["r2","read"],["agent","subagent"],["mesh","agent_send"]]){groups.call(id!,name!);groups.finish(id!,false);}
 groups.moveOn();
 assert.equal(groups.view("mail",false),undefined);assert.equal(groups.view("agent",false),undefined);assert.equal(groups.view("mesh",false),undefined);
 assert.equal(groups.view("r1",false)?.summary,"Read 1 file");assert.equal(groups.view("r2",false)?.summary,"Read 1 file");
 assert.equal(foldSummary(["read","read","bash","bash","bash","edit","odd_tool"]),"Read 2 files, ran 3 shell commands, edited 1 file, called 1 odd_tool");
 assert.deepEqual(applyArgs(DEFAULT_SETTINGS,"fold off"),{...DEFAULT_SETTINGS,fold:false});
 assert.deepEqual(applyArgs(DEFAULT_SETTINGS,"fold on"),{...DEFAULT_SETTINGS,fold:true});
});
