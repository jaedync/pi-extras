import assert from "node:assert/strict";
import test from "node:test";
import { watchThinking, THINKING_TIMING_ENTRY } from "../lib/thinking-watch.ts";
test("thinking times are measured per run and persisted as non-context metadata",()=>{
 let now=0;
 const handlers=new Map<string,Function>();
 const saved:Array<[string,unknown]>=[];
 const duration=watchThinking({on:(name:string,fn:Function)=>handlers.set(name,fn),appendEntry:(name:string,data:unknown)=>saved.push([name,data])} as never,()=>now);
 const ctx={mode:"tui",sessionManager:{getBranch:()=>[]}};
 handlers.get("session_start")!({},ctx);
 const message={role:"assistant",timestamp:123,content:[{type:"thinking",thinking:"real thinking"}]};
 const update=(type:string,at:number)=>{now=at;handlers.get("message_update")!({message,assistantMessageEvent:{type,contentIndex:0}},ctx);};
 update("thinking_start",1000);update("thinking_delta",6000);update("thinking_end",13000);
 assert.equal(duration(message,0),12000);
 handlers.get("message_end")!({message},ctx);
 assert.deepEqual(saved,[],"message_end runs before Pi persists the assistant message");
 handlers.get("turn_end")!({},ctx);
 assert.deepEqual(saved,[[THINKING_TIMING_ENTRY,{timestamp:123,durations:[12000]}]]);
 assert.deepEqual(message.content,[{type:"thinking",thinking:"real thinking"}],"the assistant message was never rewritten");
 handlers.get("session_start")!({}, {sessionManager:{getBranch:()=>[{type:"custom",customType:THINKING_TIMING_ENTRY,data:saved[0]![1]}]}});
 assert.equal(duration(message,0),12000,"a resume restores the same label timing");
});
test("a run still going gives its time so far only when asked",()=>{
 let now=0;
 const handlers=new Map<string,Function>();
 const duration=watchThinking({on:(name:string,fn:Function)=>handlers.set(name,fn),appendEntry:()=>{}} as never,()=>now);
 const ctx={mode:"tui",sessionManager:{getBranch:()=>[]}};
 handlers.get("session_start")!({},ctx);
 const done={role:"assistant",timestamp:123,content:[{type:"thinking",thinking:"first"}]};
 const going={role:"assistant",timestamp:456,content:[{type:"thinking",thinking:"more"}]};
 const update=(message:object,type:string,at:number)=>{now=at;handlers.get("message_update")!({message,assistantMessageEvent:{type,contentIndex:0}},ctx);};
 update(done,"thinking_start",1000);update(done,"thinking_end",3000);
 update(going,"thinking_start",20000);
 now=21500;
 assert.equal(duration(going,0),undefined,"a label waits for the run's end");
 assert.equal(duration(going,0,true),1500);
 assert.equal(duration(done,0,true),2000,"a finished run keeps its time");
 assert.equal(duration(going,1,true),undefined,"another run of the same reply has none yet");
});

type Part={type:string;thinking?:string;text?:string};

function watched() {
 let now=0;
 const handlers=new Map<string,Function>();
 const saved:Array<[string,unknown]>=[];
 const duration=watchThinking({on:(name:string,fn:Function)=>handlers.set(name,fn),appendEntry:(name:string,data:unknown)=>saved.push([name,data])} as never,()=>now);
 const ctx={mode:"tui",sessionManager:{getBranch:()=>[]}};
 handlers.get("session_start")!({},ctx);
 const update=(message:{content:Part[]},type:string,contentIndex:number,at:number)=>{now=at;handlers.get("message_update")!({message,assistantMessageEvent:{type,contentIndex}},ctx);};
 const end=(message:object)=>{handlers.get("message_end")!({message},ctx);handlers.get("turn_end")!({},ctx);};
 return {duration,update,end,saved,at:(at:number)=>{now=at;}};
}

test("a run of several thinking blocks is timed from its first block's start to its last block's end",()=>{
 const w=watched();
 // Anthropic's summarized thinking can send one run as several blocks.
 const message={role:"assistant",timestamp:123,content:[{type:"thinking",thinking:"first part"}] as Part[]};
 w.update(message,"thinking_start",0,1000);w.update(message,"thinking_end",0,4000);
 message.content=[...message.content,{type:"thinking",thinking:"second part"}];
 w.update(message,"thinking_start",1,4200);
 w.at(5000);
 assert.equal(w.duration(message,0,true),4000,"the live time goes on; it does not start again at 0");
 w.update(message,"thinking_end",1,7000);
 assert.equal(w.duration(message,0),6000);
 w.end(message);
 assert.deepEqual(w.saved,[[THINKING_TIMING_ENTRY,{timestamp:123,durations:[6000]}]],"saved in the same form");
});

test("thinking, words, then thinking again are two runs with a time each",()=>{
 const w=watched();
 const message={role:"assistant",timestamp:123,content:[{type:"thinking",thinking:"first"}] as Part[]};
 w.update(message,"thinking_start",0,1000);w.update(message,"thinking_end",0,3000);
 message.content=[...message.content,{type:"text",text:"Let me look."}];
 w.update(message,"text_start",1,3100);w.update(message,"text_end",1,3500);
 message.content=[...message.content,{type:"thinking",thinking:"second"}];
 w.update(message,"thinking_start",2,4000);
 w.at(4500);
 assert.equal(w.duration(message,1,true),500,"the second run starts at its own start");
 w.update(message,"thinking_end",2,9000);
 assert.deepEqual([w.duration(message,0),w.duration(message,1)],[2000,5000]);
});
