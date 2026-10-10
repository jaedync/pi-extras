import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
test("the finished thought label uses the shared thought glyph", () => {
 for (const file of ["index.ts","thinking.ts"]) {
  const source=readFileSync(new URL(`../lib/tool-display/${file}`,import.meta.url),"utf8");
  assert.doesNotMatch(source,/∴ Thought/,file);
 }
 const thinking=readFileSync(new URL("../lib/tool-display/thinking.ts",import.meta.url),"utf8");
 assert.match(thinking,/import \{[^}]*\bTHOUGHT_GLYPH\b[^}]*\} from "\.\.\/band\/glyph\.ts"/);
});
