import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import {
	capturePlist,
	captureRoute,
	isRemoteSession,
	startDesktopCapture,
	type Launchctl,
} from "../lib/voice/desktop-capture.ts";

const FRAME_BYTES = 1600 * 2;

function home(): string {
	// Unix socket paths are capped near 104 bytes, so keep the fixture short.
	return mkdtempSync(join("/tmp", "pv-"));
}

function waitFor(check: () => boolean, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	return new Promise((resolve, reject) => {
		const poll = () => {
			if (check()) return resolve();
			if (Date.now() > deadline) return reject(new Error("timed out"));
			setTimeout(poll, 10);
		};
		poll();
	});
}

/** Stands in for launchd: bootstrap "runs ffmpeg" by writing PCM into the job's socket. */
function fakeLaunchd(behaviour: { fail?: boolean; hangUpAfterBytes?: number } = {}) {
	const calls: string[][] = [];
	const launchctl: Launchctl = async (args) => {
		calls.push(args);
		if (args[0] !== "bootstrap") return { code: 0, stderr: "" };
		if (behaviour.fail) return { code: 5, stderr: "Bootstrap failed: 5: Input/output error" };
		const plist = readFileSync(args[2]!, "utf8");
		const socketPath = plist.match(/<string>unix:(.+?)<\/string>/)![1]!;
		if (behaviour.hangUpAfterBytes !== undefined) {
			writeFileSync(plist.match(/StandardErrorPath<\/key><string>(.+?)<\/string>/)![1]!, "Input/output error\n");
		}
		const writer = connect(socketPath, () => {
			writer.write(Buffer.alloc(behaviour.hangUpAfterBytes ?? FRAME_BYTES * 2, 1));
			if (behaviour.hangUpAfterBytes !== undefined) writer.end();
		});
		writer.on("error", () => {});
		return { code: 0, stderr: "" };
	};
	return { calls, launchctl };
}

test("SSH sessions are detected from any of the standard variables", () => {
	assert.equal(isRemoteSession({}), false);
	assert.equal(isRemoteSession({ SSH_CONNECTION: "10.0.0.2 5 10.0.0.1 22" }), true);
	assert.equal(isRemoteSession({ SSH_CLIENT: "10.0.0.2 5 22" }), true);
	assert.equal(isRemoteSession({ SSH_TTY: "/dev/ttys001" }), true);
	assert.equal(isRemoteSession({ SSH_CONNECTION: "" }), false);
});

test("only macOS over SSH records through the desktop session", () => {
	assert.equal(captureRoute("darwin", { SSH_TTY: "/dev/ttys001" }), "desktop");
	assert.equal(captureRoute("darwin", {}), "local");
	assert.equal(captureRoute("linux", { SSH_TTY: "/dev/pts/0" }), "local");
});

test("the launchd job records 16 kHz mono s16le into the socket and never restarts", () => {
	const plist = capturePlist({ label: "com.x.capture.1", ffmpeg: "/opt/homebrew/bin/ffmpeg", socketPath: "/tmp/a&b.sock", logPath: "/tmp/log" });
	assert.match(plist, /<string>com\.x\.capture\.1<\/string>/);
	assert.match(plist, /<string>\/opt\/homebrew\/bin\/ffmpeg<\/string>/);
	assert.match(plist, /<string>avfoundation<\/string>/);
	assert.match(plist, /<string>16000<\/string>/);
	assert.match(plist, /<string>s16le<\/string>/);
	assert.match(plist, /<string>unix:\/tmp\/a&amp;b\.sock<\/string>/, "paths are XML-escaped");
	assert.ok(!plist.includes("KeepAlive"), "a crashed recorder must not respawn");
	assert.match(plist, /<string>-i<\/string><string>:default<\/string>/, "system default unless a mic is chosen");
});

test("a chosen mic is opened by name in the launchd job", () => {
	const plist = capturePlist({ label: "l", ffmpeg: "/f", socketPath: "/s", logPath: "/l", device: "Jaedyn’s <iPhone> Microphone" });
	assert.match(plist, /<string>-i<\/string><string>:Jaedyn’s &lt;iPhone&gt; Microphone<\/string>/);
});

test("frames stream from the launchd job, and stop boots it out and cleans up", async () => {
	const dir = home();
	try {
		const launchd = fakeLaunchd();
		const frames: Int16Array[] = [];
		const errors: Error[] = [];
		const capture = startDesktopCapture(
			{ onFrame: (f) => frames.push(f), onError: (e) => errors.push(e) },
			{ home: dir, ffmpeg: "/bin/ffmpeg", uid: 501, pid: 42, launchctl: launchd.launchctl, alive: () => true },
		);
		await waitFor(() => frames.length === 2);
		assert.equal(frames[0]!.length, 1600);
		assert.deepEqual(launchd.calls.find((c) => c[0] === "bootstrap")?.slice(0, 2), ["bootstrap", "gui/501"]);
		capture.stop();
		await waitFor(() => launchd.calls.some((c) => c[0] === "bootout" && /^gui\/501\/com\.pi-extras\.voice\.capture\.42\.\d+$/.test(c[1]!)) && readdirSync(dir).length === 0);
		assert.deepEqual(errors, []);
		assert.ok(capture.blockedHint && /Allow/.test(capture.blockedHint), "hint explains the one-time Allow");
		assert.equal(capture.device, "Mac microphone", "generic name when the device is unknown");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a desktop with nobody logged in is reported, not retried", async () => {
	const dir = home();
	try {
		const errors: Error[] = [];
		startDesktopCapture(
			{ onFrame: () => {}, onError: (e) => errors.push(e) },
			{ home: dir, ffmpeg: "/bin/ffmpeg", uid: 501, pid: 43, launchctl: fakeLaunchd({ fail: true }).launchctl, alive: () => true },
		);
		await waitFor(() => errors.length === 1);
		assert.match(errors[0]!.message, /logged in/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a recorder that dies mid-dictation surfaces its log", async () => {
	const dir = home();
	try {
		const errors: Error[] = [];
		const launchd = fakeLaunchd({ hangUpAfterBytes: FRAME_BYTES });
		startDesktopCapture(
			{ onFrame: () => {}, onError: (e) => errors.push(e) },
			{ home: dir, ffmpeg: "/bin/ffmpeg", uid: 501, pid: 44, launchctl: launchd.launchctl, alive: () => true },
		);
		await waitFor(() => errors.length === 1);
		assert.match(errors[0]!.message, /Input\/output error/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("jobs left behind by crashed sessions are booted out on the next start", async () => {
	const dir = home();
	try {
		writeFileSync(join(dir, "capture-999-3.plist"), "");
		writeFileSync(join(dir, "capture-999-3.sock"), "");
		const launchd = fakeLaunchd();
		const capture = startDesktopCapture(
			{ onFrame: () => {}, onError: () => {} },
			{ home: dir, ffmpeg: "/bin/ffmpeg", uid: 501, pid: 45, launchctl: launchd.launchctl, alive: (pid) => pid !== 999 },
		);
		await waitFor(() => launchd.calls.some((c) => c[0] === "bootout" && c[1] === "gui/501/com.pi-extras.voice.capture.999.3"));
		assert.equal(existsSync(join(dir, "capture-999-3.plist")), false);
		assert.equal(existsSync(join(dir, "capture-999-3.sock")), false);
		capture.stop();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
