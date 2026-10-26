import type { Renderer } from "./browser.ts";
import type { Fetcher } from "./http.ts";
import type { Range } from "./text.ts";

export interface ImageBlock {
	readonly type: "image";
	readonly data: string;
	readonly mimeType: string;
}

export interface PullOptions {
	/** Most replies or comments to include; 0 leaves them out. */
	readonly comments: number;
	/** Video: include the spoken transcript. */
	readonly transcript: boolean;
	/** Video: frames to sample as images; 0 for none. */
	readonly frames: number;
	readonly range?: Range;
	/** Video: frames at exactly these times, in seconds. */
	readonly at?: readonly number[];
	/** Attach a post's photos as images. */
	readonly images: boolean;
	/** Video: transcribe speech when there are no captions (default true). Auto-pull reads captions only. */
	readonly speech?: boolean;
}

export interface LinkConfig {
	/** Per-adapter user-agent chains that replace the built-in ones. */
	readonly userAgents: Readonly<Record<string, readonly string[]>>;
	/** yt-dlp `--proxy`, for hosts whose IP the video sites block. */
	readonly proxy?: string;
	/** Netscape cookies.txt for yt-dlp, for hosts the video sites ask to sign in. */
	readonly cookies?: string;
	/** Speech-to-text model for videos without captions. */
	readonly asrModel?: string;
	/** Days between yt-dlp and PO-token provider upgrades. */
	readonly refreshDays: number;
	/** Read the links in each typed message before the model starts. */
	readonly autoPull: boolean;
	/** Read pages that refuse plain HTTP with a local browser: on, off, or the path of a browser. */
	readonly browser: boolean | string;
	/** Refuse pull_link and fetch_content calls to hosts that no user message, tool result or system prompt named. */
	readonly hostGuard: boolean;
	/** Providers whose models the host guard trusts. */
	readonly hostGuardExempt: readonly string[];
	/** Hosts (and their subdomains) the host guard always lets through. */
	readonly hostGuardAllow: readonly string[];
}

export interface AdapterContext {
	readonly signal?: AbortSignal;
	readonly fetcher?: Fetcher;
	readonly config: LinkConfig;
	readonly options: PullOptions;
	readonly progress: (text: string) => void;
	/** Replaces the local browser, for tests. */
	readonly render?: Renderer;
}

export interface Pulled {
	readonly platform: string;
	readonly title: string;
	readonly url: string;
	/** The whole result as markdown; the tool pages it when long. */
	readonly markdown: string;
	/** A few plain lines that say what the link is, for the transcript rows (summary.ts); the model never sees them. */
	readonly summary?: readonly string[];
	readonly images?: readonly ImageBlock[];
	/** Files saved beside the result, such as full-size frames. */
	readonly files?: readonly string[];
	/** Photo URLs to attach when images are wanted. */
	readonly photos?: readonly string[];
	/** A playable video in a post, for transcript and frames. */
	readonly videoUrl?: string;
	/** The video had no captions and speech was off, so a default call would give more. */
	readonly speechSkipped?: boolean;
}
