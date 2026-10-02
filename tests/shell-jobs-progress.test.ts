import assert from "node:assert/strict";
import test from "node:test";
import { METER_HOLD_MS, leadingSleepMs, nextProgress, progressNow, readProgress, sleepProgress, type Reading } from "../lib/shell-jobs-progress.ts";

const near = (actual: number | undefined, expected: number) => assert.ok(actual !== undefined && Math.abs(actual - expected) < 0.001, `${actual} ≉ ${expected}`);
const read = (line: string): Reading => {
	const reading = readProgress(line);
	assert.ok(reading, `no reading in ${JSON.stringify(line)}`);
	return reading;
};

test("a command that starts by sleeping is as long as its sleeps", () => {
	assert.equal(leadingSleepMs("sleep 30"), 30_000);
	assert.equal(leadingSleepMs("sleep 30; echo checked 42 files"), 30_000);
	assert.equal(leadingSleepMs("sleep 20 && npm test"), 20_000);
	assert.equal(leadingSleepMs("sleep 1m 30s"), 90_000);
	assert.equal(leadingSleepMs("sleep 0.5"), 500);
	assert.equal(leadingSleepMs("sleep 2h"), 7_200_000);
	assert.equal(leadingSleepMs("sleep 3; sleep 4\necho done"), 7_000);
});

test("a sleep that isn't first, or can't be known, gives no length", () => {
	for (const command of ["npm test; sleep 5", "sleep infinity", "sleep $DELAY", "sleep 5 & wait", "sleep 5 | cat", "sleep 5 || true", "for i in 1 2; do sleep 1; done", "sleep 0", "echo sleep 30"]) {
		assert.equal(leadingSleepMs(command), undefined, command);
	}
});

test("sleep progress is the share slept, with the time left; past the sleep it is unknown", () => {
	const halfway = sleepProgress("sleep 30; echo done", 12_000)!;
	near(halfway.share, 0.4);
	assert.deepEqual(halfway.parts, ["18s left"]);
	assert.deepEqual(sleepProgress("sleep 300", 50_000)!.parts, ["4m10s left"]);
	assert.deepEqual(sleepProgress("sleep 2h", 0)!.parts, ["2h00m left"]);
	assert.equal(sleepProgress("sleep 20 && npm test", 20_000), undefined);
	assert.equal(sleepProgress("npm test", 1_000), undefined);
});

test("curl's meter: share, then time left, size and speed", () => {
	const reading = read("  45  690M   45  312M    0     0  11.8M      0  0:00:58  0:00:26  0:00:32 12.1M");
	near(reading.share, 0.45);
	assert.deepEqual(reading.parts, ["32s left", "312M/690M", "12.1M/s"]);
	assert.equal(reading.trusted, true);
	// Its header says nothing; a download of unknown size has no share, but still how much and how fast.
	assert.equal(readProgress("  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current"), undefined);
	const unsized = read("  0     0    0  312M    0     0  11.8M      0 --:--:--  0:00:26 --:--:-- 12.1M");
	assert.equal(unsized.share, undefined);
	assert.deepEqual(unsized.parts, ["312M", "12.1M/s"]);
	// curl -# draws a bar of hashes.
	const bar = read("######################################                     45.2%");
	near(bar.share, 0.452);
	assert.equal(bar.trusted, true);
});

test("wget, rsync and git meters", () => {
	const wget = read("ubuntu.iso          45%[=======>           ] 312.00M  12.1MB/s    eta 31s");
	near(wget.share, 0.45);
	assert.deepEqual(wget.parts, ["31s left", "312.00M", "12.1MB/s"]);
	const rsync = read("    123,456,789  62%   48.12MB/s    0:00:12 (xfr#3, to-chk=1/10)");
	near(rsync.share, 0.62);
	assert.deepEqual(rsync.parts, ["12s left", "48.12MB/s"]);
	assert.deepEqual(read("  1,234,567,890  12%   48.12MB/s    1:02:03").parts, ["1h02m left", "48.12MB/s"]);
	const git = read("Receiving objects:  73% (4521/6193), 12.30 MiB | 4.10 MiB/s");
	near(git.share, 0.73);
	assert.deepEqual(git.parts, ["receiving objects", "4.10 MiB/s"]);
	assert.deepEqual(read("remote: Compressing objects:  45% (45/100)").parts, ["compressing objects"]);
});

test("pip, tqdm, ninja and cargo meters", () => {
	const pip = read("   ━━━━━━━━━━━━━━━━━━━━╺━━━━━━━━━━━━━━━━━━━ 412.3/790.1 MB 12.1 MB/s eta 0:00:31");
	near(pip.share, 412.3 / 790.1);
	assert.deepEqual(pip.parts, ["31s left", "412.3/790.1 MB", "12.1 MB/s"]);
	const tqdm = read("Epoch 3:  34%|███▍      | 340/1000 [02:08<04:12,  2.65it/s]");
	near(tqdm.share, 0.34);
	assert.deepEqual(tqdm.parts, ["4m12s left", "340/1000"]);
	const ninja = read("[45/120] Compiling src/foo.c");
	near(ninja.share, 45 / 120);
	assert.deepEqual(ninja.parts, ["45/120"]);
	const cargo = read("    Building [=======>                 ] 120/304: serde, syn");
	near(cargo.share, 120 / 304);
	assert.deepEqual(cargo.parts, ["120/304"]);
});

test("a bare percentage is read but not trusted; lines without one read as nothing", () => {
	const bare = read("Uploading build artifacts... 45%");
	near(bare.share, 0.45);
	assert.equal(bare.trusted, false);
	assert.deepEqual(bare.parts, []);
	for (const line of ["✓ 212 passing", "items[0] = [1, 2]", "", "took 120% longer", "[0/0] nothing to do"]) assert.equal(readProgress(line), undefined, line);
});

test("a meter shows at once; a bare percentage only once it has risen, and only while it doesn't fall", () => {
	const meter = nextProgress({}, "  45  690M   45  312M    0     0  11.8M      0  0:00:58  0:00:26  0:00:32 12.1M", 0);
	near(progressNow(meter, 0)!.share, 0.45);
	const first = nextProgress({}, "coverage 85%", 0);
	assert.equal(progressNow(first, 0), undefined, "a percentage in passing is not a bar");
	assert.equal(progressNow(nextProgress(first, "coverage 85%", 0), 0), undefined);
	const rose = nextProgress(first, "Uploading... 90%", 0);
	near(progressNow(rose, 0)!.share, 0.9);
	const held = nextProgress(rose, "Uploading... 90%", 0);
	near(progressNow(held, 0)!.share, 0.9);
	// A fall says these aren't one task's progress (per-file coverage, a CPU monitor): no bar until it climbs again.
	const fell = nextProgress(held, "c.py 40%", 0);
	assert.equal(progressNow(fell, 0), undefined);
	assert.equal(progressNow(nextProgress(fell, "d.py 40%", 0), 0), undefined);
	near(progressNow(nextProgress(fell, "Uploading... 45%", 0), 0)!.share, 0.45);
});

test("a bar holds for a moment through lines between meter updates, then gives way", () => {
	// ninja warnings, pip's "Collecting …": without the hold the band would flick between fill and sweep.
	const meter = nextProgress({}, "[45/120] Compiling src/foo.c", 1_000);
	const between = nextProgress(meter, "warning: unused variable 'x'", 2_000);
	near(progressNow(between, 2_000 + METER_HOLD_MS - 1)!.share, 45 / 120);
	assert.equal(progressNow(between, 2_000 + METER_HOLD_MS), undefined);
	// Another line between doesn't restart the hold; the next meter line does.
	const still = nextProgress(between, "warning: unused variable 'y'", 4_000);
	assert.equal(progressNow(still, 2_000 + METER_HOLD_MS), undefined);
	near(progressNow(nextProgress(still, "[46/120] Compiling src/bar.c", 6_000), 6_000 + METER_HOLD_MS * 10)!.share, 46 / 120);
	assert.equal(progressNow(nextProgress({}, undefined, 0), 0), undefined);
});

test("facts with no share go stale when the meter stops: a finished step's speed is no news", () => {
	const done = nextProgress({}, "100  690M  100  690M    0     0  11.8M      0  0:00:58  0:00:58 --:--:-- 12.1M", 1_000);
	assert.deepEqual(progressNow(done, 1_000)!.parts, ["690M/690M", "12.1M/s"]);
	assert.equal(progressNow(done, 1_000 + METER_HOLD_MS), undefined);
	// A bare 100% says nothing beyond itself: no bar and no empty facts hiding the output line.
	const climbed = nextProgress(nextProgress({}, "upload 90%", 0), "upload 95%", 0);
	assert.equal(progressNow(nextProgress(climbed, "upload 100%", 0), 0), undefined);
});

test("a full meter's time is how long it took, not time left", () => {
	// rsync's last line prints elapsed time where the time left was.
	const state = nextProgress({}, "    48,000,000 100%   48.12MB/s    0:00:05 (xfr#1, to-chk=0/1)", 0);
	assert.deepEqual(progressNow(state, 0)?.parts, ["48.12MB/s"]);
});

test("wget's dot meter, the one it draws into a log, reads like its bar", () => {
	const dots = read("  5450K .......... .......... .......... .......... .......... 45% 5.20M 1m14s");
	near(dots.share, 0.45);
	assert.deepEqual(dots.parts, ["1m14s left", "5.20M/s"]);
	assert.equal(dots.trusted, true);
});

test("a short run of = or # beside a percentage is a heading, not a bar", () => {
	for (const line of ["=== Results: 75% ===", "### step (50%)"]) assert.equal(read(line).trusted, false, line);
	assert.equal(read("[=====>      ] 45%").trusted, true);
});

test("every tool's time left reads the same way", () => {
	assert.deepEqual(read("data.bin  45%[=======>     ] 312.00M  12.1MB/s    eta 1m 5s").parts[0], "1m05s left");
	assert.deepEqual(read("data.bin  45%[=======>     ] 312.00M  12.1MB/s    eta 2h 3m").parts[0], "2h03m left");
	// Nothing left, or not known yet: no time at all rather than a wrong one.
	assert.ok(!read("100  690M  100  690M    0     0  11.8M      0  0:00:58  0:00:58  0:00:00 12.1M").parts.some((part) => part.endsWith("left")));
	assert.deepEqual(read("Epoch 3:  34%|███▍      | 340/1000 [02:08<?,  2.65it/s]").parts, ["340/1000"]);
});

test("wget with no length known reads how much and how fast, with no share", () => {
	const unsized = read("data.bin               [     <=>            ] 312.00M  12.1MB/s");
	assert.equal(unsized.share, undefined);
	assert.deepEqual(unsized.parts, ["312.00M", "12.1MB/s"]);
});

test("a finished meter is a finished step, not a finished job: no share, its facts kept", () => {
	// curl's last line before a silent `tar xzf` would otherwise hold the bar full while the job runs on.
	const state = nextProgress({}, "100  690M  100  690M    0     0  11.8M      0  0:00:58  0:00:58 --:--:-- 12.1M", 0);
	assert.equal(progressNow(state, 0)?.share, undefined);
	assert.deepEqual(progressNow(state, 0)?.parts, ["690M/690M", "12.1M/s"]);
	assert.equal(progressNow(nextProgress({}, "[120/120] Linking app", 0), 0)?.share, undefined);
});
