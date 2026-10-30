/**
 * The frame pump. Each wall-clock slot at `fps` becomes exactly one video
 * frame: a screenshot goes into the slot it was taken in, and every slot the
 * screenshot missed gets the last image again. The event log reads the same
 * clock through `frame()`, so events.json and capture.mp4 agree frame for
 * frame, and a slow frame lengthens the video instead of shifting it.
 *
 * With `clock: "virtual"` (the default of wv capture) there are no wall-clock
 * slots: before each frame the pump advances the page's virtual clock by one
 * frame (vclock.mjs) and draws the frame at the same time, so the app's
 * timers, animation frames and CSS animations move exactly one frame per
 * captured frame, however slow the host is.
 */
import { createHash } from "node:crypto";
import { sleep, spawnChild, withTimeout } from "./proc.mjs";
import { SlotClock, slotDueMs } from "./slots.mjs";
import { StillTracker } from "./stills.mjs";
import { advancePageClock } from "./vclock.mjs";

export class FramePump {
	constructor({ cdp, fps, output, crf = 12, format = "png", quality = 95, ffmpeg = "ffmpeg", clock = "real" }) {
		this.cdp = cdp;
		this.virtual = clock === "virtual";
		this.fps = fps;
		this.output = output;
		this.crf = crf;
		this.format = format;
		this.quality = quality;
		this.ffmpegPath = ffmpeg;
		this.dt = 1000 / fps;
		this.tickBase = 100000;
		this.clock = new SlotClock(fps);
		this.written = 0;
		this.unique = 0;
		this.repeated = 0;
		this.maxLagMs = 0;
		this.stills = new StillTracker();
		this.frameMs = [];
		this.lastHash = null;
		this.lastBuffer = null;
		this.last = null;
		this.ffmpeg = null;
		this.ffmpegError = null;
		this.error = null;
		this.stopping = false;
		this.loop = null;
		this.t0 = 0;
		/** Called after each written frame with its number; the capture samples the page here. */
		this.onFrame = null;
		/** Called after each clock advance with the capture time; the capture moves its install script. */
		this.onAdvance = null;
	}

	/** The frame on screen now: the last frame that reached the video. */
	frame() {
		return Math.max(0, this.written - 1);
	}

	stats() {
		const ms = [...this.frameMs].sort((a, b) => a - b);
		const pct = (p) => (ms.length ? Math.round(ms[Math.min(ms.length - 1, Math.floor((p / 100) * ms.length))]) : 0);
		return {
			unique: this.unique,
			repeated: this.repeated,
			maxLagMs: Math.round(this.maxLagMs),
			frames: this.written,
			// Frames that show a new image, and the runs of frames that repeat one.
			distinct: this.stills.distinctFrames(),
			frameMs: { p50: pct(50), p95: pct(95) },
			stills: this.stills.runs(),
		};
	}

	/**
	 * One video frame: hash the image, note whether it repeats the frame before
	 * it, then write it. The hash is what tells real motion from the pump filling
	 * a missed slot, which the composer and the smoothness gate need.
	 */
	async writeSlot() {
		const hash = this.last === this.lastBuffer && this.lastHash !== null ? this.lastHash : createHash("sha1").update(this.last).digest("base64");
		this.lastBuffer = this.last;
		this.lastHash = hash;
		await this.writeFrame(this.last);
		this.stills.add(hash, this.written);
		this.written++;
	}

	async screenshot(atTick) {
		const params = { frameTimeTicks: atTick, interval: this.dt, screenshot: { format: this.format } };
		if (this.format === "jpeg") params.screenshot.quality = this.quality;
		const result = await this.cdp.send("HeadlessExperimental.beginFrame", params);
		return result?.screenshotData ? Buffer.from(result.screenshotData, "base64") : null;
	}

	/** One image before the clock starts, so every later slot has something to repeat. */
	async seed() {
		for (let attempt = 0; attempt < 6; attempt++) {
			const image = await withTimeout(this.screenshot(this.tickBase - this.dt), 15000, "beginFrame at capture start");
			if (image) {
				this.last = image;
				return;
			}
			await sleep(100);
		}
		throw new Error("beginFrame returned no image at capture start. Capture needs chrome-headless-shell with --enable-begin-frame-control; run 'wv setup' and try again.");
	}

	start() {
		if (this.last === null) throw new Error("FramePump.start() needs seed() first");
		this.spawnFfmpeg();
		this.t0 = performance.now();
		this.loop = this.virtual ? this.runVirtual() : this.run();
	}

	spawnFfmpeg() {
		const args = [
			"-v", "error", "-y",
			"-f", "image2pipe",
			"-framerate", String(this.fps),
			"-i", "-",
			"-an",
			"-c:v", "libx264",
			"-preset", "veryfast",
			"-crf", String(this.crf),
			"-pix_fmt", "yuv420p",
			"-fps_mode", "cfr",
			"-r", String(this.fps),
			"-movflags", "+faststart",
			this.output,
		];
		this.ffmpeg = spawnChild(this.ffmpegPath, args, { stdio: ["pipe", "ignore", "pipe"] });
		this.ffmpeg.stderr.on("data", (chunk) => {
			const text = chunk.toString().trim();
			if (text) this.ffmpegError = new Error(`ffmpeg: ${text}`);
		});
		this.ffmpeg.on("error", (error) => {
			this.ffmpegError = error;
		});
		this.ffmpeg.on("close", (code) => {
			if (code !== 0 && !this.ffmpegError) this.ffmpegError = new Error(`ffmpeg exited with code ${code}`);
		});
	}

	async writeFrame(buffer) {
		const stdin = this.ffmpeg?.stdin;
		if (!stdin || stdin.destroyed) throw this.ffmpegError ?? new Error("ffmpeg stopped before the capture ended");
		if (stdin.write(buffer)) return;
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				cleanup();
				reject(new Error("ffmpeg has not read a frame for 60 s"));
			}, 60000);
			const cleanup = () => {
				clearTimeout(timer);
				stdin.off("drain", onDrain);
				stdin.off("error", onError);
				stdin.off("close", onClose);
			};
			const onDrain = () => {
				cleanup();
				resolve();
			};
			const onError = (error) => {
				cleanup();
				reject(error);
			};
			const onClose = () => {
				cleanup();
				reject(this.ffmpegError ?? new Error("ffmpeg closed the frame pipe"));
			};
			stdin.on("drain", onDrain);
			stdin.on("error", onError);
			stdin.on("close", onClose);
		});
	}

	async run() {
		try {
			while (!this.stopping) {
				const due = this.t0 + slotDueMs(this.clock.next, this.fps);
				const wait = due - performance.now();
				if (wait > 1) await sleep(wait);
				const taken = this.clock.take(performance.now() - this.t0);
				if (!taken) continue;
				this.maxLagMs = Math.max(this.maxLagMs, performance.now() - due);
				for (let i = 0; i < taken.repeats; i++) {
					await this.writeSlot();
					this.repeated++;
				}
				const started = performance.now();
				const image = await withTimeout(this.screenshot(this.tickBase + taken.slot * this.dt), 20000, "beginFrame during capture");
				this.frameMs.push(performance.now() - started);
				if (image) {
					this.last = image;
					this.unique++;
				} else {
					this.repeated++;
				}
				await this.writeSlot();
				// The real clock installs no script, so there is nothing to move here.
				if (this.onFrame) await this.onFrame(this.frame());
			}
		} catch (error) {
			this.error = error;
		}
	}

	/**
	 * Frame-exact capture: advance the page clock one frame, draw that frame at
	 * the same time, write it. The wall clock plays no part, so no slot is ever
	 * filled with a repeat.
	 */
	async runVirtual() {
		try {
			// Before the first advance: a document the app opens during frame 1 starts at frame 1,
			// never at 0, which is behind the document it replaces.
			if (this.onAdvance) await this.onAdvance(this.dt);
			while (!this.stopping) {
				const index = this.written + 1;
				// A document that loaded since the last frame starts its clock at the last frame's time.
				await advancePageClock(this.cdp, index * this.dt, (index - 1) * this.dt);
				const started = performance.now();
				const image = await withTimeout(this.screenshot(this.tickBase + index * this.dt), 20000, "beginFrame during capture");
				this.frameMs.push(performance.now() - started);
				if (image) {
					this.last = image;
					this.unique++;
				} else {
					this.repeated++;
				}
				await this.writeSlot();
				// After the slot, so the CDP work never sits between the clock advance and the
				// draw. The script carries the next frame's time: a document the app opens during
				// frame index+1 must start at index+1, never one frame behind the document it replaces.
				if (this.onAdvance) await this.onAdvance((index + 1) * this.dt);
				if (this.onFrame) await this.onFrame(this.frame());
			}
		} catch (error) {
			this.error = error;
		}
	}

	/** Stops at the next slot boundary, then flushes and checks ffmpeg. */
	async stop() {
		this.stopping = true;
		await this.loop;
		const ffmpeg = this.ffmpeg;
		if (ffmpeg) {
			await new Promise((resolve) => {
				if (ffmpeg.exitCode !== null || ffmpeg.signalCode !== null) {
					resolve();
					return;
				}
				const timer = setTimeout(() => {
					ffmpeg.kill("SIGKILL");
				}, 60000);
				ffmpeg.on("close", () => {
					clearTimeout(timer);
					resolve();
				});
				ffmpeg.stdin.end();
			});
		}
		if (this.error) throw this.error;
		if (this.ffmpegError) throw this.ffmpegError;
		if (this.written === 0) throw new Error("the capture wrote no frames");
	}
}
