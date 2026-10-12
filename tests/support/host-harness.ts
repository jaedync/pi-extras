/**
 * A session's host (host-state.ts) behind fake ports: a launcher whose children
 * finish only when a test says so, main's mail recorded as it is sent, and
 * notices kept. `portsFor` makes the ports a module would bind, so a test can
 * park the host and bind another module's ports, as a /reload does.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, type SubagentsConfig } from "../../lib/subagents/config.ts";
import type { HostMessage, HostPorts, HostState } from "../../lib/subagents/contract.ts";
import type { Route } from "../../lib/subagents/deliver.ts";
import { openHost } from "../../lib/subagents/host-state.ts";
import type { AgentRecord, ChildHandle, ChildHooks, Launcher, SpawnRequest } from "../../lib/subagents/types.ts";

export interface Call { name: string; text: string; launcher: string; finish(result: string): void }

/** One module's ports: what it was sent, what it was told, and the children its launcher made. */
export interface FakeModule {
	readonly label: string;
	readonly ports: HostPorts;
	readonly sent: Array<{ message: HostMessage; options: { triggerTurn: boolean; deliverAs?: "steer" } }>;
	readonly notices: string[];
	readonly launched: string[];
	route: Route;
	/** The launcher's sessions stop being current, as an edited settings file makes them. */
	stale: boolean;
}

export function hostHarness(config: Partial<SubagentsConfig> = {}) {
	const dir = mkdtempSync(join(tmpdir(), "subagents-host-"));
	const calls: Call[] = [];
	const disposed: string[] = [];
	const modules: FakeModule[] = [];
	const portsFor = (label: string): FakeModule => {
		const module: FakeModule = { label, sent: [], notices: [], launched: [], route: "wake", stale: false, ports: undefined! };
		const launcher: Launcher = {
			async launch(record: AgentRecord, _hooks: ChildHooks): Promise<ChildHandle> {
				module.launched.push(record.name);
				const transcript: unknown[] = [];
				return {
					...(record.sessionFile ? { sessionFile: record.sessionFile } : {}),
					stamp: { generation: modules.indexOf(module), files: [] },
					prompt: (text) => new Promise<void>((resolve) => {
						transcript.push({ role: "user", content: [{ type: "text", text }] });
						calls.push({ name: record.name, text, launcher: label, finish: (result) => { transcript.push({ role: "assistant", content: [{ type: "text", text: result }] }); resolve(); } });
					}),
					steer: () => undefined,
					abort: async () => undefined,
					lastText: () => undefined,
					messages: () => transcript,
					takeQueued: () => [],
					dispose: async () => { disposed.push(record.name); },
				};
			},
			current: () => !module.stale,
		};
		Object.assign(module, {
			ports: {
				send: (message, options) => { module.sent.push({ message, options }); },
				route: () => module.route,
				notify: (message) => { module.notices.push(message); },
				teamChanged: () => undefined,
				mailChanged: () => undefined,
				launcher,
				models: () => ({ allowed: [{ ref: "faux/cheap", model: { id: "cheap", provider: "faux" } }], fallbackModel: "faux/cheap" }),
			} satisfies HostPorts,
		});
		modules.push(module);
		return module;
	};
	const open = (module: FakeModule, extra: { lease?: () => void; generation?: number } = {}): HostState => openHost({
		generation: extra.generation ?? 1, agentDir: join(dir, "agent"), cwd: dir, sessionId: "parent-1", owner: "owner-1",
		config: { ...DEFAULTS, batchMs: 1, ...config }, branch: () => [],
		scanner: { branch: () => assert.fail("no transcripts on disk here"), messages: () => [] },
		ports: module.ports,
		...(extra.lease ? { lease: extra.lease } : {}),
	});
	const spawn = (host: HostState, task: string, extra: Partial<SpawnRequest> = {}): string => {
		const result = host.team.spawn({ task, parent: "main", model: "faux/cheap", readOnly: false, fork: false, blocking: false, ...extra });
		assert.ok(result.ok, !result.ok ? result.error : "");
		return result.record.name;
	};
	const call = (name: string): Call => {
		const found = calls.filter((entry) => entry.name === name).at(-1);
		assert.ok(found, `${name} has not been prompted`);
		return found;
	};
	/** What main was sent that carries `name`'s report. */
	const reports = (module: FakeModule, name: string) => module.sent.filter(({ message }) => message.customType === "subagent-report" && JSON.stringify(message.details).includes(`"name":"${name}"`));
	const cleanup = () => rmSync(dir, { recursive: true, force: true });
	return { dir, calls, disposed, portsFor, open, spawn, call, reports, cleanup, indexFile: join(dir, "agent", "sessions", "subagents", "parent-1", "index.json") };
}
