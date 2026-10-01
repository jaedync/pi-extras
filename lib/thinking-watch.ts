/** Timing is UI metadata, never a replacement or addition to assistant content. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
export const THINKING_TIMING_ENTRY = "pi-extras.thinking-times";
interface Timing { readonly timestamp: number; readonly durations: readonly number[] }
interface Message { timestamp?: number; content?: readonly {type:string}[] }
export function watchThinking(pi: ExtensionAPI, now = Date.now): (message: Message, run: number) => number | undefined {
 let timings = new Map<number,readonly number[]>();
 let pending = new Map<number,readonly number[]>();
 const flush = (ctx: ExtensionContext) => {
  const ready=pending;pending=new Map();
  if(ctx.mode==="tui")for(const [timestamp,durations] of ready)pi.appendEntry(THINKING_TIMING_ENTRY,{timestamp,durations});
 };
 let active: {timestamp:number;run:number;startedAt:number} | undefined;
 const finish = () => {
  if(!active) return;
  const durations=[...(timings.get(active.timestamp) ?? [])];
  durations[active.run]=Math.max(0,now()-active.startedAt);
  timings=new Map(timings).set(active.timestamp,durations);
  active=undefined;
 };
 pi.on("session_start",(_event,ctx)=>{
  active=undefined;timings=new Map();pending=new Map();
  for(const entry of ctx.sessionManager?.getBranch?.() ?? []) {
   if(entry.type!=="custom" || entry.customType!==THINKING_TIMING_ENTRY) continue;
   const data=entry.data as Timing | undefined;
   if(typeof data?.timestamp==="number" && Array.isArray(data.durations) && data.durations.every(ms=>Number.isFinite(ms)&&ms>=0)) timings.set(data.timestamp,[...data.durations]);
  }
 });
 pi.on("message_update",event=>{
  const stream=event.assistantMessageEvent;
  const message=event.message as Message;
  if(typeof message.timestamp!=="number") return;
  if(stream.type.startsWith("thinking_") && stream.type!=="thinking_end") {
   if(!active) {
    const at="contentIndex" in stream ? stream.contentIndex : (message.content?.length ?? 1)-1;
    let run=-1,thinking=false;
    for(const part of message.content?.slice(0,at+1) ?? []) {
     if(part.type==="thinking" && !thinking) run++;
     thinking=part.type==="thinking";
    }
    active={timestamp:message.timestamp,run:Math.max(0,run),startedAt:now()};
   }
  } else if(stream.type==="thinking_end" || stream.type.startsWith("text_") || stream.type.startsWith("toolcall_")) finish();
 });
 pi.on("message_end",(event,ctx)=>{
  if(event.message.role!=="assistant") return;
  finish();
  const timestamp=event.message.timestamp;
  const durations=timings.get(timestamp);
  // message_end extensions run before Pi appends the assistant message.
  if(durations && ctx.mode==="tui") pending=new Map(pending).set(timestamp,[...durations]);
 });
 pi.on("turn_end",(_event,ctx)=>flush(ctx));
 pi.on("agent_end",(_event,ctx)=>{finish();flush(ctx);});
 return (message,run)=>typeof message.timestamp==="number" ? timings.get(message.timestamp)?.[run] : undefined;
}
