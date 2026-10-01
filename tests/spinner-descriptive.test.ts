import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_VERBS, parseVerbs, renderRunLine, renderEndLine, parseEndLine, type RunLine } from "../lib/cc-phase.ts";
const theme={fg:(_key:string,text:string)=>text};
const base={elapsedMs:12000,phaseMs:12000,tokens:212,clockMs:0,reduced:true};
test("descriptive is default; playful and custom lists explicitly opt in",()=>{
 assert.deepEqual(parseVerbs(undefined),[]);assert.deepEqual(parseVerbs("bad"),[]);assert.equal(parseVerbs("playful"),DEFAULT_VERBS);
 assert.deepEqual(parseVerbs(["Mixing|Mixed"]),[{present:"Mixing",past:"Mixed"}]);
});
test("descriptive titles own the phase, without duplicate details",()=>{
 for(const [phase,extra,expected] of [
 ["api",{elapsedMs:1000},"Sending request… (1s, ↑)"],
 ["first_token",{elapsedMs:4000},"Waiting for the model… (4s)"],
 ["think",{},"Still thinking… (12s, ↓ 212 tokens)"],
 ["think",{phaseMs:0},"Thinking… (12s, ↓ 212 tokens)"],
 ["think",{phaseMs:21000},"Thinking more… (12s, ↓ 212 tokens)"],
 ["think",{phaseMs:46000},"Deep in thought… (12s, ↓ 212 tokens)"],
 ["tool",{pendingTool:"bash",elapsedMs:9000,tokens:486},"Writing bash call… (9s, ↓ 486 tokens)"],
 ["run",{tools:["bash"]},"Running bash… (12s)"],
 ["run",{tools:["read","read","bash"]},"Running 3 tools… (12s)"],
 ["text",{elapsedMs:21000,tokens:1204},"Writing reply… (21s, ↓ 1,204 tokens)"],
 ] as const){const line=renderRunLine({...base,phase,...extra} as RunLine,120,theme);assert.equal(line.slice(4),expected);}
});
test("descriptive end metadata renders done; old playful metadata still renders unchanged",()=>{
 const end={elapsedMs:41000,doneAt:"9:14 PM"};assert.deepEqual(parseEndLine(end),end);
 assert.equal(renderEndLine(end,80,theme),"π Worked for 41s, done 9:14 PM");
 assert.equal(renderEndLine({...end,stopped:true},80,theme),"π Stopped after 41s");
 assert.equal(renderEndLine({...end,past:"Mixed"},80,theme),"π Mixed for 41s, done 9:14 PM");
});
