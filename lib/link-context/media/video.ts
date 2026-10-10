/**
 * Videos on YouTube, TikTok, Instagram, Vimeo and every other site yt-dlp
 * reads: metadata and description, a timestamped transcript (captions first,
 * local speech-to-text when there are none), top comments, and sampled frames.
 * Downloads are kept per URL for a while, so asking for frames after the
 * transcript does not fetch the video twice.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderReplies, type Reply } from "../post.ts";
import { clock, isoDate, stats, type Range } from "../text.ts";
import type { AdapterContext, ImageBlock, Pulled } from "../types.ts";
import { extractFrames, sampleTimes, type FrameResult, type FrameSource } from "./frames.ts";
import { fetchImages } from "./images.ts";
import { ensureAsr, ensureMedia, type Toolchain } from "./provision.ts";
import { runHelper } from "./run.ts";
import { getJson, PLAIN_UA } from "../http.ts";
import { parseUrl } from "../url.ts";

const KEEP_PULLS_MS = 2 * 86_400_000;
const MAX_DESCRIPTION = 6_000;
/** Videos up to this length are fetched whole for frames, and kept for later calls. */
const WHOLE_VIDEO_SECONDS = 600;
/** The clip cut around each `at` time: a little before, so the frame is never the clip's first. */
const CLIP_BEFORE = 0.5;
const CLIP_AFTER = 1.5;
const INSPECT_HEIGHT = 720;
/** Past this, a failed clip download is reported instead of fetching hours of video. */
const MAX_WHOLE_FALLBACK_SECONDS = 3 * 3600;
/** Speech-to-text past this length takes too long for one tool call; a range still works. */
const MAX_ASR_SECONDS = 3 * 3600;
const PARAGRAPH_SECONDS = 30;

export interface VideoInfo {
	id?: string;
	title?: string;
	uploader?: string;
	channel?: string;
	upload_date?: string;
	timestamp?: number;
	duration?: number;
	view_count?: number;
	like_count?: number;
	comment_count?: number;
	description?: string;
	webpage_url?: string;
	extractor_key?: string;
	chapters?: { start_time?: number; end_time?: number; title?: string }[] | null;
	live_status?: string;
	thumbnail?: string;
	has_video?: boolean;
	subtitles?: string[];
	automatic_captions?: string[];
	comments?: { id?: string; parent?: string; author?: string; text?: string; likes?: number; timestamp?: number; pinned?: boolean }[];
	warnings?: string[];
}

export interface Segment { start: number; end: number; text: string }
export interface Transcript { source?: string; language?: string; segments: Segment[]; errors?: string[] }

export interface VideoDeps {
	readonly ensure: typeof ensureMedia;
	readonly ensureAsr: typeof ensureAsr;
	readonly run: typeof runHelper;
	readonly frames: typeof extractFrames;
	readonly images: typeof fetchImages;
	readonly home?: string;
}

const DEFAULT_DEPS: VideoDeps = { ensure: ensureMedia, ensureAsr, run: runHelper, frames: extractFrames, images: fetchImages };

export function header(info: VideoInfo, url: string): string {
	const facts = [info.channel ?? info.uploader, isoDate(info.upload_date ?? info.timestamp), info.duration ? clock(info.duration) : undefined, info.live_status && info.live_status !== "not_live" ? info.live_status : undefined].filter(Boolean).join(" · ");
	const counts = stats([["views", info.view_count], ["likes", info.like_count], ["comments", info.comment_count]]);
	const lines = [`# ${info.title ?? "Untitled video"}`, facts, counts, info.webpage_url ?? url].filter(Boolean);
	const description = (info.description ?? "").trim();
	if (description) lines.push("", "## Description", "", description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION)}…` : description);
	if (info.chapters?.length) lines.push("", "## Chapters", "", ...info.chapters.map((c) => `- ${clock(c.start_time ?? 0)} ${c.title ?? ""}`));
	return lines.join("\n");
}

/** The short heading for a call that asks only for frames at given times. */
export function brief(info: VideoInfo, url: string): string {
	const facts = [info.channel ?? info.uploader, isoDate(info.upload_date ?? info.timestamp), info.duration ? clock(info.duration) : undefined].filter(Boolean).join(" · ");
	return [`# ${info.title ?? "Untitled video"}`, facts, info.webpage_url ?? url].filter(Boolean).join("\n");
}

/** YouTube's 480x360 thumbnail is enough to recognise the video and costs far less than the full one. */
export function thumbnailUrl(info: VideoInfo): string | undefined {
	if (info.extractor_key === "Youtube" && info.id && /^[\w-]{11}$/.test(info.id)) return `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`;
	return info.thumbnail && /^https:\/\//.test(info.thumbnail) ? info.thumbnail : undefined;
}

function within(range: Range | undefined, at: number): boolean {
	return !range || (at >= range.start && (range.end === undefined || at < range.end));
}

/** Paragraphs of about 30 s, each led by its start time, with chapter headings where they begin. */
export function formatTranscript(transcript: Transcript, chapters: VideoInfo["chapters"], range?: Range): string {
	const segments = transcript.segments.filter((s) => within(range, s.start) && s.text.trim());
	const marks = [...(chapters ?? [])].filter((c) => c.title).sort((a, b) => (a.start_time ?? 0) - (b.start_time ?? 0));
	const out: string[] = [];
	let paragraph: string[] = [];
	let paraStart = 0;
	let chapter = 0;
	const flush = () => {
		if (paragraph.length) out.push(`[${clock(paraStart)}] ${paragraph.join(" ").replace(/\s+/g, " ").trim()}`);
		paragraph = [];
	};
	for (const segment of segments) {
		while (chapter < marks.length && (marks[chapter].start_time ?? 0) <= segment.start) {
			flush();
			out.push(`### ${marks[chapter].title}`);
			chapter++;
		}
		if (paragraph.length && segment.start - paraStart >= PARAGRAPH_SECONDS && /[.!?…"')\]]$/.test(paragraph.at(-1) ?? "")) flush();
		if (paragraph.length && segment.start - paraStart >= PARAGRAPH_SECONDS * 2) flush();
		if (!paragraph.length) paraStart = segment.start;
		paragraph.push(segment.text.replace(/\n/g, " ").trim());
	}
	flush();
	return out.join("\n\n");
}

export function videoComments(info: VideoInfo, limit: number): string {
	const all = info.comments ?? [];
	const replies: Reply[] = [];
	const children = new Map<string, typeof all>();
	for (const c of all) if (c.parent && c.parent !== "root") children.set(c.parent, [...(children.get(c.parent) ?? []), c]);
	for (const root of all.filter((c) => !c.parent || c.parent === "root")) {
		if (replies.length >= limit) break;
		const post = (c: (typeof all)[number]) => ({ author: c.author ?? "unknown", date: isoDate(c.timestamp), text: c.text ?? "", stats: [stats([["likes", c.likes]]), c.pinned ? "pinned" : ""].filter(Boolean).join(" · ") });
		replies.push({ post: post(root), depth: 0 });
		for (const child of children.get(root.id ?? "") ?? []) if (replies.length < limit) replies.push({ post: post(child), depth: 1 });
	}
	return renderReplies(replies, info.comment_count).replace(/^## Replies/, "## Comments");
}

export function pullDir(home: string, url: string): string {
	const id = createHash("sha256").update(url).digest("hex").slice(0, 16);
	return join(home, "pulls", id);
}

/** Old pull directories go; failures are ignored because another session may be using one. */
export function prunePulls(home: string, now = Date.now()): void {
	const root = join(home, "pulls");
	if (!existsSync(root)) return;
	for (const name of readdirSync(root)) {
		const dir = join(root, name);
		try {
			if (now - statSync(dir).mtimeMs > KEEP_PULLS_MS) rmSync(dir, { recursive: true, force: true });
		} catch {
			// another session removed or is writing it
		}
	}
}

function cached<T>(file: string): T | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

const rangeKey = (range: Range | undefined) => (range ? `${range.start}-${range.end ?? ""}` : "all");

type Section = readonly [number, number | undefined];
interface MediaFile { path: string; start: number }

/** The clip that holds `at`: the one starting latest at or before it. */
export function clipFor(files: readonly MediaFile[], at: number): MediaFile | undefined {
	return [...files].filter((file) => file.start <= at + 0.01 && at - file.start <= CLIP_BEFORE + CLIP_AFTER).sort((a, b) => b.start - a.start)[0];
}

/** A short, collision-free folder name for a request key of any length. */
export function keyName(prefix: string, key: string): string {
	return key.length <= 40 && /^[\w.-]+$/.test(key) ? `${prefix}-${key}` : `${prefix}-${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

class VideoJob {
	readonly tools: Toolchain;
	readonly dir: string;
	readonly url: string;
	readonly ctx: AdapterContext;
	readonly deps: VideoDeps;

	constructor(tools: Toolchain, dir: string, url: string, ctx: AdapterContext, deps: VideoDeps) {
		this.tools = tools;
		this.dir = dir;
		this.url = url;
		this.ctx = ctx;
		this.deps = deps;
	}

	private common() {
		return { proxy: this.ctx.config.proxy, cookies: this.ctx.config.cookies };
	}

	run<T>(command: string, request: Record<string, unknown>, timeoutMs: number): Promise<T> {
		return this.deps.run<T>(this.tools, command, { ...this.common(), ...request }, { signal: this.ctx.signal, timeoutMs, cwd: this.dir });
	}

	async info(): Promise<VideoInfo> {
		const comments = this.ctx.options.comments;
		const file = join(this.dir, `info-${comments}.json`);
		// Details read with more comments serve a call that wants fewer.
		const wider = readdirSync(this.dir).map((name) => /^info-(\d+)\.json$/.exec(name)).filter((m): m is RegExpExecArray => !!m && Number(m[1]) >= comments).sort((a, b) => Number(a[1]) - Number(b[1]))[0];
		const hit = wider ? cached<VideoInfo>(join(this.dir, wider[0])) : undefined;
		if (hit) return comments < Number(wider?.[1]) ? { ...hit, comments: hit.comments?.slice(0, comments) } : hit;
		this.ctx.progress(comments ? "reading video details and comments" : "reading video details");
		const info = await this.run<VideoInfo>("info", { url: this.url, comments }, comments ? 240_000 : 120_000);
		writeFileSync(file, JSON.stringify(info));
		return info;
	}

	/** Kept per kind, height and sections in the pull folder, so a later call reuses it. */
	async download(kind: "video" | "audio", sections: readonly Section[] | undefined, maxHeight: number): Promise<MediaFile[]> {
		const key = sections ? sections.map(([a, b]) => `${a}-${b ?? ""}`).join("_") : "all";
		const dir = join(this.dir, kind === "video" ? keyName(`video-h${maxHeight}`, key) : keyName("audio", key));
		const record = join(dir, "files.json");
		const hit = cached<MediaFile[]>(record);
		if (hit?.length && hit.every((file) => existsSync(file.path))) return hit;
		mkdirSync(dir, { recursive: true });
		this.ctx.progress(`downloading ${kind}${sections ? ` (${sections.length === 1 ? `${clock(sections[0][0])}-${sections[0][1] !== undefined ? clock(sections[0][1]) : "end"}` : `${sections.length} clips`})` : ""}`);
		const result = await this.run<{ files: MediaFile[] }>("download", { url: this.url, kind, maxHeight, dir, sections }, 900_000);
		writeFileSync(record, JSON.stringify(result.files));
		return result.files;
	}

	/** A whole video already downloaded by an earlier call, at any height. */
	wholeVideo(): MediaFile | undefined {
		for (const name of readdirSync(this.dir).filter((entry) => /^video-h\d+-all$/.test(entry)).sort().reverse()) {
			const files = cached<MediaFile[]>(join(this.dir, name, "files.json"));
			if (files?.[0] && existsSync(files[0].path)) return files[0];
		}
		return undefined;
	}

	async transcript(info: VideoInfo): Promise<Transcript> {
		const file = join(this.dir, "transcript.json");
		const hit = cached<Transcript>(file);
		if (hit?.segments.length) return hit;
		this.ctx.progress("reading captions");
		const youtube = info.extractor_key === "Youtube";
		const captionsDir = join(this.dir, "captions");
		mkdirSync(captionsDir, { recursive: true });
		let transcript = await this.run<Transcript>("captions", { url: this.url, videoId: youtube ? info.id : undefined, dir: captionsDir }, 180_000);
		if (!transcript.segments.length) {
			const range = this.ctx.options.range;
			const span = (range?.end ?? info.duration ?? 0) - (range?.start ?? 0);
			if (span > MAX_ASR_SECONDS) return { ...transcript, errors: [...(transcript.errors ?? []), `No captions, and ${clock(span)} is too long to transcribe in one call; pass a range of 3 hours or less.`] };
			const [audio] = await this.download("audio", range ? [[range.start, range.end]] : undefined, 0);
			const plan = await this.deps.ensureAsr(this.tools, this.ctx.progress, this.ctx.signal);
			this.ctx.progress(`transcribing speech with ${plan.backend}`);
			const heard = await this.run<Transcript>("asr", { path: audio.path, backend: plan.backend, model: this.ctx.config.asrModel ?? plan.model }, 3_600_000);
			transcript = { ...heard, segments: heard.segments.map((s) => ({ ...s, start: s.start + audio.start, end: s.end + audio.start })), errors: transcript.errors };
			if (range) return transcript;
		}
		writeFileSync(file, JSON.stringify(transcript));
		return transcript;
	}

	/**
	 * Where each frame comes from: a whole video already at hand, a short video
	 * fetched whole (and kept for later calls), or one exact 2 s clip per time,
	 * so a few frames of a long video never download all of it.
	 */
	private async sources(info: VideoInfo, times: readonly number[]): Promise<FrameSource[]> {
		const duration = info.duration ?? 0;
		const whole = this.wholeVideo() ?? (duration > 0 && duration <= WHOLE_VIDEO_SECONDS ? (await this.download("video", undefined, INSPECT_HEIGHT))[0] : undefined);
		if (whole) return times.map((at) => ({ video: whole.path, at, offset: 0 }));
		const sections = times.map((at) => [Math.max(0, at - CLIP_BEFORE), at + CLIP_AFTER] as const);
		const clips = await this.download("video", sections, INSPECT_HEIGHT).catch(async (error: Error) => {
			// Cutting clips needs an ffmpeg that can read from the network; without one, fetch the video once, small.
			if (duration > MAX_WHOLE_FALLBACK_SECONDS) throw error;
			this.ctx.progress("clips failed; downloading the whole video at 360p");
			return this.download("video", undefined, 360);
		});
		return times.map((at) => {
			const clip = clips.length === 1 && clips[0].start === 0 ? clips[0] : clipFor(clips, at);
			if (!clip) throw new Error(`no clip was downloaded for ${clock(at)}`);
			return { video: clip.path, at, offset: clip.start };
		});
	}

	async frames(info: VideoInfo, times: readonly number[], name: string): Promise<FrameResult> {
		const sources = await this.sources(info, times);
		const ffmpeg = (await this.run<{ path: string }>("ffmpeg", {}, 60_000)).path;
		this.ctx.progress("cutting frames");
		const compose = (request: object) => this.run("compose", { ...request }, 120_000);
		return this.deps.frames(ffmpeg, sources, join(this.dir, name), compose, this.ctx.signal);
	}
}

const AT_HINT = '_To look at a moment, call pull_link again with this URL and at: ["m:ss", ...] for the frames at those times._';

async function transcriptSection(job: VideoJob, info: VideoInfo, ctx: AdapterContext): Promise<string> {
	const transcript = await job.transcript(info).catch((error: Error) => ({ segments: [], errors: [error.message] }) as Transcript);
	const body = formatTranscript(transcript, info.chapters, ctx.options.range);
	if (!body) return `## Transcript\n\nNo transcript: ${(transcript.errors ?? ["no captions or speech found"]).join("; ")}`;
	const label = [transcript.source, transcript.language].filter(Boolean).join(", ");
	const span = ctx.options.range ? ` (${clock(ctx.options.range.start)}-${ctx.options.range.end !== undefined ? clock(ctx.options.range.end) : "end"})` : "";
	return `## Transcript${span}${label ? `\n_${label}_` : ""}\n\n${body}${info.has_video === false ? "" : `\n\n${AT_HINT}`}`;
}

/** The sample times for `frames`: evenly over the range, or the whole video. */
export function sampleFor(count: number, duration: number | undefined, range: Range | undefined): number[] {
	const end = Math.min(range?.end ?? Number.POSITIVE_INFINITY, duration || Number.POSITIVE_INFINITY);
	const start = range?.start ?? 0;
	if (!Number.isFinite(end)) return [start];
	return sampleTimes(start, end, count);
}

/** Times inside the video, without repeats; the ones past the end are named in a note. */
export function validTimes(at: readonly number[], duration: number | undefined): { times: number[]; dropped: number[] } {
	const unique = [...new Set(at)].sort((a, b) => a - b);
	if (!duration) return { times: unique, dropped: [] };
	return { times: unique.filter((t) => t < duration), dropped: unique.filter((t) => t >= duration) };
}

/** A watch URL's video id, for the oEmbed fallback and the caption client when yt-dlp is refused. */
export function youtubeId(url: string): string | undefined {
	const parsed = new URL(url);
	const id = parsed.hostname === "youtu.be" ? parsed.pathname.slice(1) : parsed.searchParams.get("v") ?? /^\/(?:shorts|live|embed)\/([\w-]{11})/.exec(parsed.pathname)?.[1];
	return id && /^[\w-]{11}$/.test(id) ? id : undefined;
}

/** yt-dlp's words when YouTube refuses the host itself, as opposed to one video. */
export const HOST_BLOCKED = /confirm you.?re not a bot|HTTP Error (?:403|429)\b|Too Many Requests/i;
const AGE_GATE = /confirm your age|age.restricted|inappropriate for some users/i;

const BLOCKED_NOTE = "YouTube refused this host (it blocks most datacenter IP addresses). Set `linkContext.proxy` or `linkContext.cookies` in pi-extras.json; see the Pull Link section of the pi-extras README.";

/**
 * When yt-dlp is refused, YouTube's oEmbed still names the video, and the
 * caption client may still work, so the call returns what it can.
 */
async function blockedInfo(url: string, error: Error, ctx: AdapterContext): Promise<VideoInfo & { blocked: string }> {
	const id = youtubeId(url);
	if (!id) throw error;
	const oembed = await getJson<{ title?: string; author_name?: string }>(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`, { signal: ctx.signal, fetcher: ctx.fetcher, agents: [PLAIN_UA] }).catch(() => ({}) as { title?: string; author_name?: string });
	return { id, title: oembed.title, channel: oembed.author_name, extractor_key: "Youtube", webpage_url: `https://www.youtube.com/watch?v=${id}`, has_video: true, blocked: `${BLOCKED_NOTE} (${error.message.slice(0, 200)})` };
}

export async function pullVideo(url: string, site: string, ctx: AdapterContext, deps: VideoDeps = DEFAULT_DEPS): Promise<Pulled> {
	// URLs from posts come from third-party JSON; they get the same check as a link the user gave.
	url = parseUrl(url).href;
	const tools = await deps.ensure({ refreshDays: ctx.config.refreshDays, progress: ctx.progress, signal: ctx.signal, home: deps.home });
	prunePulls(tools.home);
	const dir = pullDir(tools.home, url);
	mkdirSync(dir, { recursive: true });
	const job = new VideoJob(tools, dir, url, ctx, deps);
	const info: VideoInfo & { blocked?: string } = await job.info().catch((error: Error) => {
		if (site === "youtube" && AGE_GATE.test(error.message)) throw new Error(`This video is age-restricted, so YouTube needs a signed-in account. Set linkContext.cookies to a cookies.txt file from a signed-in browser. (${error.message.slice(0, 200)})`);
		if (site !== "youtube" || !HOST_BLOCKED.test(error.message)) throw error;
		return blockedInfo(url, error, ctx);
	});
	const at = ctx.options.at ?? [];
	// A call for frames at given times follows a transcript the agent already has; it gets the frames and little else.
	const inspecting = at.length > 0 && !ctx.options.transcript;
	const parts = [inspecting ? brief(info, url) : header(info, url)];
	const notes: string[] = info.blocked ? [info.blocked] : [];
	const images: ImageBlock[] = [];
	let files: string[] | undefined;
	// Frames show the video already; the thumbnail is for a text-only call.
	const thumbnail = !at.length && !ctx.options.frames && ctx.options.images ? thumbnailUrl(info) : undefined;
	if (thumbnail) {
		const [image] = await deps.images([thumbnail], { signal: ctx.signal, fetcher: ctx.fetcher });
		if (image) {
			images.push(image);
			parts[0] += "\n\n_The first image is the thumbnail._";
		}
	}
	if (ctx.options.transcript) parts.push(await transcriptSection(job, info, ctx));
	if (at.length && ctx.options.frames > 0) notes.push(`frames: ${ctx.options.frames} was ignored, because at names the times.`);
	if ((at.length || ctx.options.frames > 0) && info.blocked) notes.push("Frames need a download, which YouTube refused.");
	else if (at.length || ctx.options.frames > 0) {
		if (info.has_video === false) notes.push("This link has no video stream, so there are no frames.");
		else {
			try {
				const wanted = at.length ? at : sampleFor(ctx.options.frames, info.duration, ctx.options.range);
				const { times, dropped } = validTimes(wanted, info.duration);
				if (dropped.length) notes.push(`${dropped.map(clock).join(", ")} ${dropped.length === 1 ? "is" : "are"} past the end of the video (${clock(info.duration ?? 0)}).`);
				const name = at.length ? keyName("at", times.join("_")) : keyName("frames", `${rangeKey(ctx.options.range)}-${times.length}`);
				const frames = times.length ? await job.frames(info, times, name) : undefined;
				if (frames) {
					images.push(...frames.images);
					files = frames.files;
					parts.push(`## Frames\n\n${frames.caption}\nFull-size frames: ${dirOf(frames.files)}`);
				}
			} catch (error) {
				notes.push(`Frames failed: ${(error as Error).message}`);
			}
		}
	}
	if (ctx.options.comments > 0) {
		const rendered = videoComments(info, ctx.options.comments);
		parts.push(rendered || "## Comments\n\nNo comments were returned.");
	}
	if (!tools.serverHome && site === "youtube") notes.push("The YouTube PO-token provider is not installed, so YouTube may refuse downloads. See provision.log in the media folder.");
	if (notes.length) parts.push(notes.map((note) => `_${note}_`).join("\n"));
	return { platform: site === "file" ? "video" : site, title: info.title ?? url, url: info.webpage_url ?? url, markdown: parts.join("\n\n"), images, files };
}

function dirOf(files: readonly string[]): string {
	return files.length ? files[0].replace(/\/[^/]+$/, "/") : "";
}
