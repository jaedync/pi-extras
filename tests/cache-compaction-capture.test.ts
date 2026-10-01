import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import cacheCompaction from "../extensions/cache-compaction.ts";

for (const reason of ["capture-no-system", "capture-no-model", "capture-projection", "capture-identity", "capture-payload", "capture-no-context", "capture-headers", "capture-failed"]) test(`capture miss records ${reason}, not no-request`, async () => {
	const dir = mkdtempSync(join(tmpdir(), "capture-reason-"));
	const handlers = new Map<string, Function>();
	const model = { provider: "fixture", id: "model", api: "anthropic-messages", contextWindow: 100000 };
	const messages = [{ role: "system", content: "prompt", timestamp: 0 }, { role: "user", content: "task", timestamp: 1 }];
	const ctx = { model: model as typeof model | undefined, sessionManager: { getSessionId: () => "fixture", getBranch: () => [], buildSessionProjection: () => ({ messages }) }, mode: "print" };
	cacheCompaction({ on: (name: string, handler: Function) => handlers.set(name, handler), events: { emit() {} } } as never, { configFile: join(dir, "pi-extras.json") });
	try {
		if (reason === "capture-no-model") ctx.model = undefined;
		if (reason === "capture-failed") ctx.sessionManager.buildSessionProjection = () => { throw new Error("private projection error"); };
		if (reason !== "capture-no-context") await handlers.get("context_with_system")!({ messages: reason === "capture-no-system" ? messages.slice(1) : reason === "capture-projection" ? [{ role: "system", content: "rewritten", timestamp: 9 }] : messages }, ctx);
		if (reason === "capture-headers") await handlers.get("before_provider_headers")!({ headers: Object.defineProperty({}, "routing", { enumerable: true, get() { throw new Error("private header error"); } }) }, ctx);
		ctx.model = reason === "capture-identity" ? { ...model, id: "changed" } : model;
		await handlers.get("before_provider_request")!({ payload: reason === "capture-payload" ? {} : { messages } }, ctx);
		ctx.model = model;
		await handlers.get("session_before_compact")!({ preparation: { tokensBefore: 12 }, reason: "manual", signal: new AbortController().signal }, ctx);
		assert.equal(JSON.parse(readFileSync(join(dir, "cache-compaction.log"), "utf8")).fallbackReason, reason);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
