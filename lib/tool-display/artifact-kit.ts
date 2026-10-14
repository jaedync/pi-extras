/**
 * What the artifact rows share (artifact.ts): the `details` the artifact
 * extension gives each result, read defensively, and the lines every row
 * draws the same way: a page's link, when it expires, how its browser check
 * went, and a note when a check's image went to the model. The image itself
 * is never drawn: the row says it was sent, and the popup names the file.
 *
 * An older artifact extension gives `details: {}`. Then a row shows the
 * first lines of the text the model got, as any other tool's row does.
 */
import { SEP } from "../cc-phase.ts";
import { link } from "../kagi/render.ts";
import { sanitize } from "./format.ts";
import { errorLines, hasImage, head, more, plural, resultText, textLines, wrapAll, type Paint } from "./kit.ts";
import type { View } from "./tool.ts";

/** Lines of a result's text under the band when its details say nothing. */
export const TEXT_PREVIEW_LINES = 4;

export interface CheckRef {
	readonly state: "ok" | "problems" | "not_run" | "error";
	readonly problems: readonly string[];
	readonly error?: string;
	readonly sheet?: string;
}

export interface PageRef {
	readonly id: string;
	readonly title: string;
	readonly url: string;
	readonly inbox_url: string | null;
	readonly private: boolean;
	readonly expires_at: number | null;
	readonly role?: "form" | "page";
	readonly page?: number;
	readonly check: CheckRef;
}

export const flat = (text: unknown) => (typeof text === "string" ? sanitize(text).replace(/\s+/g, " ").trim() : "");
export const failed = (view: View) => !view.context.isPartial && view.context.isError;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** The result's details when they come from `tool` of a current artifact extension, else undefined. */
export function detailsOf<T>(view: View, tool: string): T | undefined {
	if (!view.result || view.context.isPartial || failed(view)) return undefined;
	const details = view.result.details;
	return record(details) && details.tool === tool ? (details as T) : undefined;
}

function checkOf(value: unknown): CheckRef {
	if (!record(value)) return { state: "not_run", problems: [] };
	const state = value.state === "ok" || value.state === "problems" || value.state === "error" ? value.state : "not_run";
	const problems = Array.isArray(value.problems) ? value.problems.map(flat).filter(Boolean) : [];
	return { state, problems, ...(typeof value.error === "string" ? { error: flat(value.error) } : {}), ...(typeof value.sheet === "string" ? { sheet: value.sheet } : {}) };
}

/** A page from details, or undefined when it has no id and no address to show. */
export function pageOf(value: unknown): PageRef | undefined {
	if (!record(value) || typeof value.id !== "string" || typeof value.url !== "string") return undefined;
	return {
		id: flat(value.id),
		title: flat(value.title),
		url: value.url,
		inbox_url: typeof value.inbox_url === "string" ? value.inbox_url : null,
		private: value.private === true,
		expires_at: typeof value.expires_at === "number" && Number.isFinite(value.expires_at) ? value.expires_at : null,
		...(value.role === "form" || value.role === "page" ? { role: value.role } : {}),
		...(typeof value.page === "number" ? { page: value.page } : {}),
		check: checkOf(value.check),
	};
}

export function pagesOf(value: unknown): PageRef[] {
	return Array.isArray(value) ? value.map(pageOf).filter((page): page is PageRef => page !== undefined) : [];
}

/** A private page opens only in the owner's inbox, so its inbox link is the one to show. */
export const shownUrl = (page: PageRef) => flat(page.private && page.inbox_url ? page.inbox_url : page.url);

/** `label  https://…`, the address in the accent and a link where the terminal has them. */
export function urlLine(paint: Paint, page: PageRef, label = ""): string {
	const url = shownUrl(page);
	return `${label ? paint.fg("muted", label) : ""}${link(paint.fg("accent", url), url)}`;
}

/** How long until it expires, in the coarsest unit that says enough: `in 14d`, `in 5h`, `in 20m`. */
export function expiryText(expiresAt: number | null, nowMs: number): string {
	if (expiresAt === null) return "no expiry";
	const left = expiresAt * 1000 - nowMs;
	if (left <= 0) return "expired";
	const minutes = Math.ceil(left / 60_000);
	if (minutes < 120) return `expires in ${minutes}m`;
	const hours = Math.round(minutes / 60);
	return hours < 48 ? `expires in ${hours}h` : `expires in ${Math.round(hours / 24)}d`;
}

/** The check in a few words, in the color of how it went. */
export function checkFact(paint: Paint, check: CheckRef, name = "check"): string {
	if (check.state === "problems") return paint.fg("warning", `${name}: ${plural(check.problems.length, "problem")}`);
	if (check.state === "error") return paint.fg("warning", `${name} could not run`);
	if (check.state === "not_run") return paint.fg("dim", `${name}: not run`);
	return paint.fg("muted", `${name}: no problems`);
}

export function facts(paint: Paint, parts: readonly string[]): string {
	return parts.filter(Boolean).join(paint.fg("dim", SEP));
}

/** How many images the model got with the result. */
export function imageCount(view: View): number {
	const content = view.result?.content;
	return view.result && hasImage(view.result) && Array.isArray(content) ? content.filter((block) => record(block) && block.type === "image").length : 0;
}

/** Said in place of the image, which a row never draws. */
export function sentNote(paint: Paint, count: number): string {
	return count > 0 ? paint.fg("dim", count === 1 ? "check image sent to the model" : `${count} check images sent to the model`) : "";
}

/** Each problem of each page, and where each kept image is, for the expanded row and the popup. */
export function problemLines(paint: Paint, pages: readonly PageRef[], named: boolean): string[] {
	return pages.flatMap((page) => [
		...page.check.problems.map((problem) => paint.fg("warning", `${named ? `${page.role ?? `page ${page.page ?? ""}`.trim()}: ` : ""}${problem}`)),
		...(page.check.error ? [paint.fg("warning", `check could not run: ${page.check.error}`)] : []),
		...(page.check.sheet ? [paint.fg("dim", `check image: ${flat(page.check.sheet)}`)] : []),
	]);
}

/** Before structured details, or for an older artifact extension: the first lines of the text. */
export function textBody(view: View, width: number): string[] {
	if (failed(view)) return wrapAll(errorLines(view.paint, resultText(view.result)), width);
	if (!view.result || view.context.isPartial) return [];
	const lines = wrapAll(textLines(resultText(view.result)).map((line) => view.paint.fg("toolOutput", line)), width);
	if (view.context.expanded) return lines;
	return head(lines, TEXT_PREVIEW_LINES, (hidden) => more(view.paint, view.kit, plural(hidden, "more line")));
}

/** The popup's output: what the row knows, then the whole text the model got, dimmed. */
export function popupOutput(view: View, width: number, own: readonly string[]): string[] {
	if (failed(view)) return wrapAll(errorLines(view.paint, resultText(view.result)), width);
	if (!view.result || view.context.isPartial) return [view.paint.fg("dim", "(working…)")];
	const said = textLines(resultText(view.result)).map((line) => view.paint.fg("dim", line));
	return wrapAll(own.length > 0 ? [...own, "", view.paint.fg("muted", "what the model got"), ...said] : said, width);
}
