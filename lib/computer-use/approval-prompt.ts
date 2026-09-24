/**
 * The dialog shown when the Computer Use client asks to let the agent use an
 * app. Laid out like Pi's own selectors, but with the app, the risk and the
 * choices styled separately so the warning reads as a warning. The first
 * choice is "Don't allow", and escape means the same.
 */
import { matchesKey, truncateToWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { hints, rule, type Paint } from "./paint.ts";
import type { Approval, ApprovalRequest } from "./session.ts";

interface Choice {
	readonly label: string;
	readonly answer: Approval;
	readonly note?: string;
}

const CHOICES: readonly Choice[] = [
	{ label: "Don't allow", answer: "deny" },
	{ label: "Allow for this session", answer: "once" },
	{ label: "Always allow", answer: "always", note: "also applies to ChatGPT and Codex computer use" },
];

export class ApprovalPrompt implements Component {
	private readonly request: ApprovalRequest;
	private readonly paint: Paint;
	private readonly done: (answer: Approval) => void;
	private readonly choices: readonly Choice[];
	private selected = 0;
	private finished = false;

	constructor(request: ApprovalRequest, paint: Paint, done: (answer: Approval) => void) {
		this.request = request;
		this.paint = paint;
		this.done = done;
		this.choices = CHOICES.filter((choice) => choice.answer !== "always" || request.canRemember);
	}

	render(width: number): string[] {
		const { paint, request } = this;
		const inner = Math.max(10, width - 2);
		const title = request.app
			? `${paint.bold("Allow the agent to use ")}${paint.fg("accent", paint.bold(request.app))}${paint.bold("?")}`
			: paint.bold(`Computer Use asks: ${request.message}`);
		const body: string[] = [...wrapTextWithAnsi(title, inner)];
		if (request.warning) {
			const label = request.highRisk ? `${paint.fg("warning", paint.bold("High risk"))}  ` : "";
			body.push("", ...wrapTextWithAnsi(`${label}${paint.fg("text", request.warning)}`, inner));
		}
		body.push("");
		this.choices.forEach((choice, index) => {
			const note = choice.note ? `  ${paint.fg("muted", choice.note)}` : "";
			body.push(index === this.selected ? `${paint.fg("accent", `→ ${choice.label}`)}${note}` : `  ${paint.fg("text", choice.label)}${note}`);
		});
		body.push("", hints(paint, [["↑↓", "navigate"], ["enter", "select"], ["esc", "don't allow"]]));
		return [rule(paint, width), "", ...body.map((line) => truncateToWidth(line ? ` ${line}` : "", width, "…")), "", rule(paint, width)];
	}

	handleInput(data: string): void {
		if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
		else if (matchesKey(data, "down")) this.selected = Math.min(this.choices.length - 1, this.selected + 1);
		else if (matchesKey(data, "enter")) this.finish(this.choices[this.selected].answer);
		else if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) this.finish("deny");
	}

	/** Also called when the call is cancelled, so the dialog closes with a refusal. */
	finish(answer: Approval): void {
		if (this.finished) return;
		this.finished = true;
		this.done(answer);
	}

	invalidate(): void {}
}
