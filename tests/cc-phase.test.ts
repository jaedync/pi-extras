import assert from "node:assert/strict";
import test from "node:test";
import { colorToHex, rgbColor, stripTerminalSequences, visibleWidth, type Color } from "@earendil-works/pi-tui";
import { DEFAULT_VERBS, parseVerbs, pickVerb, phaseParts, renderRunLine, runAnimation, streamRate, renderEndLine, parseEndLine, smoothTokens, sweepAt, thinkingLabel, type RunLine } from "../lib/cc-phase.ts";
import { END_GLYPH, MODE_SPINNERS, SPINNER_FRAMES, SPINNER_CYCLE_MS, spinnerGlyph } from "../lib/band/glyph.ts";
const theme = { fg: (_key: string, text: string) => text };
const base = { verb: DEFAULT_VERBS[0]!, phase: "text" as const, elapsedMs: 0, phaseMs: 0, tokens: 0, clockMs: 0, reduced: false };
test("zero- and six-cell heroes use their real widths, including braille",()=>{
 for(const frame of ["","⠁⠂⠄⡀⢀⠠"]){
  const animation={frames:[frame],durationsMs:[300]};
  for(let width=0;width<50;width++)assert.ok(visibleWidth(renderRunLine(base,width,theme,animation))<=width);
  const full=renderRunLine(base,80,theme,animation);
  assert.ok(full.startsWith(frame ? frame+" "+base.verb.present : base.verb.present));
 }
});
test("all mode picks keep the verb at the same terminal column",()=>{
 for(const phase of ["prep","api","first_token","think","text","tool","run"] as const){
  const line=stripTerminalSequences(renderRunLine({...base,phase,reduced:true},100,theme));
  assert.equal(visibleWidth(line.slice(0,line.indexOf("Proofing"))),4);
 }
});
test("blocking peer waits alone select Twin, and stream-rate smoothing decays without rewinding",()=>{
 assert.equal(runAnimation({...base,phase:"run",tools:["subagent"],waitingOnPeers:true}),MODE_SPINNERS.peer);
 assert.equal(runAnimation({...base,phase:"run",tools:["subagent"],waitingOnPeers:false}),MODE_SPINNERS.run);
 let rate=streamRate({at:0,chars:0,rate:0,waveMs:0},1000,136);
 assert.ok(rate.rate>0);const initial=rate;
 for(let at=1200;at<=8000;at+=200)rate=streamRate(rate,at,136);
 assert.ok(rate.rate<.001);assert.ok(rate.waveMs>=initial.waveMs);
});
test("verbs validate overrides, keep paired past tenses and pick once", () => {
 assert.equal(DEFAULT_VERBS.length, 30);
 assert.deepEqual(parseVerbs(["Mixing|Mixed", {present: "Baking", past: "Baked"}, "bad", {present: "\x1b[31m", past: "x"}]), [{present:"Mixing",past:"Mixed"},{present:"Baking",past:"Baked"}]);
 assert.equal(parseVerbs([]), DEFAULT_VERBS);
 assert.equal(pickVerb(DEFAULT_VERBS, () => 0), DEFAULT_VERBS[0]);
});
test("parts add useful detail, elapsed at 16s, direction, thinking progression and recent thought", () => {
 assert.deepEqual(phaseParts(base), []);
 assert.deepEqual(phaseParts({...base, elapsedMs:16000}), ["16s"]);
 assert.deepEqual(phaseParts({...base, phase:"api", elapsedMs:1200}), ["sending request","1s","↑"]);
 assert.deepEqual(phaseParts({...base, phase:"think", phaseMs:21000, elapsedMs:23000, tokens:456}), ["23s","↓ 456 tokens","thinking more"]);
 assert.deepEqual(phaseParts({...base, phase:"run", tools:["bash","read"], elapsedMs:3000}), ["running 2 tools","3s"]);
 assert.ok(phaseParts({...base, thoughtMs:12000, sinceThoughtMs:1999}).includes("thought for 12s"));
 assert.ok(!phaseParts({...base, thoughtMs:12000, sinceThoughtMs:2000}).includes("thought for 12s"));
 assert.deepEqual([0,10000,20000,30000,45000].map(thinkingLabel), ["thinking","still thinking","thinking more","thinking some more","deep in thought"]);
});
test("glyph timing, sweep direction, token easing and reduced motion", () => {
 assert.equal(spinnerGlyph(0), SPINNER_FRAMES[0]);
 assert.equal(spinnerGlyph(SPINNER_CYCLE_MS), SPINNER_FRAMES[0]);
 assert.equal(spinnerGlyph(500,true), SPINNER_FRAMES[MODE_SPINNERS.prep.still??0]);
 assert.equal(sweepAt(10,0,true), -3);
 assert.equal(sweepAt(10,50,true), -2);
 assert.equal(sweepAt(10,200,false), 12);
 assert.equal(smoothTokens(0,100,50),13);
 assert.equal(smoothTokens(99,100,50),100);
});
test("custom verbs preserve graphemes and model tool names cannot inject terminal controls",()=>{
 const segments:string[]=[];
 renderRunLine({...base,verb:{present:"👩‍💻🇺🇸",past:"Done"}},80,{...theme,colors:{accent:rgbColor(1,2,3)},style:(text)=>{segments.push(text);return text;}});
 assert.ok(segments.includes("👩‍💻"));assert.ok(segments.includes("🇺🇸"));
 for(const phase of ["tool","run"] as const){
  const line=stripTerminalSequences(renderRunLine({...base,phase,pendingTool:"\x1b[2Jbad\nname",tools:["\x1b]0;bad\x07shell\nname"]},40,theme));
  assert.ok(!/[\x00-\x1f\x7f]/.test(line));assert.ok(visibleWidth(line)<=40);
 }
});

test("theme colors blend during thinking and stalls, tool words pulse, reduced motion is steady", () => {
 const colors={accent:rgbColor(80,100,180),warning:rgbColor(200,140,30),error:rgbColor(200,40,40),text:rgbColor(240,240,240)};
 let styles:Array<{fg?:Color;bold?:boolean}>=[];
 const painted={...theme,colors,style:(text:string,style:{fg?:Color;bold?:boolean})=>{styles.push(style);return text;}};
 const draw=(over:Partial<RunLine>)=>{styles=[];renderRunLine({...base,...over},100,painted);return styles;};
 assert.equal(draw({phase:"think",phaseMs:20000})[0]?.bold,true);
 assert.equal(colorToHex(draw({phase:"think",phaseMs:20000})[0]!.fg!),colorToHex(colors.warning));
 assert.notEqual(colorToHex(draw({phase:"think",phaseMs:15000})[0]!.fg!),colorToHex(colors.warning));
 assert.equal(colorToHex(draw({phase:"text",idleTokenMs:20000})[0]!.fg!),colorToHex(colors.error));
 assert.equal(colorToHex(draw({phase:"think",phaseMs:15000,reduced:true})[0]!.fg!),colorToHex(colors.accent));
 const pulses=[0,250,500].map(clockMs=>colorToHex(draw({phase:"run",clockMs})[1]!.fg!));
 assert.equal(new Set(pulses).size,3,"the pulse blends, rather than flashing between two colors");
});
test("untrusted restored end metadata cannot inject controls or invalid timing", () => {
 assert.equal(parseEndLine(null),undefined);
 assert.equal(parseEndLine({past:"\x1b[2J",elapsedMs:1,doneAt:"7 PM"}),undefined);
 assert.equal(parseEndLine({past:"Done",elapsedMs:-1,doneAt:"7 PM"}),undefined);
 assert.deepEqual(parseEndLine({past:"Done",elapsedMs:1000,doneAt:"7 PM"}),{past:"Done",elapsedMs:1000,doneAt:"7 PM"});
});
test("cancelled runs say stopped rather than claiming completion",()=>{
 assert.equal(renderEndLine({past:"Proofed",elapsedMs:9200,doneAt:"7:43 PM",stopped:true},100,theme),`${END_GLYPH} Stopped after 9s`);
});
test("new spinner and end rows fit every width, including Unicode verbs", () => {
 for (let width=0;width<120;width++) {
  for(const reduced of [false,true]) {
   const line=renderRunLine({...base, verb:{present:"揉むππ",past:"揉んだ"},phase:"think",phaseMs:23000,elapsedMs:32000,tokens:789,reduced},width,theme);
   assert.ok(visibleWidth(line)<=width, `${width}: ${line}`);
  }
  assert.ok(visibleWidth(renderEndLine({past:"Squared the circle",elapsedMs:18000,doneAt:"7:43 PM"},width,theme))<=width);
 }
 assert.equal(stripTerminalSequences(renderEndLine({past:"Proofed",elapsedMs:18000,doneAt:"7:43 PM"},80,theme)), `${END_GLYPH} Proofed for 18s, done 7:43 PM`);
});
