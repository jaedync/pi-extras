/**
 * Decides which adapter reads a link. Classification is by host and path only,
 * so it never touches the network; Mastodon is the exception that cannot be
 * known from the URL, so its shape is a candidate that falls back to the web.
 */

export type Target =
	| { kind: "x"; id: string }
	| { kind: "bluesky"; actor: string; rkey: string }
	| { kind: "threads"; url: string }
	| { kind: "reddit"; path: string }
	| { kind: "reddit-share"; url: string }
	| { kind: "hackernews"; id: string }
	| { kind: "github"; owner: string; repo: string; rest: string[] }
	| { kind: "gist"; id: string }
	| { kind: "linkedin"; url: string }
	| { kind: "mastodon"; origin: string; id: string }
	| { kind: "video"; url: string; site: string }
	| { kind: "image"; url: string }
	| { kind: "web"; url: string };

export type Kind = Target["kind"];

const X_HOSTS = new Set(["x.com", "twitter.com", "mobile.twitter.com", "mobile.x.com", "fxtwitter.com", "vxtwitter.com", "fixupx.com", "fixvx.com", "nitter.net"]);
const REDDIT_HOSTS = /^(?:(?:www|old|new|np|m|i)\.)?reddit\.com$/;
const VIDEO_HOSTS: ReadonlyArray<[RegExp, string]> = [
	[/^(?:(?:www|m|music)\.)?youtube\.com$|^youtu\.be$|^(?:www\.)?youtube-nocookie\.com$/, "youtube"],
	[/^(?:(?:www|m|vm|vt)\.)?tiktok\.com$/, "tiktok"],
	[/^(?:(?:www|player)\.)?vimeo\.com$/, "vimeo"],
	[/^(?:(?:www|clips|m)\.)?twitch\.tv$/, "twitch"],
	[/^(?:www\.)?dailymotion\.com$|^dai\.ly$/, "dailymotion"],
	[/^(?:www\.)?loom\.com$/, "loom"],
	[/^(?:www\.)?streamable\.com$/, "streamable"],
];
const IMAGE_FILE = /\.(?:jpe?g|png|webp|gif)$/i;
const IMAGE_HOSTS = new Set(["i.imgur.com", "i.redd.it", "preview.redd.it", "pbs.twimg.com"]);
const MEDIA_FILE = /\.(?:mp4|m4v|mov|webm|mkv|gifv|mp3|m4a|wav|ogg|opus|flac)$/i;
/** imgur image ids mix cases or digits; its own pages are plain lower-case words. */
export const IMGUR_ID = /^\/(?=[A-Za-z]*[0-9A-Z])[A-Za-z0-9]{5,10}$/;

/** Rejects anything that is not a plain public http(s) URL before any request is made. */
export function parseUrl(raw: string): URL {
	const text = raw.trim().replace(/^<|>$/g, "");
	let url: URL;
	try {
		url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
	} catch {
		throw new Error(`Not a valid URL: ${raw.slice(0, 200)}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error(`Only http and https links are supported, not ${url.protocol}`);
	if (url.username || url.password) throw new Error("Links with embedded credentials are refused.");
	if (isPrivateHost(url.hostname)) throw new Error(`Refusing a private or local address: ${url.hostname}`);
	return url;
}

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home", ".home.arpa", ".localdomain", ".intranet", ".corp"];

function privateV4(a: number, b: number, c: number): boolean {
	return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19));
}

/**
 * Literal private, loopback, link-local, multicast and reserved addresses,
 * and local names. DNS is not resolved, so a public name that points at a
 * private address still passes; this stops the links an untrusted post can
 * plant, not a hostile DNS server.
 */
export function isPrivateHost(host: string): boolean {
	const name = host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.+$/, "");
	if (!name || name === "localhost" || LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix)) || (!name.includes(".") && !name.includes(":"))) return true;
	const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(name);
	if (v4) return privateV4(Number(v4[1]), Number(v4[2]), Number(v4[3]));
	if (!name.includes(":")) return false;
	if (name === "::1" || name === "::" || /^f[cd]/.test(name) || /^fe[89ab]/.test(name) || /^ff/.test(name)) return true;
	// IPv4 inside IPv6: mapped (::ffff:), compatible (::a.b.c.d or ::7f00:1), NAT64 (64:ff9b::) and 6to4 (2002:).
	if (/^::(?:ffff:)?[0-9a-f.:]+$/.test(name) || name.startsWith("64:ff9b:") || name.startsWith("2002:")) return true;
	// Teredo (2001:0::/32) carries an IPv4 address too.
	if (/^2001:(?:0{1,4})?:/.test(name)) return true;
	return false;
}

/** Path parts, decoded; a malformed escape leaves the part as it is rather than failing the link. */
function segments(url: URL): string[] {
	return url.pathname.split("/").filter(Boolean).map((part) => {
		try {
			return decodeURIComponent(part);
		} catch {
			return part;
		}
	});
}

function classifyX(parts: string[]): Target | undefined {
	const index = parts.findIndex((part) => part === "status" || part === "statuses");
	const id = index >= 0 ? parts[index + 1] : undefined;
	return id && /^\d{1,25}$/.test(id) ? { kind: "x", id } : undefined;
}

function classifyReddit(url: URL, parts: string[]): Target | undefined {
	if (url.hostname === "redd.it" && parts[0]) return { kind: "reddit", path: `/comments/${parts[0]}` };
	if (parts[0] === "r" && parts[2] === "s" && parts[3]) return { kind: "reddit-share", url: url.href };
	const at = parts.indexOf("comments");
	// Up to the slug and an optional comment id: a comment permalink reads that comment's subtree.
	if (at >= 0 && parts[at + 1]) return { kind: "reddit", path: `/${parts.slice(0, at + 4).join("/")}` };
	return undefined;
}

function classifyGithub(url: URL, parts: string[]): Target | undefined {
	if (url.hostname === "gist.github.com") {
		const id = parts.at(-1);
		return id && /^[0-9a-f]{6,}$/i.test(id) ? { kind: "gist", id } : undefined;
	}
	if (parts.length < 2 || ["orgs", "settings", "marketplace", "topics", "search", "notifications", "login"].includes(parts[0])) return undefined;
	return { kind: "github", owner: parts[0], repo: parts[1].replace(/\.git$/, ""), rest: parts.slice(2) };
}

export function classify(url: URL): Target {
	const name = url.hostname.toLowerCase();
	const bare = name.replace(/^www\./, "");
	const parts = segments(url);
	if (X_HOSTS.has(bare)) {
		const target = classifyX(parts);
		if (target) return target;
	}
	if (bare === "bsky.app" && parts[0] === "profile" && parts[2] === "post" && parts[1] && parts[3]) return { kind: "bluesky", actor: parts[1], rkey: parts[3] };
	if ((bare === "threads.net" || bare === "threads.com") && parts[1] === "post") return { kind: "threads", url: url.href };
	if (REDDIT_HOSTS.test(name) || name === "redd.it") {
		const target = classifyReddit(url, parts);
		if (target) return target;
	}
	if (bare === "news.ycombinator.com" && parts[0] === "item") {
		const id = url.searchParams.get("id");
		if (id && /^\d+$/.test(id)) return { kind: "hackernews", id };
	}
	if (bare === "github.com" || bare === "gist.github.com") {
		const target = classifyGithub(url, parts);
		if (target) return target;
	}
	if (bare === "linkedin.com" || bare.endsWith(".linkedin.com")) {
		if (["posts", "feed", "pulse"].includes(parts[0] ?? "")) return { kind: "linkedin", url: url.href };
	}
	if (bare === "instagram.com" && ["p", "reel", "reels", "tv"].includes(parts[0] ?? "")) return { kind: "video", url: url.href, site: "instagram" };
	if (MEDIA_FILE.test(url.pathname)) return { kind: "video", url: url.href, site: "file" };
	if (IMAGE_FILE.test(url.pathname) || IMAGE_HOSTS.has(name)) return { kind: "image", url: url.href };
	if ((bare === "imgur.com" || bare === "m.imgur.com") && IMGUR_ID.test(url.pathname)) return { kind: "image", url: `https://i.imgur.com${url.pathname}.jpg` };
	for (const [pattern, site] of VIDEO_HOSTS) if (pattern.test(name)) return { kind: "video", url: url.href, site };
	if (MEDIA_FILE.test(url.pathname)) return { kind: "video", url: url.href, site: "file" };
	const toot = /^@[\w.-]+$/.test(parts[0] ?? "") && /^\d{6,25}$/.test(parts[1] ?? "") ? parts[1] : parts[0] === "users" && parts[2] === "statuses" && /^\d+$/.test(parts[3] ?? "") ? parts[3] : undefined;
	if (toot) return { kind: "mastodon", origin: url.origin, id: toot };
	return { kind: "web", url: url.href };
}
