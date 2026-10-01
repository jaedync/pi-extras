import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
test("the finished thought label uses the shared thought glyph", () => {
 const source=readFileSync(new URL("../lib/tool-display/index.ts",import.meta.url),"utf8");
 assert.match(source,/import \{ THOUGHT_GLYPH \} from "\.\.\/band\/glyph\.ts"/);
 assert.doesNotMatch(source,/∴ Thought/);
});
