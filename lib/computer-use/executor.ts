/**
 * computer_use({ code }): the agent writes a short script against `sky`, so a
 * known sequence of actions runs without a model round-trip between each one.
 * Only what the script emits returns to the conversation.
 */
import { Worker } from "node:worker_threads";
import type { CallOptions, ContentBlock, SkySession } from "./session.ts";

export const METHODS = [
	"list_apps", "get_app_state", "click", "perform_secondary_action", "set_value",
	"select_text", "scroll", "drag", "press_key", "type_text",
] as const;

const WORKER = new URL("./code-worker.mjs", import.meta.url);
const MAX_CODE_CHARS = 20_000;
const MAX_CALLS = 50;
const MAX_IMAGES = 10;
/** Screenshots stay here; the script only sees handles. Old ones are dropped past this many. */
const MAX_SCREENSHOTS = 50;
/** Script time allowed between Computer Use calls; time inside a call does not count. */
const DEFAULT_SLICE_MS = 5_000;
/** Emitted text beyond this is clipped: an unfiltered accessibility tree can be enormous. */
const DEFAULT_MAX_TEXT_CHARS = 50_000;
const WORKER_START_MS = 5_000;

type Image = Extract<ContentBlock, { type: "image" }>;

export interface ExecutorOptions {
	readonly session: Pick<SkySession, "call">;
	readonly sliceMs?: number;
	readonly maxTextChars?: number;
}

export interface RunOptions {
	readonly approve: CallOptions["approve"];
	readonly signal?: AbortSignal;
}

export interface CodeResult {
	readonly content: ContentBlock[];
	readonly calls: string[];
	readonly error?: string;
}

type WorkerMessage =
	| { type: "ready" }
	| { type: "call"; id: number; method: string; args: string }
	| { type: "emit"; value: string }
	| { type: "emit_image"; value: string }
	| { type: "done"; store?: string; error?: string };

export class CodeExecutor {
	private readonly options: ExecutorOptions;
	private readonly screenshots = new Map<string, Image>();
	private nextScreenshot = 1;
	private store: Record<string, unknown> = {};
	private queue: Promise<unknown> = Promise.resolve();

	constructor(options: ExecutorOptions) {
		this.options = options;
	}

	execute(code: string, options: RunOptions): Promise<CodeResult> {
		const run = this.queue.then(() => this.run(code, options));
		this.queue = run.catch(() => {});
		return run;
	}

	private run(code: string, options: RunOptions): Promise<CodeResult> {
		if (code.length > MAX_CODE_CHARS) return Promise.reject(new Error(`computer_use code is over ${MAX_CODE_CHARS} characters`));
		return new Promise((resolve, reject) => {
			const worker = new Worker(WORKER, { workerData: { code, store: this.store, methods: METHODS } });
			const run = new Run(this.options, options, worker, (key) => this.screenshots.get(key), (image) => this.keepScreenshot(image));
			run.settle = (outcome) => {
				options.signal?.removeEventListener("abort", abort);
				void worker.terminate();
				if (outcome instanceof Error) reject(outcome);
				else {
					if (outcome.store) this.store = outcome.store;
					resolve(outcome.result);
				}
			};
			const abort = () => run.fail(new Error("Computer Use code cancelled"));
			if (options.signal?.aborted) return abort();
			options.signal?.addEventListener("abort", abort, { once: true });
			worker.on("message", (message: WorkerMessage) => run.handle(message).catch((error: unknown) => run.fail(error instanceof Error ? error : new Error(String(error)))));
			worker.once("error", (error) => run.fail(error));
			worker.once("exit", (code) => run.fail(new Error(`Computer Use code worker exited early (${code})`)));
			run.startTimer(WORKER_START_MS, "the code worker did not start");
		});
	}

	private keepScreenshot(image: Image): { type: "screenshot"; id: string } {
		const id = String(this.nextScreenshot++);
		this.screenshots.set(id, image);
		if (this.screenshots.size > MAX_SCREENSHOTS) this.screenshots.delete(this.screenshots.keys().next().value!);
		return { type: "screenshot", id };
	}
}

type Outcome = Error | { result: CodeResult; store?: Record<string, unknown> };

/** One script execution: its output, its call budget and its time slice. */
class Run {
	settle: (outcome: Outcome) => void = () => {};
	private readonly content: ContentBlock[] = [];
	private readonly calls: string[] = [];
	private readonly sliceMs: number;
	private readonly maxTextChars: number;
	private textChars = 0;
	private clippedChars = 0;
	private images = 0;
	private timer?: NodeJS.Timeout;
	private settled = false;
	private readonly executor: ExecutorOptions;
	private readonly options: RunOptions;
	private readonly worker: Worker;
	private readonly screenshot: (id: string) => Image | undefined;
	private readonly keep: (image: Image) => object;

	constructor(executor: ExecutorOptions, options: RunOptions, worker: Worker, screenshot: (id: string) => Image | undefined, keep: (image: Image) => object) {
		this.executor = executor;
		this.options = options;
		this.worker = worker;
		this.screenshot = screenshot;
		this.keep = keep;
		this.sliceMs = executor.sliceMs ?? DEFAULT_SLICE_MS;
		this.maxTextChars = executor.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS;
	}

	startTimer(ms: number, reason: string): void {
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.stop(reason), ms);
	}

	fail(error: Error): void {
		if (this.settled) return;
		this.settled = true;
		clearTimeout(this.timer);
		this.settle(error);
	}

	async handle(message: WorkerMessage): Promise<void> {
		if (this.settled) return;
		if (message.type === "ready") this.startTimer(this.sliceMs, `the code ran over ${this.sliceMs} ms between Computer Use calls`);
		else if (message.type === "emit") this.emitText(JSON.parse(message.value));
		else if (message.type === "emit_image") this.emitImage(JSON.parse(message.value).id);
		else if (message.type === "call") await this.call(message);
		else this.finish(message.error, message.store ? JSON.parse(message.store) : undefined);
	}

	private emitText(value: unknown): void {
		const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
		const room = Math.max(0, this.maxTextChars - this.textChars);
		if (text.length > room) this.clippedChars += text.length - room;
		const kept = text.slice(0, room);
		this.textChars += kept.length;
		if (kept.length > 0 || room > 0) this.content.push({ type: "text", text: kept });
	}

	private emitImage(id: string): void {
		const image = this.screenshot(id);
		if (!image) return this.stop("that screenshot is no longer available; take a new one");
		if (++this.images > MAX_IMAGES) return this.stop(`the code emitted more than ${MAX_IMAGES} images`);
		this.content.push(image);
	}

	private async call(message: Extract<WorkerMessage, { type: "call" }>): Promise<void> {
		if (this.calls.length >= MAX_CALLS) return this.reply(message.id, { error: `the code made more than ${MAX_CALLS} Computer Use calls` });
		clearTimeout(this.timer);
		this.calls.push(message.method);
		try {
			const args = JSON.parse(message.args) as Record<string, unknown>;
			const result = await this.executor.session.call(message.method, args, { approve: this.options.approve, signal: this.options.signal });
			const text = result.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n");
			if (result.isError) throw new Error(text || `${message.method} failed`);
			let value: unknown = text || null;
			if (message.method === "get_app_state") {
				const image = result.content.find((block): block is Image => block.type === "image");
				value = { app: args.app, text, screenshot: image ? this.keep(image) : null };
			}
			this.reply(message.id, { value: JSON.stringify(value) });
		} catch (error) {
			this.reply(message.id, { error: error instanceof Error ? error.message : String(error) });
		} finally {
			if (!this.settled) this.startTimer(this.sliceMs, `the code ran over ${this.sliceMs} ms between Computer Use calls`);
		}
	}

	private reply(id: number, payload: { value: string } | { error: string }): void {
		if (!this.settled) this.worker.postMessage({ id, ...payload });
	}

	private stop(reason: string): void {
		this.finish(reason);
	}

	private finish(error?: string, store?: Record<string, unknown>): void {
		if (this.settled) return;
		this.settled = true;
		clearTimeout(this.timer);
		const content = [...this.content];
		if (this.clippedChars > 0) content.push({ type: "text", text: `[${this.clippedChars} more characters clipped; emit only what you need]` });
		if (error) content.push({ type: "text", text: `Computer Use code stopped: ${error}` });
		this.settle({ result: { content, calls: [...this.calls], ...(error ? { error } : {}) }, store });
	}
}
