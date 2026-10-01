import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { END_GLYPH, PI_WAVE_MS, piWave } from "../lib/band/glyph.ts";
import { renderPiWave } from "../lib/cc-phase.ts";
test("the 760ms sign-off waves columns left to right and terminates",()=>{
 assert.equal(PI_WAVE_MS,760);assert.equal(visibleWidth(END_GLYPH),1);
 assert.deepEqual([0,200,440,600,760].map(ms=>piWave(ms).dots),[0,11,12,7,0]);
 assert.equal(piWave(440).cells.map(cell=>cell.glyph).join(""),"⢹⠉⡏");
 assert.equal(piWave(760).ended,true);
 const theme={fg:(_key:string,text:string)=>text};
 assert.equal(visibleWidth(renderPiWave(440,theme)),3);
 assert.equal(renderPiWave(760,theme),"");
});
