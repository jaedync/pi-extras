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
}

export interface AdapterContext {
	readonly signal?: AbortSignal;
	readonly fetcher?: Fetcher;
	readonly config: LinkConfig;
	readonly options: PullOptions;
	readonly progress: (text: string) => void;
}

export interface Pulled {
	readonly platform: string;
	readonly title: string;
	readonly url: string;
	/** The whole result as markdown; the tool pages it when long. */
	readonly markdown: string;
	readonly images?: readonly ImageBlock[];
	/** Files saved beside the result, such as full-size frames. */
	readonly files?: readonly string[];
	/** Photo URLs to attach when images are wanted. */
	readonly photos?: readonly string[];
	/** A playable video in a post, for transcript and frames. */
	readonly videoUrl?: string;
}
