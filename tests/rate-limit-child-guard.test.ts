import assert from "node:assert/strict";
import { test } from "node:test";
import { createChildRateLimitGuard } from "../lib/rate-limit-recovery/child.ts";

type Handler = (event: any, ctx: any) => any;
function fixture() {
	const original = { id: "anthropic", name: "synthetic", stream() {}, streamSimple() {} };
	let current: typeof original | undefined = original;
	let fault = false;
	let restoreFault = false;
	const getProvider = () => { if (fault) throw new Error("synthetic registration failure"); return current; };
	const modelRegistry = {
		getProvider, getRegisteredNativeProvider: getProvider, getRegisteredProviderConfig: () => undefined,
		registerProvider(value: typeof original) { if (restoreFault) throw new Error("synthetic restoration failure"); current = value; }, unregisterProvider() { current = undefined; },
	};
	const notices: string[] = [], warnings: string[] = [];
	const controller = new AbortController();
	const ctx = { modelRegistry, model: { provider: "anthropic", api: "anthropic-messages", id: "synthetic" },
		mode: "print", hasUI: false, signal: controller.signal, abort: () => controller.abort(), ui: { notify: (text: string) => notices.push(text) } };
	const handlers = new Map<string, Handler>();
	const guard = createChildRateLimitGuard({ onWarning: (code) => warnings.push(code) });
	guard.extension.factory({ on: (name: string, handler: Handler) => handlers.set(name, handler) } as never);
	return { guard, ctx, original, notices, warnings, current: () => current, fail: () => { fault = true; }, failRestore: () => { restoreFault = true; }, emit: (name: string, event = {}) => handlers.get(name)?.(event, ctx) };
}

test("a child owns transport protection and releases it explicitly without a shutdown event", () => {
	const f = fixture();
	try {
		f.emit("session_start");
		assert.notEqual(f.current()!.streamSimple, f.original.streamSimple);
		f.emit("before_agent_start");
		f.emit("context");
		assert.equal(f.guard.failure(), undefined);
		f.guard.dispose();
		f.guard.dispose();
		assert.equal(f.current()!.streamSimple, f.original.streamSimple);
	} finally { f.guard.dispose(); }
});

test("restoration failure is reported without blocking child disposal", () => {
	const f = fixture();
	f.emit("session_start");
	f.failRestore();
	assert.doesNotThrow(() => f.guard.dispose());
	assert.ok(f.warnings.includes("native-restore-failed"));
	assert.equal(f.guard.failure(), undefined);
	assert.doesNotThrow(() => f.guard.dispose());
});

test("late child callbacks cannot reinstall a disposed guard until a new session starts", () => {
	const f = fixture();
	try {
		f.emit("session_start");
		f.guard.dispose();
		f.emit("before_agent_start");
		f.emit("context");
		assert.equal(f.current()!.streamSimple, f.original.streamSimple);
		f.emit("session_start");
		assert.notEqual(f.current()!.streamSimple, f.original.streamSimple);
	} finally { f.guard.dispose(); }
});

test("child setup errors abort and remain actionable instead of appearing successful", () => {
	const f = fixture();
	try {
		f.fail();
		f.emit("before_agent_start");
		assert.equal(f.ctx.signal.aborted, true);
		assert.match(f.guard.failure()!, /quota retry protection.*reload/i);
		assert.match(f.notices.join("\n"), /quota retry protection/i);
		assert.ok(f.warnings.includes("installation-failed"));
		f.emit("context");
		assert.match(f.guard.failure()!, /reload/i);
	} finally { f.guard.dispose(); }
});

test("child quota finalization preserves the error while aborting further native retries", () => {
	const f = fixture();
	try {
		const message = { role: "assistant", provider: "anthropic", api: "anthropic-messages", model: "synthetic", timestamp: 0, stopReason: "error", content: [],
			errorMessage: JSON.stringify({ error: { type: "rate_limit_error", retry_after: 60 } }) };
		const result = f.emit("message_end", { message } as any);
		assert.equal(result.message.stopReason, "error");
		assert.match(result.message.errorMessage, /subagents never automatically wait/i);
		assert.match(result.message.errorMessage, /expected reset/i);
		assert.equal(f.ctx.signal.aborted, true);
		assert.equal(f.guard.failure(), undefined);
	} finally { f.guard.dispose(); }
});
