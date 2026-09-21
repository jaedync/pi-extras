import { test } from "node:test";
import assert from "node:assert/strict";
import bashDefaultTimeout, { DEFAULT_TIMEOUT_SECONDS, applyDefaultTimeout, resolveDefaultSeconds } from "../extensions/bash-default-timeout.ts";

type Handler = (event: { toolName: string; input: unknown }, ctx: unknown) => Promise<unknown>;

function install(env: string | undefined): Handler | undefined {
	const previous = process.env.PI_BASH_DEFAULT_TIMEOUT;
	if (env === undefined) delete process.env.PI_BASH_DEFAULT_TIMEOUT;
	else process.env.PI_BASH_DEFAULT_TIMEOUT = env;
	let handler: Handler | undefined;
	try {
		bashDefaultTimeout({ on: (name: string, fn: Handler) => { if (name === "tool_call") handler = fn; } } as never);
	} finally {
		if (previous === undefined) delete process.env.PI_BASH_DEFAULT_TIMEOUT;
		else process.env.PI_BASH_DEFAULT_TIMEOUT = previous;
	}
	return handler;
}

test("environment override resolves to seconds, disables, or falls back", () => {
	assert.equal(resolveDefaultSeconds(undefined), DEFAULT_TIMEOUT_SECONDS);
	assert.equal(resolveDefaultSeconds(""), DEFAULT_TIMEOUT_SECONDS);
	assert.equal(resolveDefaultSeconds("300"), 300);
	assert.equal(resolveDefaultSeconds(" 45 "), 45);
	assert.equal(resolveDefaultSeconds("0"), undefined);
	assert.equal(resolveDefaultSeconds("off"), undefined);
	assert.equal(resolveDefaultSeconds("banana"), DEFAULT_TIMEOUT_SECONDS);
	assert.equal(resolveDefaultSeconds("-5"), DEFAULT_TIMEOUT_SECONDS);
});

test("default is applied only when the model omitted a usable timeout", () => {
	const missing: Record<string, unknown> = { command: "ls" };
	assert.equal(applyDefaultTimeout(missing, 120), true);
	assert.equal(missing.timeout, 120);

	const explicit: Record<string, unknown> = { command: "make", timeout: 900 };
	assert.equal(applyDefaultTimeout(explicit, 120), false);
	assert.equal(explicit.timeout, 900);

	const junk: Record<string, unknown> = { command: "ls", timeout: "soon" };
	assert.equal(applyDefaultTimeout(junk, 120), true);
	assert.equal(junk.timeout, 120);

	assert.equal(applyDefaultTimeout(null, 120), false);
	assert.equal(applyDefaultTimeout("ls", 120), false);
});

test("extension patches bash calls in place and ignores other tools", async () => {
	const handler = install(undefined);
	assert.ok(handler, "tool_call handler registered");
	const bash = { toolName: "bash", input: { command: "sleep 999" } as Record<string, unknown> };
	assert.equal(await handler(bash, {}), undefined, "never blocks the call");
	assert.equal(bash.input.timeout, DEFAULT_TIMEOUT_SECONDS);

	const read = { toolName: "read", input: { path: "x" } as Record<string, unknown> };
	await handler(read, {});
	assert.equal(read.input.timeout, undefined);
});

test("PI_BASH_DEFAULT_TIMEOUT=off registers nothing", () => {
	assert.equal(install("off"), undefined);
	const custom = install("30");
	assert.ok(custom);
	const bash = { toolName: "bash", input: {} as Record<string, unknown> };
	void custom(bash, {});
	assert.equal(bash.input.timeout, 30);
});
