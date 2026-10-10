/** A fetch stand-in for pull_link tests: routes by URL, records each call and its user agent. */
import { parseConfig } from "../../lib/link-context/config.ts";
import type { AdapterContext, PullOptions } from "../../lib/link-context/types.ts";

export type Route = (url: string, init: RequestInit) => Response | undefined;

export function fakeFetch(...routes: Route[]): { fetcher: typeof fetch; calls: { url: string; agent: string }[] } {
	const calls: { url: string; agent: string }[] = [];
	const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
		const url = String(input);
		calls.push({ url, agent: String((init.headers as Record<string, string> | undefined)?.["User-Agent"]) });
		for (const route of routes) {
			const response = route(url, init);
			if (response) return response;
		}
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	return { fetcher, calls };
}

export const json = (match: string | RegExp, body: unknown, status = 200): Route => (url) => ((typeof match === "string" ? url.includes(match) : match.test(url)) ? Response.json(body, { status }) : undefined);
export const html = (match: string | RegExp, body: string): Route => (url) => ((typeof match === "string" ? url.includes(match) : match.test(url)) ? new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } }) : undefined);

export function context(fetcher: typeof fetch, options: Partial<PullOptions> = {}): AdapterContext & { notes: string[] } {
	const notes: string[] = [];
	return { fetcher, config: parseConfig({}), options: { comments: 5, transcript: false, frames: 0, images: false, ...options }, progress: (text) => notes.push(text), notes };
}
