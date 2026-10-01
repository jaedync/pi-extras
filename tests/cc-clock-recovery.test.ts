import assert from "node:assert/strict";
import test from "node:test";
import { everyFrame } from "../lib/band/clock.ts";
import { MODE_SPINNERS, spinnerCadence } from "../lib/band/glyph.ts";
test("a transient frame error retains its owner and never writes into the TUI",t=>{
 t.mock.timers.enable({apis:["setInterval"]});const errors=t.mock.method(console,"error",()=>{});
 let calls=0;const off=everyFrame(()=>{if(++calls===1)throw new Error("transient render");},40);t.after(off);
 t.mock.timers.tick(80);assert.equal(calls,2);assert.equal(errors.mock.callCount(),0);
});
test("Wave's timer stays fixed as its smoothed rate drifts",t=>{
 t.mock.timers.enable({apis:["setInterval"]});const original=setInterval;let created=0;
 t.mock.method(globalThis,"setInterval",(fn:()=>void,ms:number)=>{created++;return original(fn,ms);});
 let off:(()=>void)|undefined,previous:number|undefined;
 for(const rate of [0,4,12,34,70,19,2]){
  const cadence=spinnerCadence(MODE_SPINNERS.text,false,rate);
  assert.equal(cadence%40,0);
  if(cadence!==previous){off?.();off=everyFrame(()=>{},cadence);previous=cadence;}
 }
 off?.();assert.equal(created,1);
});
test("40ms-aligned consumers retain exact relative timing without jitter",t=>{
 t.mock.timers.enable({apis:["setInterval"]});const ticks:string[]=[];
 const fast=everyFrame(()=>ticks.push("fast"),70),slow=everyFrame(()=>ticks.push("slow"),100);
 t.after(()=>{fast();slow();});t.mock.timers.tick(240);
 assert.deepEqual(ticks,["fast","slow","fast","fast","slow"]);
});
