/** Folding changes only pixels. Pi still owns every call, result and expanded flag. */
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { BULLET_GLYPH } from "../band/glyph.ts";
import { sanitize } from "./format.ts";
import { readCalls } from "./nested.ts";

interface Call { readonly id: string; readonly name: string; readonly done: boolean; readonly error: boolean }
interface Group { readonly ids: readonly string[]; readonly closed: boolean; readonly unfolded: boolean; readonly pending: number; readonly summary?: string }
export interface FoldView { readonly leader: boolean; readonly hidden: boolean; readonly keepVisible: boolean; readonly summary: string }
const excluded = (name: string) => /subagent|message|mail|mesh|agent_(?:send|request)/i.test(name);
const phrases: Readonly<Record<string,readonly [string,string,string]>> = {
 read:["read","file","files"],bash:["ran","shell command","shell commands"],edit:["edited","file","files"],write:["wrote","file","files"],
 grep:["searched","pattern","patterns"],find:["found","file listing","file listings"],ls:["listed","directory","directories"],
};
export function foldSummary(names: readonly string[]): string {
 const counts=new Map<string,number>();
 for(const name of names)counts.set(name,(counts.get(name) ?? 0)+1);
 const parts=[...counts].map(([name,count])=>{
  const phrase=Object.hasOwn(phrases,name) ? phrases[name] : undefined;
  return phrase ? `${phrase[0]} ${count} ${phrase[count===1?1:2]}` : `called ${count} ${sanitize(name).replace(/\s+/g," ")}`;
 });
 const text=parts.join(", ");
 return text ? text[0]!.toUpperCase()+text.slice(1) : "";
}

/** Groups follow message order rather than execution completion order (parallel calls can finish backwards). */
export class ToolGroups {
 private calls=new Map<string,Call>();
 private groups: readonly Group[]=[];
 private current: number | undefined;
 private membership=new Map<string,number>();
 private leaders=new Map<number,string>();
 private expanded=false;
 private turnId=0;
 private latest=new Map<string,string>();
 private arguments=new WeakMap<object,string>();
 reset():void {this.calls=new Map();this.groups=[];this.current=undefined;this.membership=new Map();this.leaders=new Map();this.expanded=false;this.turnId=0;this.latest=new Map();this.arguments=new WeakMap();}
 turn():void {this.turnId++;}
 private key(id:string,args?:unknown):string | undefined {
  return args && typeof args==="object" ? this.arguments.get(args) ?? this.latest.get(id) : this.latest.get(id);
 }
 call(id:string,name:string,args?:unknown):void {
  const key=`${this.turnId}:${id}`;
  this.latest.set(id,key);
  // Pi passes the assistant call's argument object to the row on live completion and replay.
  if(args && typeof args==="object")this.arguments.set(args,key);
  id=key;
  if(this.calls.has(id))return;
  this.calls=new Map(this.calls).set(id,{id,name,done:false,error:false});
  if(excluded(name)){this.current=undefined;return;}
  if(this.current===undefined){this.current=this.groups.length;this.groups=[...this.groups,{ids:[],closed:false,unfolded:false,pending:0}];}
  const at=this.current;
  this.membership=new Map(this.membership).set(id,at);
  this.groups=this.groups.map((group,index)=>index===at?{...group,ids:[...group.ids,id],pending:group.pending+1,summary:undefined}:group);
 }
 finish(id:string,error:boolean,nestedCalls?:unknown):void {
  const nested=readCalls(nestedCalls);
  error=error || !!nested && (!nested.complete || nested.calls.some(call=>call.status!=="ok"));
  id=this.latest.get(id) ?? id;
  const call=this.calls.get(id);
  if(!call || (call.done && call.error===error))return;
  this.calls=new Map(this.calls).set(id,{...call,done:true,error});
  const at=this.membership.get(id);
  if(at!==undefined)this.groups=this.groups.map((group,index)=>index===at?{...group,pending:group.pending-(call.done?0:1),summary:undefined}:group);
 }
 boundary():void {this.current=undefined;}
 moveOn():void {
  this.groups=this.groups.map(group=>group.closed ? group : {...group,closed:true});
  this.current=undefined;
 }
 replay(entries:readonly unknown[]):void {
  this.reset();
  for(const value of entries){
   if(!value || typeof value!=="object")continue;
   const entry=value as {type?:string;message?:{role?:string;content?:unknown;toolCallId?:string;isError?:boolean;nestedCalls?:unknown;details?:unknown}};
   if(entry.type==="custom_message"){this.boundary();continue;}
   if(entry.type!=="message" || !entry.message)continue;
   const message=entry.message;
   if(message.role==="user")this.moveOn();
   if(message.role==="toolResult" && typeof message.toolCallId==="string")this.finish(message.toolCallId,message.isError===true,message.nestedCalls ?? message.details);
   if(message.role!=="assistant" || !Array.isArray(message.content))continue;
   this.turn();
   for(const part of message.content){
    if(part?.type==="text" && typeof part.text==="string" && part.text.trim())this.moveOn();
    if(part?.type==="toolCall" && typeof part.id==="string" && typeof part.name==="string")this.call(part.id,part.name,part.arguments);
   }
  }
  this.moveOn();
 }
 view(id:string,expanded:boolean,rendered=false,args?:unknown):FoldView | undefined {
  const key=this.key(id,args);
  if(key===undefined)return undefined;
  id=key;
  const at=this.membership.get(id);
  if(at===undefined)return undefined;
  const group=this.groups[at];
  if(!group)return undefined;
  if(this.expanded!==expanded){
   this.expanded=expanded;
   this.groups=this.groups.map(item=>item.unfolded?{...item,unfolded:false}:item);
  }
  const current=this.groups[at]!;
  if(expanded || current.unfolded || !current.closed || current.pending>0)return undefined;
  const summary=current.summary ?? foldSummary(current.ids.map(key=>this.calls.get(key)!).filter(call=>!call.error).map(call=>call.name));
  if(current.summary===undefined)this.groups=this.groups.map((item,index)=>index===at?{...item,summary}:item);
  if(!summary)return undefined;
  // A rebuilt or partially retained transcript need not include the original first call.
  if(rendered && !this.leaders.has(at))this.leaders.set(at,id);
  const leader=(this.leaders.get(at) ?? current.ids[0])===id;
  const keepVisible=this.calls.get(id)?.error===true;
  return{leader,hidden:!leader&&!keepVisible,keepVisible,summary};
 }
 unfold(id:string,args?:unknown):void {
  const key=this.key(id,args);
  const at=key===undefined ? undefined : this.membership.get(key);
  this.groups=this.groups.map((group,index)=>index===at?{...group,unfolded:true}:group);
 }
}

interface Row {
 toolCallId:string; args?:unknown; expanded:boolean; isPartial:boolean; result?:{isError?:boolean};
 ui?:{requestRender():void};
 rendererState?:{row?:{stopFrames?:()=>void}};
}
interface Host {enabled():boolean; expanded?():boolean; readonly groups:ToolGroups; theme?():{fg(key:string,text:string):string} | undefined}
interface Slot {
 host:Host | undefined;
 readonly render:(this:Row,width:number)=>string[];
 readonly mouse:(this:Row,event:TuiMouseEvent)=>TuiMouseEventResult | undefined;
 readonly drawn:WeakMap<object,FoldView>;
}
const SLOT=Symbol.for("pi-extras.tool-fold.v1");
function slotOf(target:object):Slot | undefined {
 const proto=target as Record<symbol,Slot | undefined> & {render:Slot["render"];handleMouse:Slot["mouse"]};
 if(proto[SLOT])return proto[SLOT];
 if(typeof proto.render!=="function" || typeof proto.handleMouse!=="function")return undefined;
 const slot:Slot={host:undefined,render:proto.render,mouse:proto.handleMouse,drawn:new WeakMap()};
 proto[SLOT]=slot;
 proto.render=function(width){
  slot.drawn.delete(this);
  if(width<=0)return [];
  const host=slot.host;
  const view=host?.enabled() && this.isPartial===false ? host.groups.view(this.toolCallId,host.expanded?.() ?? false,true,this.args) : undefined;
  if(!view)return slot.render.call(this,width);
  slot.drawn.set(this,view);
  if (!view.keepVisible) {
   // Hidden successful rows cannot render again to retire their finish-flash timer.
   this.rendererState?.row?.stopFrames?.();
   if(this.rendererState?.row)this.rendererState.row.stopFrames=undefined;
  }
  if(view.hidden)return this.result?.isError ? slot.render.call(this,width) : [];
  if(!view.leader)return slot.render.call(this,width);
  const summary=truncateToWidth(`${BULLET_GLYPH} ${view.summary}`,width,"");
  // Reuse Pi's live theme through the row's renderer; the fold line itself has no panel.
  const painted=host?.theme?.()?.fg("dim",summary) ?? summary;
  return ["",painted,...(view.keepVisible ? slot.render.call(this,width).slice(1) : [])];
 };
 proto.handleMouse=function(event){
  const view=slot.drawn.get(this);
  if(view?.leader && event.type==="click" && event.button==="left" && event.y===1){
   slot.host?.groups.unfold(this.toolCallId,this.args);
   this.ui?.requestRender();
   return{handled:true};
  }
  // A failed leader prepends one line before Pi's header and error output.
  const forwarded=view?.leader && view.keepVisible && event.y>1 ? {...event,y:event.y-1} : event;
  return slot.mouse.call(this,forwarded);
 };
 return slot;
}
export function prepareToolFolding(target:object=ToolExecutionComponent.prototype):void {slotOf(target);}
export function installToolFolding(host:Host,target:object=ToolExecutionComponent.prototype):()=>void {
 const slot=slotOf(target);
 if(!slot)return()=>undefined;
 slot.host=host;
 return()=>{if(slot.host===host)slot.host=undefined;};
}
