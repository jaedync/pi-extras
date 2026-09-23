// A scripted Anthropic Messages endpoint for staging real Pi screenshots.
// No model is called: each turn streams canned text and tool calls, and the
// responses carry the same limit headers and quota route a real proxy serves.
import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_PORT ?? 3499);
const TOKENS_PER_SECOND = Number(process.env.FAKE_TPS ?? 30);
const HOUR = 3_600_000;
const started = Date.now();

const quota = () => ({
	buckets: [
		{ type: "five_hour", status: "allowed", utilization: 0.31, resetsAt: started + 2.2 * HOUR },
		{ type: "seven_day", status: "allowed", utilization: 0.46, resetsAt: started + 61 * HOUR },
		{ type: "seven_day_opus", status: "allowed", utilization: 0.58, resetsAt: started + 61 * HOUR },
	],
	extraUsage: { isEnabled: false, monthlyLimit: 0, usedCredits: 0, currency: "USD" },
});

const limitHeaders = () => ({
	"anthropic-ratelimit-unified-5h-utilization": "0.31",
	"anthropic-ratelimit-unified-5h-reset": String(Math.round((started + 2.2 * HOUR) / 1000)),
	"anthropic-ratelimit-unified-7d-utilization": "0.46",
	"anthropic-ratelimit-unified-7d-reset": String(Math.round((started + 61 * HOUR) / 1000)),
});

const EDIT = {
	path: "lib/status-plus-footer.ts",
	edits: [{
		oldText: "const MODEL_CELL_MAX = 26;\n/** Below this the fourth column (place / cache) is dropped rather than mangled. */\nconst TAIL_CELL_MIN = 8;",
		newText: "/** Room for \"claude-opus-5-5 high\" without clipping the thinking level. */\nconst MODEL_CELL_MAX = 30;\n/** Below this the fourth column (place / cache) is dropped rather than mangled. */\nconst TAIL_CELL_MIN = 10;",
	}],
};

// One entry per assistant turn, chosen by how many assistant turns the request already holds.
const SCRIPT = [
	{
		thinking: "The suite takes about a minute. Start it and a type watcher as background jobs, then change the footer while they run.",
		text: "I'll run the suite and a type watcher in the background, then give the model cell more room while they go.",
		tools: [
			{ name: "shell_job_start", input: { command: "npm test", title: "Run unit tests" } },
			{ name: "shell_job_start", input: { command: "npx tsc -p . --watch --preserveWatchOutput", title: "Watch types" } },
		],
	},
	{
		thinking: "MODEL_CELL_MAX clips the thinking level at 26 columns. 30 fits it, and the tail cell needs two more columns to stay readable.",
		text: "Both jobs are running. The model cell clips at 26 columns, which cuts off the thinking level:",
		tools: [{ name: "edit", input: EDIT }],
	},
	{
		thinking: "Wait for the suite before claiming anything. Meanwhile explain the change and what the tests will confirm. ".repeat(18),
		text: "The cell now fits `claude-opus-5-5 high` at full width, and narrow terminals still drop the tail column before they clip the model. I'll confirm once **Run unit tests** finishes.",
		tools: [],
	},
];

const sse = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const words = (text) => text.match(/\S+\s*/g) ?? [];

async function drip(res, index, text, kind) {
	for (const word of words(text)) {
		if (res.destroyed) return;
		const delta = kind === "thinking" ? { type: "thinking_delta", thinking: word } : { type: "text_delta", text: word };
		sse(res, "content_block_delta", { index, delta });
		await sleep(1000 / TOKENS_PER_SECOND);
	}
}

async function streamTurn(res, turn, outputTokens) {
	let index = 0;
	await sleep(700);
	if (turn.thinking) {
		sse(res, "content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } });
		await drip(res, index, turn.thinking, "thinking");
		sse(res, "content_block_delta", { index, delta: { type: "signature_delta", signature: "staged" } });
		sse(res, "content_block_stop", { index });
		index++;
	}
	sse(res, "content_block_start", { index, content_block: { type: "text", text: "" } });
	await drip(res, index, turn.text, "text");
	sse(res, "content_block_stop", { index });
	index++;
	for (const [n, tool] of turn.tools.entries()) {
		sse(res, "content_block_start", { index, content_block: { type: "tool_use", id: `toolu_staged_${outputTokens}_${n}`, name: tool.name, input: {} } });
		const json = JSON.stringify(tool.input);
		for (let at = 0; at < json.length; at += 24) {
			sse(res, "content_block_delta", { index, delta: { type: "input_json_delta", partial_json: json.slice(at, at + 24) } });
			await sleep(12);
		}
		sse(res, "content_block_stop", { index });
		index++;
	}
	sse(res, "message_delta", { delta: { stop_reason: turn.tools.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: outputTokens } });
	sse(res, "message_stop", {});
	res.end();
}

createServer((req, res) => {
	if (req.method === "GET" && req.url?.startsWith("/v1/usage/quota")) {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify(quota()));
		return;
	}
	if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		const request = JSON.parse(body);
		const done = request.messages.filter((message) => message.role === "assistant").length;
		const turn = SCRIPT[Math.min(done, SCRIPT.length - 1)];
		const outputTokens = 180 + done * 140;
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...limitHeaders() });
		sse(res, "message_start", {
			message: {
				id: `msg_staged_${done}`, type: "message", role: "assistant", model: request.model, content: [],
				stop_reason: null, stop_sequence: null,
				usage: { input_tokens: 412 + done * 96, cache_read_input_tokens: 286_214 + done * 1_870, cache_creation_input_tokens: 1_204, output_tokens: 1 },
			},
		});
		streamTurn(res, turn, outputTokens).catch(() => res.destroy());
	});
}).listen(PORT, "127.0.0.1", () => console.log(`fake anthropic on ${PORT}`));
