/**
 * The artifact tools' rows (artifact_publish, artifact_ask, artifact_check,
 * artifact_feedback, artifact_find), from the artifact extension that
 * Dotfleet installs. Each band says what the call does in a word, the way
 * Pi's own rows do (`publish`, `ask`, `check`), with what it is about after
 * it. Under the band sit the page's address, when it expires and how its
 * browser check went, each on one line; ctrl+o adds every problem and where
 * the check's image is kept, and the popup has all of that and the text the
 * model got. A check's image is never drawn in the row (see adopt.ts): it
 * cost the chat its smoothness and a screen of blank space.
 */
import { basename } from "node:path";
import type { Seg } from "../band/band.ts";
import { SEP } from "../cc-phase.ts";
import { plainText, UNWRAPPED } from "../band/popup.ts";
import {
	checkFact, detailsOf, expiryText, facts, failed, flat, imageCount, pageOf, pagesOf, popupOutput, problemLines, sentNote, shownUrl, textBody, urlLine,
	type PageRef,
} from "./artifact-kit.ts";
import { feedbackSpec, findSpec } from "./artifact-read.ts";
import { more, mutedSeg, plural, resultText, stringArg, titleSeg, wrapAll } from "./kit.ts";
import type { ToolSpec, View } from "./tool.ts";

/** Pages listed under a split gallery's band before `… N more pages`. */
export const PAGE_PREVIEW = 2;

interface PublishDetails {
	readonly tool: "publish";
	readonly update?: boolean;
	readonly template?: string | null;
	readonly watching?: boolean;
	readonly pages?: unknown;
	readonly wrote?: string;
}

interface AskDetails {
	readonly tool: "ask";
	readonly questions?: number;
	readonly watching?: boolean;
	readonly form?: unknown;
	readonly page?: unknown;
}

interface CheckDetails {
	readonly tool: "check";
	readonly problems?: readonly unknown[];
	readonly sheet?: string | null;
}

const argOf = (view: View, key: string) => flat(stringArg(view.context.args, key));
const flag = (view: View, key: string) => !!view.context.args && typeof view.context.args === "object" && (view.context.args as Record<string, unknown>)[key] === true;

/** What a publish is about: its title, else the file, else the template. */
function publishSubject(view: View): string {
	const path = argOf(view, "path");
	return argOf(view, "title") || (path ? basename(path) : "") || argOf(view, "template") || (argOf(view, "markdown") ? "report" : "page");
}

/** The facts a call says before it runs: a private page, a new version of an old one. The expiry is under the band. */
function callFacts(view: View): Seg[] {
	return [
		...(flag(view, "private") ? [mutedSeg(`${SEP}private`)] : []),
		...(argOf(view, "update") ? [mutedSeg(`${SEP}new version`)] : []),
	];
}

/** The line under the address: the expiry, the check, and an image sent to the model. */
function factLine(view: View, pages: readonly PageRef[], extra: readonly string[] = []): string {
	const expiry = pages[0] ? view.paint.fg("muted", expiryText(pages[0].expires_at, view.now)) : "";
	// Pages whose checks all ended alike, with no problems, need one word for all of them.
	const named = pages.length > 1 && !pages.every((page) => page.check.state === pages[0]!.check.state && page.check.problems.length === 0);
	const checks = named ? pages.map((page) => checkFact(view.paint, page.check, `${page.role ?? `page ${page.page ?? ""}`.trim()} check`))
		: [checkFact(view.paint, pages[0]?.check ?? { state: "not_run", problems: [] })];
	return facts(view.paint, [expiry, ...checks, ...extra, sentNote(view.paint, imageCount(view))]);
}

/** ctrl+o shows the problems and the kept image; collapsed, a hint stands in for them when there are some. */
function expandable(view: View, pages: readonly PageRef[], width: number): string[] {
	const lines = problemLines(view.paint, pages, pages.length > 1);
	if (lines.length === 0) return [];
	// A single problem shows in the row a hint for it would take.
	if (view.context.expanded) return wrapAll(lines, width);
	if (pages.reduce((sum, page) => sum + page.check.problems.length, 0) === 1) return wrapAll(lines.filter((line) => !line.includes("check image: ")), width);
	const problems = pages.reduce((sum, page) => sum + page.check.problems.length, 0);
	return problems > 0 ? [more(view.paint, view.kit, plural(problems, "problem"))] : [];
}

function publishLines(view: View, details: PublishDetails, all: boolean): string[] {
	if (typeof details.wrote === "string") return [`${view.paint.fg("muted", "wrote ")}${view.paint.fg("accent", flat(details.wrote))}`];
	const pages = pagesOf(details.pages);
	if (pages.length === 0) return [];
	const label = (page: PageRef) => (pages.length > 1 ? `page ${page.page ?? pages.indexOf(page) + 1}  ` : "");
	const listed = all || pages.length <= PAGE_PREVIEW + 1 ? pages : pages.slice(0, PAGE_PREVIEW);
	const hidden = pages.length - listed.length;
	return [
		...listed.map((page) => urlLine(view.paint, page, label(page))),
		...(hidden > 0 ? [more(view.paint, view.kit, plural(hidden, "more page"))] : []),
		factLine(view, pages, [details.watching === false ? view.paint.fg("dim", "watch off") : ""]),
	];
}

export const publishSpec: ToolSpec = {
	name: "artifact_publish",
	label: () => "artifact_publish",
	title(view) {
		const details = detailsOf<PublishDetails>(view, "publish");
		const pages = pagesOf(details?.pages);
		return [titleSeg("publish"), { text: ` ${publishSubject(view)}`, color: "accent" }, ...callFacts(view),
			...(pages.length > 1 ? [mutedSeg(`${SEP}${plural(pages.length, "page")}`)] : [])];
	},
	body(view, width) {
		const details = detailsOf<PublishDetails>(view, "publish");
		if (!details) return textBody(view, width);
		return [...wrapAll(publishLines(view, details, view.context.expanded), width), ...expandable(view, pagesOf(details.pages), width)];
	},
	details: (view) => [argOf(view, "template") ? `template ${argOf(view, "template")}` : "", argOf(view, "update") ? `update ${argOf(view, "update")}` : ""].filter(Boolean).join(SEP),
	outputLabel: () => "result",
	output(view, width) {
		const details = detailsOf<PublishDetails>(view, "publish");
		const own = details ? [...publishLines(view, details, true), ...problemLines(view.paint, pagesOf(details.pages), true)] : [];
		return popupOutput(view, width, own);
	},
	copies: (view) => copiesOf(view, pagesOf(detailsOf<PublishDetails>(view, "publish")?.pages)[0], publishSpec),
};

function askPages(details: AskDetails | undefined): PageRef[] {
	return [pageOf(details?.form), pageOf(details?.page)].filter((page): page is PageRef => page !== undefined);
}

function askLines(view: View, details: AskDetails): string[] {
	const pages = askPages(details);
	if (pages.length === 0) return [];
	const labelled = pages.length > 1;
	const watch = details.watching === false ? view.paint.fg("dim", "watch off") : view.paint.fg("muted", "watching for answers");
	return [...pages.map((page) => urlLine(view.paint, page, labelled ? `${page.role ?? "page"}  ` : "")), factLine(view, pages, [watch])];
}

export const askSpec: ToolSpec = {
	name: "artifact_ask",
	label: () => "artifact_ask",
	title(view) {
		const details = detailsOf<AskDetails>(view, "ask");
		const args = view.context.args as { questions?: unknown } | undefined;
		const count = typeof details?.questions === "number" ? details.questions : Array.isArray(args?.questions) ? args.questions.length : undefined;
		return [titleSeg("ask"), { text: ` ${argOf(view, "title") || "…"}`, color: "accent" },
			...(count !== undefined ? [mutedSeg(`${SEP}${plural(count, "question")}`)] : []), ...callFacts(view)];
	},
	body(view, width) {
		const details = detailsOf<AskDetails>(view, "ask");
		if (!details) return textBody(view, width);
		return [...wrapAll(askLines(view, details), width), ...expandable(view, askPages(details), width)];
	},
	details: (view) => (argOf(view, "update") ? `update ${argOf(view, "update")}` : ""),
	outputLabel: () => "result",
	output(view, width) {
		const details = detailsOf<AskDetails>(view, "ask");
		return popupOutput(view, width, details ? [...askLines(view, details), ...problemLines(view.paint, askPages(details), true)] : []);
	},
	copies: (view) => copiesOf(view, askPages(detailsOf<AskDetails>(view, "ask"))[0], askSpec),
};

function checkProblems(details: CheckDetails | undefined): string[] {
	return (details?.problems ?? []).map(flat).filter(Boolean);
}

function checkLines(view: View, details: CheckDetails, all: boolean): string[] {
	const problems = checkProblems(details);
	const listed = all ? problems : problems.slice(0, 3);
	return [
		...listed.map((problem) => view.paint.fg("warning", problem)),
		...(problems.length > listed.length ? [more(view.paint, view.kit, plural(problems.length - listed.length, "more problem"))] : []),
		facts(view.paint, [sentNote(view.paint, imageCount(view))]),
		...(all && typeof details.sheet === "string" ? [view.paint.fg("dim", `check image: ${flat(details.sheet)}`)] : []),
	].filter(Boolean);
}

export const checkSpec: ToolSpec = {
	name: "artifact_check",
	label: () => "artifact_check",
	title(view) {
		const details = detailsOf<CheckDetails>(view, "check");
		const count = checkProblems(details).length;
		const summary: Seg[] = !details ? [] : count > 0 ? [{ text: `${SEP}${plural(count, "problem")}`, color: "warning" }] : [mutedSeg(`${SEP}no problems`)];
		return [titleSeg("check"), { text: ` ${argOf(view, "target") || "…"}`, color: "accent" }, ...summary];
	},
	body(view, width) {
		const details = detailsOf<CheckDetails>(view, "check");
		return details ? wrapAll(checkLines(view, details, view.context.expanded), width) : textBody(view, width);
	},
	outputLabel: () => "result",
	output(view, width) {
		const details = detailsOf<CheckDetails>(view, "check");
		return popupOutput(view, width, details ? checkLines(view, details, true) : []);
	},
};

/** The page's address, which is what the user most often wants to paste, and the whole output. */
function copiesOf(view: View, page: PageRef | undefined, spec: ToolSpec) {
	return [
		...(page && !failed(view) ? [{ label: "copy URL", key: "u", text: () => shownUrl(page) }] : []),
		{ label: "copy output", key: "o", text: () => plainText(spec.output(view, UNWRAPPED, 0)) || resultText(view.result) || undefined },
	];
}

/** The artifact tools with rows of their own, by name; the old names keep the generic band. */
export const ARTIFACT_SPECS: Readonly<Record<string, ToolSpec>> = {
	artifact_publish: publishSpec,
	artifact_ask: askSpec,
	artifact_check: checkSpec,
	artifact_feedback: feedbackSpec,
	artifact_find: findSpec,
};

/** Tools whose results carry check images, which their rows never draw. */
export const isArtifactTool = (name: string) => name.startsWith("artifact_");
