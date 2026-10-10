import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { sampleTimes, sheetColumns } from "../lib/link-context/media/frames.ts";
import { sized } from "../lib/link-context/media/images.ts";
import { imageLink, imageLinks } from "../lib/link-context/media/images.ts";
import { asrPlan, bgutilDue, HELPER, packagesDue, PACKAGES, readState, toolEnv } from "../lib/link-context/media/provision.ts";
import { clipFor, HOST_BLOCKED, keyName, formatTranscript, header, prunePulls, pullDir, pullVideo, sampleFor, thumbnailUrl, validTimes, videoComments, youtubeId, type VideoDeps, type VideoInfo } from "../lib/link-context/media/video.ts";
import { writeFileSync } from "node:fs";
import { context } from "./support/link-fetch.ts";

test("frame times are spread evenly and centred in their slots", () => {
	assert.deepEqual(sampleTimes(0, 120, 4), [15, 45, 75, 105]);
	assert.deepEqual(sampleTimes(60, 90, 3), [65, 75, 85]);
	assert.equal(sampleTimes(0, 100, 500).length, 48);
	assert.deepEqual(sampleTimes(5, 5, 3), [5]);
	assert.deepEqual([1, 4, 5, 6, 7, 12].map(sheetColumns), [1, 4, 3, 3, 4, 4]);
});

test("X photos are asked for at the medium size", () => {
	assert.equal(sized("https://pbs.twimg.com/media/AbC.jpg"), "https://pbs.twimg.com/media/AbC?format=jpg&name=medium");
	assert.equal(sized("https://cdn.bsky.app/img/x.jpg"), "https://cdn.bsky.app/img/x.jpg");
});

test("packages refresh on schedule, on a changed list, and never when refresh is 0", () => {
	const day = 86_400_000;
	const list = PACKAGES.join(" ");
	assert.equal(packagesDue({}, 3, 10 * day), true);
	assert.equal(packagesDue({ packagesAt: 9 * day, packages: list }, 3, 10 * day), false);
	assert.equal(packagesDue({ packagesAt: 6 * day, packages: list }, 3, 10 * day), true);
	assert.equal(packagesDue({ packagesAt: 9 * day, packages: "yt-dlp" }, 3, 10 * day), true);
	assert.equal(packagesDue({ packagesAt: 1, packages: list }, 0, 10 * day), false);
	assert.equal(asrPlan("darwin", "arm64").backend, "mlx-whisper");
	assert.equal(asrPlan("linux", "x64").backend, "faster-whisper");
	assert.equal(asrPlan("darwin", "x64").backend, "faster-whisper");
});

const segments = [
	{ start: 0, end: 2, text: "Hello there." },
	{ start: 12, end: 14, text: "Second line" },
	{ start: 31, end: 33, text: "after thirty." },
	{ start: 61, end: 63, text: "In chapter two." },
	{ start: 95, end: 97, text: "Later." },
];

test("transcripts become timed paragraphs with chapter headings", () => {
	const chapters = [{ start_time: 0, title: "Intro" }, { start_time: 60, title: "Part two" }];
	assert.equal(formatTranscript({ segments }, chapters), "### Intro\n\n[0:00] Hello there. Second line after thirty.\n\n### Part two\n\n[1:01] In chapter two.\n\n[1:35] Later.");
	assert.equal(formatTranscript({ segments }, null, { start: 60, end: 90 }), "[1:01] In chapter two.");
});

test("video header and comments", () => {
	const info: VideoInfo = { title: "T", channel: "C", upload_date: "20261008", duration: 82, view_count: 12_345, webpage_url: "https://v.test/1", description: "D", chapters: [{ start_time: 5, title: "One" }], comment_count: 9, comments: [{ id: "a", parent: "root", author: "x", text: "top", likes: 3 }, { id: "b", parent: "a", author: "y", text: "reply" }, { id: "c", parent: "root", author: "z", text: "second", pinned: true }] };
	assert.equal(header(info, "https://v.test/1"), "# T\nC · 2026-10-08 · 1:22\n12.3K views · 9 comments\nhttps://v.test/1\n\n## Description\n\nD\n\n## Chapters\n\n- 0:05 One");
	assert.match(videoComments(info, 2), /^## Comments \(2 of 9\)\n\n- \*\*x\*\* · 3 likes\n  top\n  - \*\*y\*\*\n    reply$/);
	assert.match(videoComments(info, 5), /- \*\*z\*\* · pinned\n  second/);
});

test("old pull folders are pruned", () => {
	const home = mkdtempSync(join(tmpdir(), "link-prune-"));
	try {
		const old = pullDir(home, "https://a.test/1");
		const fresh = pullDir(home, "https://a.test/2");
		mkdirSync(old, { recursive: true });
		mkdirSync(fresh, { recursive: true });
		const past = new Date(Date.now() - 3 * 86_400_000);
		utimesSync(old, past, past);
		prunePulls(home);
		assert.equal(existsSync(old), false);
		assert.equal(existsSync(fresh), true);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

interface Recorded { log: string[]; downloads: Record<string, unknown>[]; sources: { video: string; at: number; offset: number }[][]; images: string[][] }

function fakeDeps(home: string, replies: Record<string, unknown>, seen: Recorded = { log: [], downloads: [], sources: [], images: [] }): VideoDeps {
	return {
		home,
		ensure: async () => ({ python: "py", helper: "h.py", node: "node", serverHome: "/srv", home }),
		ensureAsr: async () => ({ backend: "faster-whisper", model: "small" }),
		run: (async (_tools: unknown, command: string, request: Record<string, unknown>) => {
			seen.log.push(command);
			if (command === "download") {
				seen.downloads.push(request);
				mkdirSync(String(request.dir), { recursive: true });
				const sections = request.sections as [number, number][] | undefined;
				const files = (sections ?? [[0, 0]]).map(([start]) => ({ path: join(String(request.dir), `${request.kind}-${start}.mp4`), start: sections ? start : 0 }));
				for (const file of files) writeFileSync(file.path, "");
				return { files };
			}
			if (command === "info" && replies.info instanceof Error) throw replies.info;
			return replies[command];
		}) as VideoDeps["run"],
		frames: (async (_bin: string, sources: readonly { video: string; at: number; offset: number }[]) => {
			seen.sources.push([...sources]);
			return { images: sources.map(() => ({ type: "image" as const, data: "AA==", mimeType: "image/jpeg" })), files: ["/f/frame-01.jpg"], caption: `${sources.length} frames` };
		}) as VideoDeps["frames"],
		images: (async (urls: readonly string[]) => {
			seen.images.push([...urls]);
			return urls.map(() => ({ type: "image" as const, data: "TT==", mimeType: "image/jpeg" }));
		}) as VideoDeps["images"],
	};
}

test("video: captions first, then speech-to-text, then frames; results are reused", async () => {
	const home = mkdtempSync(join(tmpdir(), "link-video-"));
	try {
		const seen: Recorded = { log: [], downloads: [], sources: [], images: [] };
		const deps = fakeDeps(home, { info: { id: "abcdefghijk", title: "Vid", extractor_key: "Youtube", duration: 60, has_video: true }, captions: { segments: [], errors: ["no captions"] }, asr: { source: "speech-to-text", language: "en", segments: [{ start: 1, end: 2, text: "Spoken." }] }, ffmpeg: { path: "/ff" } }, seen);
		const ctx = context(fetch, { transcript: true, frames: 2, images: true });
		const pulled = await pullVideo("https://www.youtube.com/watch?v=abcdefghijk", "youtube", ctx, deps);
		assert.deepEqual(seen.log, ["info", "captions", "download", "asr", "download", "ffmpeg"]);
		assert.doesNotMatch(pulled.markdown, /thumbnail/, "frames make the thumbnail redundant");
		assert.equal(pulled.images?.length, 2);
		const textOnly = await pullVideo("https://www.youtube.com/watch?v=abcdefghijk", "youtube", context(fetch, { transcript: true, images: true }), deps);
		assert.deepEqual(seen.images, [["https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg"]]);
		assert.match(textOnly.markdown, /The first image is the thumbnail[\s\S]*## Transcript\n_speech-to-text, en_\n\n\[0:01\] Spoken\.\n\n_To look at a moment, call pull_link again with this URL and at: \["m:ss", \.\.\.\]/);
		assert.deepEqual(textOnly.images?.map((i) => i.data), ["TT=="]);
		assert.ok(ctx.notes.includes("transcribing speech with faster-whisper"));
		seen.log.length = 0;
		await pullVideo("https://www.youtube.com/watch?v=abcdefghijk", "youtube", context(fetch, { transcript: true }), deps);
		assert.deepEqual(seen.log, [], "info and transcript come from the pull folder");
		// Frames at given times reuse the whole video the first call kept, and come back without a transcript.
		seen.log.length = 0;
		const inspect = await pullVideo("https://www.youtube.com/watch?v=abcdefghijk", "youtube", context(fetch, { transcript: false, at: [30, 5, 30, 99], images: true, comments: 0 }), deps);
		assert.deepEqual(seen.log, ["ffmpeg"]);
		assert.deepEqual(seen.sources.at(-1)?.map((s) => [s.at, s.offset]), [[5, 0], [30, 0]]);
		assert.match(inspect.markdown, /^# Vid\n1:00\nhttps:\/\/www\.youtube\.com\/watch\?v=abcdefghijk\n\n## Frames\n\n2 frames[\s\S]*_1:39 is past the end of the video \(1:00\)\._/);
		assert.doesNotMatch(inspect.markdown, /Transcript|thumbnail|Comments/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("video: no frames without a video stream, and a missing token provider is noted", async () => {
	const home = mkdtempSync(join(tmpdir(), "link-audio-"));
	try {
		const deps = { ...fakeDeps(home, { info: { title: "Pod", has_video: false } }), ensure: async () => ({ python: "py", helper: "h", node: "n", home }) } as VideoDeps;
		const pulled = await pullVideo("https://a.test/ep.mp3", "file", context(fetch, { transcript: false, frames: 4 }), deps);
		assert.match(pulled.markdown, /no video stream/);
		assert.doesNotMatch(pulled.markdown, /PO-token/, "the token note is for YouTube only");
		const youtube = await pullVideo("https://www.youtube.com/watch?v=abcdefghijk", "youtube", context(fetch, { transcript: false }), { ...deps, run: fakeDeps(home, { info: { title: "Y", has_video: true } }).run });
		assert.match(youtube.markdown, /PO-token provider is not installed/);
		await assert.rejects(pullVideo("http://192.168.1.5/clip.mp4", "file", context(fetch), deps), /private or local/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a long video gives one exact clip per frame, never the whole file", async () => {
	const home = mkdtempSync(join(tmpdir(), "link-long-"));
	try {
		const seen: Recorded = { log: [], downloads: [], sources: [], images: [] };
		const deps = fakeDeps(home, { info: { title: "Long", duration: 3 * 3600, has_video: true }, ffmpeg: { path: "/ff" } }, seen);
		await pullVideo("https://v.test/long", "vimeo", context(fetch, { transcript: false, frames: 3, range: { start: 600, end: 900 } }), deps);
		assert.deepEqual(seen.downloads.map((d) => [d.sections, d.maxHeight]), [[[[649.5, 651.5], [749.5, 751.5], [849.5, 851.5]], 720]]);
		assert.deepEqual(seen.sources[0].map((s) => [s.at, s.offset]), [[650, 649.5], [750, 749.5], [850, 849.5]]);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("when clips cannot be cut, the video is fetched once at 360p instead", async () => {
	const home = mkdtempSync(join(tmpdir(), "link-fallback-"));
	try {
		const seen: Recorded = { log: [], downloads: [], sources: [], images: [] };
		const base = fakeDeps(home, { info: { title: "Long", duration: 3600, has_video: true }, ffmpeg: { path: "/ff" } }, seen);
		const run = (async (tools: never, command: string, request: Record<string, unknown>, options: never) => {
			if (command === "download" && request.sections) throw new Error("ERROR: ffmpeg exited with code -11");
			return base.run(tools, command, request, options);
		}) as VideoDeps["run"];
		const pulled = await pullVideo("https://v.test/hour", "vimeo", context(fetch, { transcript: false, comments: 0, at: [1800] }), { ...base, run });
		assert.deepEqual(seen.downloads.map((d) => [d.sections, d.maxHeight]), [[undefined, 360]]);
		assert.deepEqual(seen.sources[0].map((s) => [s.at, s.offset]), [[1800, 0]]);
		assert.match(pulled.markdown, /## Frames/);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("a YouTube block still returns the title from oEmbed and says how to fix it", async () => {
	const home = mkdtempSync(join(tmpdir(), "link-blocked-"));
	try {
		const fetcher = (async (url: string) => (String(url).startsWith("https://www.youtube.com/oembed") ? Response.json({ title: "Blocked vid", author_name: "Chan" }) : new Response("", { status: 404 }))) as typeof fetch;
		const deps = fakeDeps(home, { info: new Error("Sign in to confirm you're not a bot"), captions: { segments: [{ start: 0, end: 1, text: "still here" }] } });
		const pulled = await pullVideo("https://youtu.be/abcdefghijk", "youtube", context(fetcher, { transcript: true, frames: 2 }), deps);
		assert.match(pulled.markdown, /^# Blocked vid\nChan/);
		assert.match(pulled.markdown, /\[0:00\] still here/);
		assert.match(pulled.markdown, /linkContext\.proxy[\s\S]*Frames need a download, which YouTube refused/);
		const aged = fakeDeps(home, { info: new Error("Sign in to confirm your age. This video may be inappropriate for some users.") });
		await assert.rejects(pullVideo("https://youtu.be/abcdefghijk", "youtube", context(fetcher), aged), /age-restricted[\s\S]*linkContext\.cookies/);
		await assert.rejects(pullVideo("https://vimeo.com/1", "vimeo", context(fetcher), fakeDeps(home, { info: new Error("HTTP Error 403: Forbidden") })), /403/, "only YouTube gets the fallback");
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("video helpers: ids, thumbnails, times and clips", () => {
	assert.equal(youtubeId("https://www.youtube.com/watch?v=abcdefghijk&list=RDx"), "abcdefghijk");
	assert.equal(youtubeId("https://youtu.be/abcdefghijk"), "abcdefghijk");
	assert.equal(youtubeId("https://www.youtube.com/shorts/abcdefghijk"), "abcdefghijk");
	assert.equal(youtubeId("https://www.youtube.com/@chan"), undefined);
	assert.equal(thumbnailUrl({ extractor_key: "Vimeo", thumbnail: "https://i.vimeocdn.com/t.jpg" }), "https://i.vimeocdn.com/t.jpg");
	assert.equal(thumbnailUrl({ thumbnail: "http://insecure/t.jpg" }), undefined);
	assert.deepEqual(validTimes([30, 5, 30, 99], 60), { times: [5, 30], dropped: [99] });
	assert.deepEqual(sampleFor(2, 100, undefined), [25, 75]);
	assert.deepEqual(sampleFor(2, 100, { start: 80 }), [85, 95]);
	assert.deepEqual(sampleFor(3, undefined, undefined), [0], "an unknown length gives one frame at the start");
	assert.deepEqual(clipFor([{ path: "a", start: 0 }, { path: "b", start: 49.5 }], 50), { path: "b", start: 49.5 });
	assert.equal(clipFor([{ path: "b", start: 49.5 }], 10), undefined);
	assert.equal(clipFor([{ path: "b", start: 49.5 }], 90), undefined, "a clip that ends before the time is not used");
	assert.equal(keyName("at", "5_30"), "at-5_30");
	const long = Array.from({ length: 12 }, (_, i) => String(1000 + i)).join("_");
	assert.match(keyName("at", long), /^at-[0-9a-f]{16}$/);
	assert.notEqual(keyName("at", long), keyName("at", long.replace(/1011$/, "1099")), "keys that share a long prefix get their own folders");
	assert.ok(HOST_BLOCKED.test("ERROR: [youtube] x: Sign in to confirm you’re not a bot"));
	assert.ok(HOST_BLOCKED.test("HTTP Error 429: Too Many Requests"));
	assert.ok(!HOST_BLOCKED.test("Sign in to confirm your age"));
	assert.ok(!HOST_BLOCKED.test("video 4031 not found"));
});

test("image links: single images only, albums and pages left out", () => {
	assert.equal(imageLink("https://imgur.com/AbC12de"), "https://i.imgur.com/AbC12de.jpg");
	assert.equal(imageLink("https://imgur.com/a/AbC12de"), undefined);
	assert.equal(imageLink("https://imgur.com/gallery/AbC12de"), undefined);
	assert.equal(imageLink("https://i.redd.it/x1.png"), "https://i.redd.it/x1.png");
	assert.equal(imageLink("https://e.test/page"), undefined);
	assert.equal(imageLink("javascript:alert(1).png"), undefined);
	assert.deepEqual(imageLinks("see https://e.test/a.jpg, and (https://imgur.com/AbC12de). Also https://e.test/a.jpg"), ["https://e.test/a.jpg", "https://i.imgur.com/AbC12de.jpg"]);
});

test("provisioning state: token-provider retry, tag check, child environment", () => {
	assert.equal(bgutilDue({}, 1e12), true);
	assert.equal(bgutilDue({ bgutilFailedAt: 1e12 - 3_600_000 }, 1e12), false);
	assert.equal(bgutilDue({ bgutilFailedAt: 1e12 - 2 * 86_400_000 }, 1e12), true);
	const home = mkdtempSync(join(tmpdir(), "link-state-"));
	try {
		writeFileSync(join(home, "state.json"), JSON.stringify({ bgutilTag: "--upload-pack=evil", packagesAt: 5 }));
		assert.deepEqual(readState(home), { packagesAt: 5, bgutilTag: undefined });
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
	const env = toolEnv({ PATH: "/bin", HOME: "/h", HTTPS_PROXY: "http://p", ANTHROPIC_API_KEY: "k", GITHUB_TOKEN: "t", UV_INDEX_URL: "u", AWS_SECRET_ACCESS_KEY: "s" });
	assert.deepEqual(env, { PATH: "/bin", HOME: "/h", HTTPS_PROXY: "http://p", UV_INDEX_URL: "u" });
});

const python = ["python3", "python"].find((bin) => spawnSync(bin, ["--version"]).status === 0);

test("helper copies cookies owner-only and removes the copy after the call", { skip: python ? false : "python3 not available" }, () => {
	const dir = mkdtempSync(join(tmpdir(), "link-cookies-"));
	try {
		writeFileSync(join(dir, "cookies.txt"), "# Netscape HTTP Cookie File\n");
		const code = `import sys, os, json; sys.path.insert(0, sys.argv[1]); import helper
def probe(req):
    path = helper.private_cookies(req)
    return {"mode": oct(os.stat(path).st_mode & 0o777), "path": path}
helper.COMMANDS["probe"] = probe
sys.argv = ["helper.py", "probe"]
helper.main()`;
		const result = spawnSync(python as string, ["-I", "-c", code, dirname(HELPER)], { input: JSON.stringify({ cookies: join(dir, "cookies.txt"), dir }), encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
		const reply = JSON.parse(result.stdout);
		assert.equal(reply.mode, "0o600");
		assert.equal(existsSync(reply.path), false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("helper parses VTT without auto-caption repeats, and json3", { skip: python ? false : "python3 not available" }, () => {
	const vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<c>hello</c> world\n\n00:00:03.000 --> 00:00:05.000\nhello world\nnext line\n\n00:00:05.000 --> 00:00:06.000\nYes.\n\n00:00:06.000 --> 00:00:07.000\na\n\n00:00:07.000 --> 00:00:08.000\nb\n\n00:00:08.000 --> 00:00:09.000\nc\n\n00:00:09.000 --> 00:00:10.000\nYes.\n\n01:00:00.500 --> 01:00:01.000\nlate\n";
	const json3 = JSON.stringify({ events: [{ tStartMs: 1500, dDurationMs: 1000, segs: [{ utf8: "hi " }, { utf8: "there" }] }, { tStartMs: 3000, segs: [{ utf8: "\n" }] }] });
	const code = `import sys, json; sys.path.insert(0, sys.argv[1]); import helper; print(json.dumps([helper.parse_vtt(sys.argv[2]), helper.parse_json3(sys.argv[3])]))`;
	const result = spawnSync(python as string, ["-I", "-c", code, dirname(HELPER), vtt, json3], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	const [fromVtt, fromJson] = JSON.parse(result.stdout);
	assert.deepEqual(fromVtt.map((s: { text: string }) => s.text), ["hello world", "next line", "Yes.", "a", "b", "c", "Yes.", "late"], "a line said again later is kept");
	assert.equal(fromVtt.at(-1).start, 3600.5);
	assert.deepEqual(fromJson, [{ start: 1.5, end: 2.5, text: "hi there" }]);
});
