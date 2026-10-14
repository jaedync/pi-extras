/**
 * The rows of the artifact tools that read: artifact_feedback (what the
 * owner answered or commented) and artifact_find (earlier artifacts). Both
 * count what came back in the band, and list it one line each under it.
 */
import type { Seg } from "../band/band.ts";
import { SEP } from "../cc-phase.ts";
import { detailsOf, facts, flat, popupOutput, textBody } from "./artifact-kit.ts";
import { more, mutedSeg, numberArg, plural, resultText, stringArg, textLines, titleSeg, wrapAll } from "./kit.ts";
import type { ToolSpec, View } from "./tool.ts";

/** Lines listed under the band before `… N more`. */
export const LIST_PREVIEW = 3;

interface ChangeRef {
	readonly kind: string;
	readonly artifact_id: string;
	readonly title: string;
}

interface FeedbackDetails {
	readonly tool: "feedback";
	readonly mode?: "new" | "read" | "reply";
	readonly changes?: readonly unknown[];
	readonly again?: readonly unknown[];
	readonly waited?: number;
	readonly watched?: number;
	readonly id?: string;
	readonly answers?: number;
	readonly threads?: number;
	readonly thread?: number;
	readonly resolved?: boolean;
}

interface HitRef {
	readonly id: string;
	readonly title: string;
	readonly kind: string;
	readonly match: string;
	readonly rev?: number;
	readonly snippet: string;
}

interface FindDetails {
	readonly tool: "find";
	readonly mode?: "search" | "read";
	readonly hits?: readonly unknown[];
	readonly more?: boolean;
	readonly title?: string;
	readonly kind?: string;
	readonly url?: string;
	readonly offset?: number;
	readonly end?: number;
	readonly total?: number;
	readonly rev?: number;
	readonly current?: number;
	readonly answers?: number;
	readonly threads?: number;
}

const changesOf = (value: unknown): ChangeRef[] => (Array.isArray(value) ? value : []).flatMap((item) => {
	const c = item as Partial<ChangeRef> | null;
	return c && typeof c.kind === "string" && typeof c.artifact_id === "string" ? [{ kind: flat(c.kind), artifact_id: flat(c.artifact_id), title: flat(c.title) }] : [];
});

const hitsOf = (value: unknown): HitRef[] => (Array.isArray(value) ? value : []).flatMap((item) => {
	const h = item as Partial<HitRef> | null;
	return h && typeof h.id === "string" && typeof h.title === "string"
		? [{ id: flat(h.id), title: flat(h.title), kind: flat(h.kind), match: flat(h.match), snippet: flat(h.snippet), ...(typeof h.rev === "number" ? { rev: h.rev } : {}) }] : [];
});

/** `2 answers, 1 comment`, from a list of changes. */
function tally(changes: readonly ChangeRef[]): string {
	const answers = changes.filter((c) => c.kind === "answer").length;
	const comments = changes.length - answers;
	return [answers ? plural(answers, "answer") : "", comments ? plural(comments, "comment") : ""].filter(Boolean).join(SEP);
}

function list(view: View, lines: readonly string[], noun: string, all: boolean): string[] {
	const shown = all || lines.length <= LIST_PREVIEW + 1 ? lines : lines.slice(0, LIST_PREVIEW);
	const hidden = lines.length - shown.length;
	return hidden > 0 ? [...shown, more(view.paint, view.kit, plural(hidden, `more ${noun}`))] : [...shown];
}

const changeLine = (view: View, change: ChangeRef) => `${view.paint.fg("accent", change.kind)}  ${view.paint.fg("toolOutput", change.title || change.artifact_id)}`;

function feedbackLines(view: View, details: FeedbackDetails, all: boolean): string[] {
	if (details.mode === "read") {
		return [facts(view.paint, [view.paint.fg("toolOutput", plural(details.answers ?? 0, "answer")), view.paint.fg("toolOutput", plural(details.threads ?? 0, "open thread"))])];
	}
	if (details.mode === "reply") return textLines(resultText(view.result)).slice(0, 1).map((line) => view.paint.fg("muted", line));
	const changes = changesOf(details.changes);
	if (changes.length > 0) return list(view, changes.map((change) => changeLine(view, change)), "change", all);
	const again = changesOf(details.again);
	const head = facts(view.paint, [view.paint.fg("muted", `nothing new${details.waited ? ` in ${details.waited}s` : ""}`),
		view.paint.fg("dim", `watching ${plural(details.watched ?? 0, "artifact")}`)]);
	return [head, ...(again.length > 0 ? list(view, again.map((change) => view.paint.fg("dim", `sent before: ${change.kind}  ${change.title || change.artifact_id}`)), "earlier change", all) : [])];
}

export const feedbackSpec: ToolSpec = {
	name: "artifact_feedback",
	label: () => "artifact_feedback",
	title(view) {
		const id = flat(stringArg(view.context.args, "id"));
		const thread = numberArg(view.context.args, "reply_to");
		const wait = numberArg(view.context.args, "wait_seconds");
		const subject: Seg[] = thread !== undefined ? [{ text: ` reply to thread ${thread}`, color: "accent" }, ...(id ? [mutedSeg(` on ${id}`)] : [])]
			: id ? [{ text: ` ${id}`, color: "accent" }] : wait ? [mutedSeg(` waits up to ${wait}s`)] : [];
		const details = detailsOf<FeedbackDetails>(view, "feedback");
		const changes = details?.mode === "new" ? changesOf(details.changes) : [];
		const summary = details?.mode === "new" ? (changes.length > 0 ? tally(changes) : "nothing new") : "";
		return [titleSeg("feedback"), ...subject, ...(summary ? [mutedSeg(`${SEP}${summary}`)] : [])];
	},
	body(view, width) {
		const details = detailsOf<FeedbackDetails>(view, "feedback");
		return details ? wrapAll(feedbackLines(view, details, view.context.expanded), width) : textBody(view, width);
	},
	outputLabel: () => "result",
	output(view, width) {
		const details = detailsOf<FeedbackDetails>(view, "feedback");
		return popupOutput(view, width, details ? feedbackLines(view, details, true) : []);
	},
};

function hitLine(view: View, hit: HitRef): string {
	const where = hit.match === "answer" || hit.match === "comment" ? hit.match : hit.match === "version" ? `version ${hit.rev ?? ""}`.trim() : "";
	return `${view.paint.fg("toolOutput", hit.title || hit.id)}  ${view.paint.fg("dim", [hit.kind, where].filter(Boolean).join(SEP))}  ${view.paint.fg("muted", hit.snippet)}`;
}

function findLines(view: View, details: FindDetails, all: boolean): string[] {
	if (details.mode === "read") {
		const chars = typeof details.total === "number" && (details.offset || details.more)
			? `characters ${details.offset ?? 0} to ${details.end ?? 0} of ${details.total}` : "";
		const old = details.rev !== undefined && details.current !== undefined && details.rev !== details.current ? `version ${details.rev} of ${details.current}` : "";
		const url = flat(details.url);
		return [
			...(url ? [view.paint.fg("accent", url)] : []),
			facts(view.paint, [details.kind ? view.paint.fg("muted", flat(details.kind)) : "", ...[old, chars].map((part) => (part ? view.paint.fg("muted", part) : "")),
				view.paint.fg("muted", plural(details.answers ?? 0, "answer")), view.paint.fg("muted", plural(details.threads ?? 0, "open thread"))]),
		];
	}
	const hits = hitsOf(details.hits);
	if (hits.length === 0) return [view.paint.fg("dim", (details.offset ?? 0) > 0 ? "no more results" : "no results")];
	// One line each: a hit's snippet is cut at the width rather than wrapped.
	return list(view, hits.map((hit) => hitLine(view, hit)), "result", all);
}

export const findSpec: ToolSpec = {
	name: "artifact_find",
	label: () => "artifact_find",
	title(view) {
		const query = flat(stringArg(view.context.args, "query"));
		const id = flat(stringArg(view.context.args, "id"));
		const details = detailsOf<FindDetails>(view, "find");
		if (id || details?.mode === "read") {
			const title = details?.mode === "read" ? flat(details.title) : "";
			return [titleSeg("read artifact"), { text: ` ${title || id || "…"}`, color: "accent" }];
		}
		const hits = details?.mode === "search" ? hitsOf(details.hits).length : undefined;
		const count = hits === undefined ? "" : hits === 0 ? "no results" : `${plural(hits, "result")}${details?.more ? ", more" : ""}`;
		return [titleSeg("find artifacts"), { text: ` ${query || "…"}`, color: "accent" }, ...(count ? [mutedSeg(`${SEP}${count}`)] : [])];
	},
	body(view, width) {
		const details = detailsOf<FindDetails>(view, "find");
		if (!details) return textBody(view, width);
		const lines = findLines(view, details, view.context.expanded);
		// Search hits stay one line each; tool.ts cuts each at the width.
		return details.mode === "read" ? wrapAll(lines, width) : lines;
	},
	outputLabel: () => "result",
	output(view, width) {
		const details = detailsOf<FindDetails>(view, "find");
		return popupOutput(view, width, details ? findLines(view, details, true) : []);
	},
};
