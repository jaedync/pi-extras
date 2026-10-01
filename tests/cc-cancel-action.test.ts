import assert from "node:assert/strict";
import test from "node:test";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { WrappedEditor } from "../lib/editor-wrapper.ts";
test("the cancel observer sees Pi's real editor action and forwards the native handler unchanged",()=>{
 const tui={requestRender(){}},theme={borderColor:(text:string)=>text},keys={};
 const base=new CustomEditor(tui as any,theme as any,keys as any);base.render=()=>["editor"];
 const calls:string[]=[];
 const wrapped=new WrappedEditor(tui as any,theme as any,keys as any,base,{render:lines=>lines,onEscape:()=>calls.push("observe")});
 wrapped.onEscape=function(){assert.equal(this,base);calls.push("native");};
 wrapped.render(80);base.onEscape?.();assert.deepEqual(calls,["observe","native"]);
});
