/** How the transcript rows name a link: its platform, a short URL, a failure's reason and its summary. */
import { proseLines, SUMMARY_LINES } from "./summary.ts";
import type { Pulled } from "./types.ts";

const NAMES: Readonly<Record<string, string>> = {
	x: "X", bluesky: "Bluesky", threads: "Threads", mastodon: "Mastodon", reddit: "Reddit", hackernews: "Hacker News",
	linkedin: "LinkedIn", github: "GitHub", image: "Image", video: "Video", youtube: "YouTube", tiktok: "TikTok",
	vimeo: "Vimeo", twitch: "Twitch", soundcloud: "SoundCloud", instagram: "Instagram",
};

export function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, "");
	} catch {
		return url;
	}
}

/** A platform by its real name; a web page by its host, which says more than "web". */
export function platformName(platform: string | undefined, url: string): string {
	if (!platform || platform === "web") return hostOf(url);
	return NAMES[platform] ?? `${platform.charAt(0).toUpperCase()}${platform.slice(1)}`;
}

/** The URL without its scheme, `www.` and a closing slash. */
export const shortUrl = (url: string) => url.replace(/^https?:\/\/(?:www\.)?/i, "").replace(/\/$/, "");

/** `httpbin.org answered HTTP 404` reads `HTTP 404` under a row that already names the host. */
export function reason(error: string, url: string): string {
	const host = hostOf(url).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return error.replace(/\s+/g, " ").trim().replace(new RegExp(`^${host} answered `, "i"), "");
}

/** The adapter's summary, else the first prose lines of the result. */
export function summaryOf(pulled: Pulled): string[] {
	if (pulled.summary?.length) return pulled.summary.slice(0, SUMMARY_LINES);
	return proseLines(pulled.markdown, pulled.title, SUMMARY_LINES);
}
