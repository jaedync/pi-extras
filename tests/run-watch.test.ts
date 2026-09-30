import assert from "node:assert/strict";
import test from "node:test";
import { watchRun } from "../lib/run-watch.ts";

function fakePi() {
	const handlers = new Map<string, Array<(event: unknown) => void>>();
	return {
		on: (name: string, handler: (event: unknown) => void) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		emit: (name: string, event: unknown = {}) => { for (const handler of handlers.get(name) ?? []) handler(event); },
	};
}

test("a run is busy from agent_start to agent_end and streams only during assistant messages", () => {
	const pi = fakePi();
	const run = watchRun(pi as never);
	assert.deepEqual([run.busy(), run.streaming()], [false, false]);
	pi.emit("agent_start");
	pi.emit("message_start", { message: { role: "user" } });
	assert.deepEqual([run.busy(), run.streaming()], [true, false], "the user's prompt is not the model writing");
	pi.emit("message_start", { message: { role: "assistant" } });
	assert.equal(run.streaming(), true);
	pi.emit("message_end", { message: { role: "toolResult" } });
	assert.equal(run.streaming(), true, "a tool result does not end the reply");
	pi.emit("message_end", { message: { role: "assistant" } });
	assert.deepEqual([run.busy(), run.streaming()], [true, false], "between replies the run goes on");
	pi.emit("message_start", { message: { role: "assistant" } });
	pi.emit("agent_end");
	assert.deepEqual([run.busy(), run.streaming()], [false, false], "an aborted reply may never end its message");
	pi.emit("agent_start");
	pi.emit("message_start", { message: { role: "assistant" } });
	pi.emit("session_start");
	assert.deepEqual([run.busy(), run.streaming()], [false, false], "a new session starts idle");
});
