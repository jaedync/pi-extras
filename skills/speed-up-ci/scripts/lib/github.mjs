import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
export const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const PAGE = 100;

const ATTEMPTS = 4;
const SERVER_ERROR = /HTTP 5\d\d|Server Error|timed out|ECONNRESET/i;

/**
 * The API answers some job lists with a 502 under load. Read calls only, so a repeat after a server error is safe; a
 * 4xx (auth, rate limit, not found) stops at once.
 * @param {string} path
 */
async function gh(path) {
	for (let attempt = 1; ; attempt++) {
		try {
			const { stdout } = await run("gh", ["api", "-H", "Accept: application/vnd.github+json", path], { maxBuffer: 64 * 1024 * 1024 });
			return JSON.parse(stdout);
		} catch (error) {
			const text = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : String(error);
			if (attempt >= ATTEMPTS || !SERVER_ERROR.test(text)) throw new Error(`gh api ${path}: ${text.trim()}`);
			await new Promise((done) => setTimeout(done, 1000 * 2 ** attempt));
		}
	}
}

/** @param {string} repo @param {number} id */
async function jobsOf(repo, id) {
	const jobs = [];
	for (let page = 1; ; page++) {
		const body = await gh(`repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=${PAGE}&page=${page}`);
		jobs.push(...body.jobs.map(pickJob));
		if (body.jobs.length < PAGE || jobs.length >= body.total_count) return jobs;
	}
}

/**
 * Up to `limit` completed runs, newest first, each with the jobs of its latest attempt. Queued and running runs are
 * left out: their times are not final.
 * @param {{ repo: string, limit: number, workflow?: string, event?: string, branch?: string, concurrency?: number }} options
 */
export async function fetchRuns({ repo, limit, workflow, event, branch, concurrency = 8 }) {
	if (!REPO.test(repo)) throw new Error(`repository must be owner/name, not ${JSON.stringify(repo)}`);
	const base = workflow ? `repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs` : `repos/${repo}/actions/runs`;
	const filters = new URLSearchParams({ status: "completed", per_page: String(PAGE) });
	if (event) filters.set("event", event);
	if (branch) filters.set("branch", branch);
	const runs = [];
	for (let page = 1; runs.length < limit; page++) {
		const body = await gh(`${base}?${filters}&page=${page}`);
		runs.push(...body.workflow_runs);
		if (body.workflow_runs.length < PAGE) break;
	}
	const chosen = runs.slice(0, limit);
	const out = new Array(chosen.length);
	let next = 0;
	async function worker() {
		while (next < chosen.length) {
			const i = next++;
			out[i] = { run: pick(chosen[i]), jobs: await jobsOf(repo, chosen[i].id) };
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, chosen.length) }, worker));
	return out;
}

/** @param {any} job */
function pickJob(job) {
	const { name, conclusion, labels, created_at, started_at, completed_at } = job;
	const steps = (job.steps ?? []).map(({ name: step, conclusion: result, started_at: from, completed_at: to }) =>
		({ name: step, conclusion: result, started_at: from, completed_at: to }));
	return { name, conclusion, labels, created_at, started_at, completed_at, steps };
}

/** Keep the fields the audit reads, so a saved file stays small and holds no commit text. @param {any} run */
function pick(run) {
	const { id, name, event, head_branch, head_sha, conclusion, run_attempt, created_at, run_started_at, updated_at } = run;
	return { id, name, event, head_branch, head_sha, conclusion, run_attempt, created_at, run_started_at, updated_at };
}
