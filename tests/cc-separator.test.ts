import assert from "node:assert/strict";
import test from "node:test";
import { SEP } from "../lib/cc-phase.ts";
import { readRenderers } from "../lib/tool-display/files.ts";
import { webSearchSpec } from "../lib/tool-display/web.ts";
import { toolRenderers } from "../lib/tool-display/tool.ts";
import { harness, row, text } from "./support/tool-rows.ts";
test("tool-row separators use SEP without changing comma-containing input or literal output dots",()=>{
 assert.equal(SEP,", ");const h=harness();
 const read=row(readRenderers(h.kit),{path:"a, b.txt"});
 read.update({isPartial:false,expanded:true,result:text("alpha · beta\nsecond")});
 assert.ok(read.lines()[0]!.includes(`read a, b.txt${SEP}2 lines`));
 assert.ok(read.lines().some(line=>line.includes("alpha · beta")));
 const search=row(toolRenderers(h.kit,webSearchSpec("web_search")) as never,{query:"apples, pears"});
 search.update({isPartial:false,result:text("",{resultCount:0})});
 assert.ok(search.lines()[0]!.includes(`web_search apples, pears${SEP}no results`));
});
