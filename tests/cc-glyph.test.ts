import assert from "node:assert/strict";
import test from "node:test";
import { MODE_SPINNERS, SPINNER_SLOT_WIDTH, glyphAt, isBlockingPeer, slotGlyph, spinnerCadence, toolIndicator, toolKind, type GlyphAnimation } from "../lib/band/glyph.ts";

test("per-mode picks keep a fixed slot, distinct reduced frames, rate freezes, and informative drains",()=>{
 assert.equal(SPINNER_SLOT_WIDTH,3);
 assert.equal(MODE_SPINNERS.slow_api,MODE_SPINNERS.first_token);assert.equal(MODE_SPINNERS.stalled,MODE_SPINNERS.first_token);
 assert.equal(slotGlyph({frames:["x"],durationsMs:[100]},0)," x ");
 for(const animation of Object.values(MODE_SPINNERS))assert.equal(glyphAt(animation,100,{reduced:true}),animation.frames[animation.still??0]);
 const wave=MODE_SPINNERS.text,drain=MODE_SPINNERS.retry;
 assert.equal(glyphAt(wave,1000),glyphAt(wave,5000));
 assert.notEqual(glyphAt(wave,1000,{rateElapsedMs:140}),glyphAt(wave,1000,{rateElapsedMs:0}));
 assert.notEqual(glyphAt(drain,0,{reduced:true,fraction:0}),glyphAt(drain,0,{reduced:true,fraction:1}));
 assert.equal(spinnerCadence(wave,false,0),80);assert.equal(spinnerCadence(wave,false,34),80);
 assert.equal(toolKind("bash",.5),"timeout");assert.equal(toolKind("subagent"),"orbit");assert.equal(toolKind("fetch_content"),"breath");assert.equal(toolKind("read"),"still");
 assert.equal(isBlockingPeer("subagent",{wait:false}),false);assert.equal(isBlockingPeer("subagent",{wait:true}),true);
 assert.equal(isBlockingPeer("agent_request",{}),true);
});
test("hero frames support zero to six cells and forty braille frames, but never mixed widths",()=>{
 const wide={frames:Array.from({length:40},(_,i)=>String.fromCharCode(0x2800+i).repeat(6)),durationsMs:Array(40).fill(80)};
 assert.equal(glyphAt(wide,80),wide.frames[1]);
 assert.equal(glyphAt({frames:[""],durationsMs:[100]},0),"");
 assert.throws(()=>glyphAt({frames:["x","xx"],durationsMs:[100,100]},0),/width/);
 assert.throws(()=>glyphAt({frames:["1234567"],durationsMs:[100]},0),/width/);
});
test("tool indicators remain independent, one cell wide, with bounded color blends",()=>{
 for(const mode of ["blink","breath","timeout","orbit","still"] as const)for(const ms of [0,100,500,1000,2000]){
  const indicator=toolIndicator(ms,.5,mode);
  assert.equal([...indicator.glyph].length,1);assert.ok(indicator.blend>=0&&indicator.blend<=1);
 }
 assert.deepEqual([0,.25,.5,.75,1].map(f=>toolIndicator(0,f,"timeout").glyph),["○","◔","◑","◕","●"]);
 assert.notEqual(toolIndicator(0,undefined,"breath").blend,toolIndicator(400,undefined,"breath").blend);
});
test("unequal frame durations, endpoint-safe ping-pong and wrapping use one clock",()=>{
 const pie:GlyphAnimation={frames:["◌","◔","◕"],durationsMs:[300,300,600]};
 assert.deepEqual([0,299,300,599,600,1199,1200].map(ms=>glyphAt(pie,ms)),["◌","◌","◔","◔","◕","◕","◌"]);
 const mirrored={...pie,pingPong:true};
 assert.deepEqual([0,300,600,1199,1200,1499,1500].map(ms=>glyphAt(mirrored,ms)),["◌","◔","◕","◕","◔","◔","◌"]);
 const heartbeat={frames:["∙","◦","∙","◦"],durationsMs:[520,110,130,110]};
 assert.deepEqual([0,519,520,629,630,759,760,869,870].map(ms=>glyphAt(heartbeat,ms)),["∙","∙","◦","◦","∙","∙","◦","◦","∙"]);
 assert.equal(glyphAt(pie,NaN),"◌");
 assert.throws(()=>glyphAt({frames:["x"],durationsMs:[0]},0),/duration/);
});
