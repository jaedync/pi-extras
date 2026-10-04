/**
 * A child's session drawn the way Pi draws main's transcript, with Pi's own
 * message and tool row components. Tool Display, Copy Blocks and the thinking
 * tail patch those components, so a child's chat looks like main's in every
 * detail. A plain prompt (its task, or what you wrote) is a user message;
 * what other agents sent it reads as the conversation rows main shows
 * (transcript.ts).
 *
 * Components are made once per message and kept, as Pi keeps them, so a long
 * chat is not rebuilt every frame; a compaction, which replaces the messages,
 * rebuilds it. They sit in a pi-tui Container, which hands a click to the row
 * under it as main's transcript does, so a row expands or a code block copies here too.
 */
import {
	AssistantMessageComponent, CompactionSummaryMessageComponent, getMarkdownTheme, ToolExecutionComponent, UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { Container, Spacer, type Component, type TUI, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { readEnvelopes, type Envelope } from "./format.ts";
import { envelopeLines, type Painter, type Voices } from "./transcript.ts";

export interface ChatOptions {
	/** Pi's TUI, which tool rows ask to redraw while they load. */
	readonly tui: TUI;
	readonly cwd: string;
	/** The definition a tool's rows are drawn with; undefined leaves the row to Pi's plain look. */
	tool(name: string): object | undefined;
	readonly paint: Painter;
	voices(): Voices;
	readonly hideThinking?: boolean;
	/** Pi's left margin for chat text (`outputPad`). */
	readonly pad?: number;
}

interface Block { type?: string; text?: string; id?: string; name?: string; arguments?: unknown }
interface Message { role?: string; content?: unknown; stopReason?: string; errorMessage?: string; toolCallId?: string; isError?: boolean; details?: unknown }
type ToolResult = Parameters<ToolExecutionComponent["updateResult"]>[0];

const blocksOf = (content: unknown): Block[] =>
	typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? content as Block[] : [];

const textOf = (content: unknown): string =>
	blocksOf(content).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n").trim();

const failed = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Lines made at render time, so a delivery's rows follow the width as Pi's components do. */
class Lines implements Component {
	private readonly draw: (width: number) => string[];
	constructor(draw: (width: number) => string[]) { this.draw = draw; }
	render(width: number): string[] { return this.draw(width); }
	invalidate(): void {}
}

/** What a streaming reply holds now, cheaply: Pi rebuilds its Markdown on each update, so only real changes go through. */
const sizeOf = (message: Message): string => blocksOf(message.content).map((block) => `${block.type}:${JSON.stringify(block).length}`).join(",");

export class ChatLog {
	private shown: readonly unknown[] = [];
	private readonly parts = new Container();
	private readonly calls = new Map<string, ToolExecutionComponent>();
	private readonly answered = new Set<string>();
	private live: { component: AssistantMessageComponent; size: string } | undefined;
	private readonly options: ChatOptions;

	constructor(options: ChatOptions) {
		this.options = options;
	}

	/**
	 * Brings the chat up to `messages`, plus the reply being written now.
	 * `canFinish` is whether the agent can still finish a call; once it
	 * can't, calls left without a result say so instead of spinning.
	 */
	sync(messages: readonly unknown[], streaming: unknown, canFinish: boolean): void {
		if (messages.length < this.shown.length || this.shown.some((message, index) => messages[index] !== message)) this.reset();
		for (const message of messages.slice(this.shown.length)) this.add(message as Message);
		this.shown = [...messages];
		this.stream(streaming as Message | undefined, messages);
		if (!canFinish) for (const [id, row] of this.calls) if (!this.answered.has(id)) this.answer(id, row, failed("Stopped before this call returned."));
	}

	render(width: number): string[] {
		return this.parts.render(width);
	}

	/** A click on the chat, `y` counted from its first line, as `render` drew it last. */
	mouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return this.parts.handleMouse(event);
	}

	get empty(): boolean {
		return this.parts.children.length === 0;
	}

	private push(...parts: Component[]): void {
		const live = this.live?.component;
		if (live) this.parts.removeChild(live);
		for (const part of parts) this.parts.addChild(part);
		if (live) this.parts.addChild(live);
	}

	/** A gap before a message, as Pi leaves one, except at the very top. */
	private gap(): Component[] {
		return this.parts.children.length > 0 ? [new Spacer(1)] : [];
	}

	private reset(): void {
		this.shown = [];
		this.parts.clear();
		this.calls.clear();
		this.answered.clear();
		this.live = undefined;
	}

	private add(message: Message): void {
		switch (message.role) {
			case "user": return this.addUser(message);
			case "assistant": return this.addAssistant(message);
			case "toolResult": {
				const row = message.toolCallId ? this.calls.get(message.toolCallId) : undefined;
				if (row) this.answer(message.toolCallId!, row, { content: blocksOf(message.content) as ToolResult["content"], details: message.details, isError: message.isError === true });
				return;
			}
			case "compactionSummary":
				this.push(...this.gap(), new CompactionSummaryMessageComponent(message as never, getMarkdownTheme()));
				return;
			default:
		}
	}

	private addUser(message: Message): void {
		for (const part of readEnvelopes(textOf(message.content))) {
			this.push(...this.gap(), part.kind === "prompt" ? new UserMessageComponent(part.text, getMarkdownTheme(), this.pad) : this.envelope(part));
		}
	}

	private envelope(part: Exclude<Envelope, { kind: "prompt" }>): Component {
		const margin = " ".repeat(this.pad);
		return new Lines((width) => envelopeLines(part, Math.max(1, width - this.pad * 2), this.options.paint, this.options.voices()).map((line) => margin + line));
	}

	private addAssistant(message: Message): void {
		this.push(this.assistant(message));
		const ended = message.stopReason === "aborted" || message.stopReason === "error";
		for (const block of blocksOf(message.content)) {
			if (block.type !== "toolCall" || !block.id) continue;
			const row = new ToolExecutionComponent(block.name ?? "tool", block.id, block.arguments ?? {}, { showImages: false }, this.options.tool(block.name ?? "") as never, this.options.tui, this.options.cwd);
			row.setArgsComplete();
			row.markExecutionStarted();
			this.push(row);
			this.calls.set(block.id, row);
			// Pi marks the calls of a reply that failed or was stopped the same way.
			if (ended) this.answer(block.id, row, failed(message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error")));
		}
	}

	private answer(id: string, row: ToolExecutionComponent, result: ToolResult): void {
		this.answered.add(id);
		row.updateResult(result);
	}

	private assistant(message: Message): AssistantMessageComponent {
		return new AssistantMessageComponent(message as never, this.options.hideThinking ?? false, getMarkdownTheme(), undefined, this.pad);
	}

	/** The reply being written, until it joins the messages. */
	private stream(message: Message | undefined, messages: readonly unknown[]): void {
		if (!message || messages.includes(message)) {
			if (this.live) this.parts.removeChild(this.live.component);
			this.live = undefined;
			return;
		}
		const size = sizeOf(message);
		if (!this.live) {
			this.live = { component: this.assistant(message), size };
			this.parts.addChild(this.live.component);
		}
		else if (this.live.size !== size) this.live = { ...this.live, size };
		else return;
		this.live.component.updateContent(message as never, true);
	}

	private get pad(): number {
		return this.options.pad ?? 1;
	}
}
