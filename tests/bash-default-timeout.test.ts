import { test } from "node:test";
import assert from "node:assert/strict";
import bashDefaultTimeout, { DEFAULT_TIMEOUT_SECONDS, applyDefaultTimeout, resolveDefaultSeconds, timeoutGuideline } from "../extensions/bash-default-timeout.ts";

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

	const unset: Record<string, unknown> = { command: "ls", timeout: null };
	assert.equal(applyDefaultTimeout(unset, 120), true);
	assert.equal(unset.timeout, 120);

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

test("an explicit timeout passes through unchanged, also an invalid one, so Pi reports it", () => {
	for (const timeout of [0, -5, Number.NaN, "soon", 3_000_000]) {
		const input: Record<string, unknown> = { command: "ls", timeout };
		assert.equal(applyDefaultTimeout(input, 120), false, String(timeout));
		assert.equal(input.timeout, timeout);
	}
});

test("a default above the longest timer Pi can set is invalid, so the built-in default applies", () => {
	assert.equal(resolveDefaultSeconds("2147483.647"), 2147483.647);
	assert.equal(resolveDefaultSeconds("2147483.648"), DEFAULT_TIMEOUT_SECONDS);
	assert.equal(resolveDefaultSeconds("1e12"), DEFAULT_TIMEOUT_SECONDS);
	assert.equal(resolveDefaultSeconds("Infinity"), DEFAULT_TIMEOUT_SECONDS);
});

test("Pi's powershell tool gets the default too", async () => {
	const handler = install(undefined)!;
	const powershell = { toolName: "powershell", input: { command: "Get-ChildItem" } as Record<string, unknown> };
	await handler(powershell, {});
	assert.equal(powershell.input.timeout, DEFAULT_TIMEOUT_SECONDS);
});

test("PI_BASH_DEFAULT_TIMEOUT=off registers nothing", () => {
	assert.equal(install("off"), undefined);
	const custom = install("30");
	assert.ok(custom);
	const bash = { toolName: "bash", input: {} as Record<string, unknown> };
	void custom(bash, {});
	assert.equal(bash.input.timeout, 30);
});

type StartHandler = (event: { systemPromptOptions: { selectedTools: string[]; toolGuidelines: Record<string, string[]> } }) => unknown;

function installStart(env: string | undefined): StartHandler | undefined {
	const previous = process.env.PI_BASH_DEFAULT_TIMEOUT;
	if (env === undefined) delete process.env.PI_BASH_DEFAULT_TIMEOUT;
	else process.env.PI_BASH_DEFAULT_TIMEOUT = env;
	let handler: StartHandler | undefined;
	try {
		bashDefaultTimeout({ on: (name: string, fn: StartHandler) => { if (name === "before_agent_start") handler = fn; } } as never);
	} finally {
		if (previous === undefined) delete process.env.PI_BASH_DEFAULT_TIMEOUT;
		else process.env.PI_BASH_DEFAULT_TIMEOUT = previous;
	}
	return handler;
}

test("the model is told the default, for each active shell tool only, once", () => {
	const handler = installStart("300");
	assert.ok(handler, "before_agent_start handler registered");
	const options = { selectedTools: ["read", "bash"], toolGuidelines: { bash: ["Pi's own bash rule"] } as Record<string, string[]> };
	handler({ systemPromptOptions: options });
	handler({ systemPromptOptions: options });
	assert.equal(options.toolGuidelines.bash.length, 2, "Pi's rule stays and ours is added once");
	assert.equal(options.toolGuidelines.bash[0], "Pi's own bash rule");
	assert.match(options.toolGuidelines.bash[1], /bash call with no `timeout` stops after 300 seconds/);
	assert.equal(options.toolGuidelines.powershell, undefined, "an inactive tool gets no rule");

	const both = { selectedTools: ["bash", "powershell"], toolGuidelines: {} as Record<string, string[]> };
	handler({ systemPromptOptions: both });
	assert.match(both.toolGuidelines.powershell[0], /powershell call with no `timeout` stops after 300 seconds/);
});

test("one second reads as one second", () => {
	assert.match(timeoutGuideline("bash", 1), /stops after 1 second\./);
	assert.match(timeoutGuideline("bash", 0.5), /stops after 0\.5 seconds\./);
});

test("with the default off, the model is told nothing", () => {
	assert.equal(installStart("off"), undefined);
});
