/**
 * Shared harness for the shell-jobs UI suites (`shell-jobs-render.test.mts`,
 * `shell-jobs-extension.test.mts`).
 *
 * Loads the real extension and lib modules through the same jiti aliases Pi's
 * loader applies, so they need an installed Pi runtime (PI_TEST_AGENT_ROOT
 * overrides the default) and the real TUI display helpers. The fake Pi records
 * everything the extension does (tools, messages, widgets, notices) so a test
 * can assert on it without a session.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Job } from "../../lib/shell-jobs-process.ts";

import { agentRoot } from './pi-runtime.mjs';
export { agentRoot };
const { createJiti } = createRequire(join(agentRoot, "package.json"))("jiti");
const loaderOptions = {
	alias: {
		typebox: createRequire(join(agentRoot, "package.json")).resolve("typebox"),
		"@earendil-works/pi-coding-agent": fileURLToPath(new URL("../fixtures/shell-jobs-pi-api.mjs", import.meta.url)),
		"@earendil-works/pi-tui": createRequire(join(agentRoot, "package.json")).resolve("@earendil-works/pi-tui"),
	},
};
export const jiti = createJiti(import.meta.url, loaderOptions);

/** Match Pi's reload: re-evaluate modules, retaining only process-global state. */
export async function loadFreshShellJobs() {
	const loader = createJiti(import.meta.url, { ...loaderOptions, moduleCache: false, fsCache: false });
	return (await loader.import("../../extensions/shell-jobs.ts")) as typeof import("../../extensions/shell-jobs.ts");
}

export const shellJobsModule = (await jiti.import("../../extensions/shell-jobs.ts")) as typeof import("../../extensions/shell-jobs.ts");
export const shellJobs = shellJobsModule.default;
export const { __testing } = shellJobsModule;
export const core = (await jiti.import("../../lib/shell-jobs-core.ts")) as typeof import("../../lib/shell-jobs-core.ts");
export const delivery = (await jiti.import("../../lib/shell-jobs-delivery.ts")) as typeof import("../../lib/shell-jobs-delivery.ts");
export const widget = (await jiti.import("../../lib/shell-jobs-widget.ts")) as typeof import("../../lib/shell-jobs-widget.ts");
export const render = (await jiti.import("../../lib/shell-jobs-render.ts")) as typeof import("../../lib/shell-jobs-render.ts");
export const inspector = (await jiti.import("../../lib/shell-jobs-inspector.ts")) as typeof import("../../lib/shell-jobs-inspector.ts");
export const tui = (await jiti.import("@earendil-works/pi-tui")) as typeof import("@earendil-works/pi-tui");

export function contains(haystack: unknown, needle: unknown): void {
	assert.ok(
		(haystack as { includes(value: unknown): boolean }).includes(needle),
		`expected ${JSON.stringify(haystack)} to contain ${JSON.stringify(needle)}`,
	);
}

export function doesNotContain(haystack: unknown, needle: unknown): void {
	assert.ok(
		!(haystack as { includes(value: unknown): boolean }).includes(needle),
		`expected ${JSON.stringify(haystack)} not to contain ${JSON.stringify(needle)}`,
	);
}

const tempDirs: string[] = [];
export function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "shell-jobs-test-"));
	tempDirs.push(dir);
	return dir;
}

/** For afterEach: drop this test's temp dirs and any job log dir a test left behind. */
export function cleanup(): void {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	__testing.disposeAll();
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface FakeMessage {
	message: { customType?: string; content: string; details?: Record<string, unknown> };
	options?: { triggerTurn?: boolean; deliverAs?: string };
}

/** Loose shape of what pi hands a message renderer; tests pass plain objects. */
export type RenderedComponent = { render(width: number): string[]; handleMouse?(event: unknown): unknown };
export type CompletionRenderer = (
	message: { customType: string; content: string; details?: Record<string, unknown> },
	options: { expanded: boolean; outputPad: number },
	theme: unknown,
) => RenderedComponent | undefined;

export type Handler = (event: unknown, ctx: unknown) => unknown;

/** What pi hands an overlay factory; tests build the component from it. */
export interface FakeOverlay {
	factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: unknown) => void) => any;
	options: Record<string, unknown> | undefined;
	/** Closes the overlay the way pi's `done` does. */
	resolve: (result?: unknown) => void;
}

/** The `tui` an overlay factory receives: a render counter and a terminal size. */
export function fakeTui(rows = 40, columns = 100) {
	const renders: number[] = [];
	return { renders, requestRender: () => { renders.push(Date.now()); }, terminal: { rows, columns } };
}

export function createFakePi(existingToolNames: string[] = [], mode = "rpc") {
	const tools = new Map<string, any>();
	const messages: FakeMessage[] = [];
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, Record<string, any>>();
	const notices: Array<{ text: string; level: string }> = [];
	const widgets: Array<{ id: string; value: unknown }> = [];
	const renderers = new Map<string, CompletionRenderer>();
	const overlays: FakeOverlay[] = [];
	const selects: Array<{ title: string; options: string[] }> = [];
	/** Queued answers for `ui.select`; an empty queue answers undefined (cancelled). */
	const selectAnswers: Array<string | undefined> = [];
	const pi = {
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		registerMessageRenderer(customType: string, renderer: CompletionRenderer) {
			renderers.set(customType, renderer);
		},
		registerCommand(name: string, options: Record<string, any>) {
			commands.set(name, options);
		},
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		getAllTools() {
			return [...existingToolNames, ...tools.keys()].map((name) => ({ name }));
		},
		sendMessage(message: FakeMessage["message"], options: FakeMessage["options"]) {
			messages.push({ message, options });
		},
	};
	const ctx = {
		cwd: tempDir(),
		hasUI: true,
		mode,
		isIdle: () => true,
		ui: {
			notify(text: string, level: string) {
				notices.push({ text, level });
			},
			setWidget(id: string, value: unknown) {
				widgets.push({ id, value });
			},
			custom(factory: FakeOverlay["factory"], options?: Record<string, unknown>) {
				return new Promise<unknown>((resolve) => {
					overlays.push({ factory, options, resolve });
				});
			},
			select(title: string, options: string[]) {
				selects.push({ title, options });
				return Promise.resolve(selectAnswers.shift());
			},
		},
		sessionManager: { getBranch: () => [] as Array<Record<string, unknown>> },
	};
	return { pi, tools, messages, handlers, commands, notices, widgets, renderers, overlays, selects, selectAnswers, ctx };
}

export async function fire(handlers: Map<string, Handler[]>, event: string, ctx: unknown, payload: unknown = { reason: "startup" }): Promise<void> {
	for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
}

export function makeJob(overrides: Partial<Job> = {}): Job {
	return {
		id: "j1",
		pid: 100,
		command: "npm test -- --watchAll=false",
		title: null,
		toolCallId: null,
		cwd: "/tmp",
		logPath: "/tmp/j1.log",
		startedAt: 1000,
		epoch: 1,
		state: "running",
		code: null,
		signal: null,
		endedAt: null,
		claimed: false,
		attempts: 0,
		delivered: false,
		deliveryFailed: false,
		cleanupError: null,
		runtimeId: "rt",
		...overrides,
	};
}
