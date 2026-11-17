import { p50p95 } from "./stats.mjs";

/**
 * Step names that are setup, not the check itself: the runner start, checkout, toolchain and cache actions, dependency
 * installs, container start, and the post and teardown steps. GitHub names a `uses:` step "Run <action>@<ref>" when the
 * workflow gives it no name, so most matches come from the action name.
 */
export const DEFAULT_SETUP = new RegExp([
	"^Set up job$", "^Complete job$", "^Initialize containers$", "^Stop containers$", "^Post ",
	"checkout", "setup-", "/cache(@|/)", "\\bcache\\b", "download-artifact",
	"\\b(npm|pnpm|yarn|bun) (ci|install|i)\\b", "\\bbun install\\b", "\\buv sync\\b", "\\bpip install\\b",
	"\\bpoetry install\\b", "\\bbundle install\\b", "\\bgo mod download\\b", "\\bcargo fetch\\b",
	"docker/login", "docker/setup", "configure-aws-credentials", "google-github-actions/auth",
].join("|"), "i");

/** @param {string} name @param {RegExp} [setup] @returns {"setup" | "running"} */
export function classifyStep(name, setup = DEFAULT_SETUP) {
	return setup.test(name) ? "setup" : "running";
}

/** @param {string | null | undefined} from @param {string | null | undefined} to */
function seconds(from, to) {
	if (!from || !to) return 0;
	return Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000);
}

/**
 * Waiting is the time from job creation to a runner start (it includes a wait on `needs:` jobs). Setup is the sum of
 * setup steps. Running is the rest of the job, so the three add up to the job's time from creation.
 * @param {any} job @param {RegExp} [setup]
 */
export function jobBuckets(job, setup = DEFAULT_SETUP) {
	if (!job.started_at || !job.completed_at || job.conclusion === "skipped") return undefined;
	const waiting = seconds(job.created_at, job.started_at);
	const ran = seconds(job.started_at, job.completed_at);
	const setupSeconds = Math.min(ran, (job.steps ?? [])
		.filter((step) => classifyStep(step.name, setup) === "setup")
		.reduce((sum, step) => sum + seconds(step.started_at, step.completed_at), 0));
	return { name: job.name, waiting, setup: setupSeconds, running: ran - setupSeconds, total: waiting + ran };
}

/** Seconds from the start of this run attempt to the end of its last job. @param {any} run @param {any[]} jobs */
export function runWall(run, jobs) {
	const ends = jobs.map((job) => job.completed_at).filter(Boolean).map((end) => Date.parse(end));
	if (ends.length === 0) return undefined;
	const start = Date.parse(run.run_started_at ?? run.created_at);
	return Math.max(0, (Math.max(...ends) - start) / 1000);
}

/** The job that ended last is the one the author waits on. @param {any[]} jobs @param {RegExp} setup */
function criticalJob(jobs, setup) {
	const done = jobs.filter((job) => job.completed_at && job.conclusion !== "skipped");
	if (done.length === 0) return undefined;
	const last = done.reduce((a, b) => (Date.parse(b.completed_at) > Date.parse(a.completed_at) ? b : a));
	return jobBuckets(last, setup);
}

const BUCKETS = /** @type {const} */ (["waiting", "setup", "running"]);
const STEP_ROWS = 12;

/** A cancelled or skipped run says nothing about how long a result takes, and cancel-in-progress makes many of them. */
const NO_RESULT = new Set(["cancelled", "skipped"]);

/**
 * @param {{ run: any, jobs: any[] }[]} all
 * @param {RegExp} [setup]
 * @param {{ successOnly?: boolean }} [options]
 */
export function summarize(all, setup = DEFAULT_SETUP, { successOnly = false } = {}) {
	/** @type {Record<string, number>} */
	const conclusions = {};
	for (const { run } of all) conclusions[run.conclusion ?? "unknown"] = (conclusions[run.conclusion ?? "unknown"] ?? 0) + 1;
	const runs = all.filter(({ run }) => (successOnly ? run.conclusion === "success" : !NO_RESULT.has(run.conclusion)));
	/** @type {Map<string, number[]>} */
	const walls = new Map([["all", []]]);
	/** @type {Map<string, { waiting: number[], setup: number[], running: number[], total: number[] }>} */
	const byJob = new Map();
	const critical = { waiting: [], setup: [], running: [] };
	const runnerSeconds = { waiting: 0, setup: 0, running: 0 };
	/** @type {Map<string, { job: string, step: string, values: number[] }>} */
	const bySteps = new Map();
	for (const { run, jobs } of runs) {
		const wall = runWall(run, jobs);
		if (wall !== undefined) {
			walls.get("all").push(wall);
			if (!walls.has(run.event)) walls.set(run.event, []);
			walls.get(run.event).push(wall);
		}
		for (const job of jobs) {
			const buckets = jobBuckets(job, setup);
			if (!buckets) continue;
			if (!byJob.has(job.name)) byJob.set(job.name, { waiting: [], setup: [], running: [], total: [] });
			const entry = byJob.get(job.name);
			for (const key of [...BUCKETS, "total"]) entry[key].push(buckets[key]);
			for (const item of job.steps ?? []) {
				if (!item.started_at || !item.completed_at || item.conclusion === "skipped") continue;
				const key = `${job.name}\u0000${item.name}`;
				if (!bySteps.has(key)) bySteps.set(key, { job: job.name, step: item.name, values: [] });
				bySteps.get(key).values.push(seconds(item.started_at, item.completed_at));
			}
			runnerSeconds.setup += buckets.setup;
			runnerSeconds.running += buckets.running;
		}
		const path = criticalJob(jobs, setup);
		if (path) for (const key of BUCKETS) critical[key].push(path[key]);
	}
	const criticalPath = Object.fromEntries(BUCKETS.map((key) => [key, p50p95(critical[key])]));
	const biggest = [...BUCKETS].sort((a, b) => (criticalPath[b].p50 ?? 0) - (criticalPath[a].p50 ?? 0))[0];
	const jobs = [...byJob].map(([name, entry]) => ({
		name, n: entry.total.length,
		waiting: p50p95(entry.waiting), setup: p50p95(entry.setup), running: p50p95(entry.running), total: p50p95(entry.total),
	})).sort((a, b) => (b.total.p50 ?? 0) - (a.total.p50 ?? 0) || a.name.localeCompare(b.name));
	const steps = [...bySteps.values()]
		.map(({ job, step, values }) => ({ job, step, n: values.length, bucket: classifyStep(step, setup), ...p50p95(values) }))
		.sort((a, b) => b.p50 - a.p50 || a.job.localeCompare(b.job) || a.step.localeCompare(b.step))
		.slice(0, STEP_ROWS);
	return {
		runs: runs.length, conclusions,
		wall: Object.fromEntries([...walls].map(([event, values]) => [event, { n: values.length, ...p50p95(values) }])),
		jobs, steps, criticalPath, biggest,
		// Waiting costs no runner time; it costs only the author's time.
		runnerMinutes: { setup: runnerSeconds.setup / 60, running: runnerSeconds.running / 60 },
	};
}

/** @param {number | undefined} value */
const s = (value) => (value === undefined ? "-" : `${Math.round(value)} s`);

/**
 * @param {ReturnType<typeof summarize>} summary
 * @param {{ p50: number, p95: number }} target seconds
 * @param {{ successOnly?: boolean }} [options]
 */
export function formatReport(summary, target, { successOnly = false } = {}) {
	const counts = Object.entries(summary.conclusions).map(([conclusion, n]) => `${conclusion} ${n}`).join(", ");
	const lines = [`# CI audit: ${summary.runs} runs`, "", `Pulled runs by conclusion: ${counts}. ${successOnly ? "Only successful runs are kept." : "Cancelled and skipped runs are left out."}`, "", `Target: p50 under ${target.p50} s, p95 under ${target.p95} s.`, "",
		"## Wall time (run start to last job end)", "", "| event | runs | p50 | p95 | target |", "| --- | --- | --- | --- | --- |"];
	for (const [event, wall] of Object.entries(summary.wall)) {
		const met = wall.p50 !== undefined && wall.p50 <= target.p50 && wall.p95 <= target.p95;
		lines.push(`| ${event} | ${wall.n} | ${s(wall.p50)} | ${s(wall.p95)} | ${wall.n ? (met ? "met" : "missed") : "-"} |`);
	}
	lines.push("", "## Critical path (the job that ended last in each run)", "", "| bucket | p50 | p95 |", "| --- | --- | --- |");
	for (const [bucket, value] of Object.entries(summary.criticalPath)) lines.push(`| ${bucket} | ${s(value.p50)} | ${s(value.p95)} |`);
	lines.push("", `Biggest critical-path bucket: ${summary.biggest}.`, "",
		`Runner minutes: setup ${summary.runnerMinutes.setup.toFixed(1)}, running ${summary.runnerMinutes.running.toFixed(1)}.`,
		"", "## Jobs (slowest first, p50 / p95)", "",
		"| job | runs | waiting | setup | running | total |", "| --- | --- | --- | --- | --- | --- |");
	for (const job of summary.jobs) {
		const cell = (value) => `${s(value.p50)} / ${s(value.p95)}`;
		lines.push(`| ${job.name} | ${job.n} | ${cell(job.waiting)} | ${cell(job.setup)} | ${cell(job.running)} | ${cell(job.total)} |`);
	}
	lines.push("", "## Slowest steps (p50 / p95)", "", "| job | step | bucket | runs | p50 | p95 |", "| --- | --- | --- | --- | --- | --- |");
	for (const step of summary.steps) lines.push(`| ${step.job} | ${step.step} | ${step.bucket} | ${step.n} | ${s(step.p50)} | ${s(step.p95)} |`);
	return `${lines.join("\n")}\n`;
}
