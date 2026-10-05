// Upload the rendered social preview to the repository's Settings > Social preview when
// GitHub serves a different image. GitHub has no API for this setting, so the upload drives
// the settings page in Chromium with a saved GitHub web session. The page flow is adapted
// from ibrews/gh-social-upload (MIT), itself derived from AnswerDotAI/gh-social-preview (ISC).
//   npm run preview:upload -- --login   log in once in a browser window; saves the session
//   npm run preview:upload              upload .github/preview/pi-extras.png when it is due
//   npm run preview:upload -- --check   only say whether it is due (exit 1 when it is), and when the session expires
//   npm run preview:upload -- --force   upload even when GitHub already serves it
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PREVIEW_DIR, SOCIAL, socialProblems } from "./image-facts.mjs";

const root = resolve(fileURLToPath(new URL(".", import.meta.url)), "../..");
const GITHUB = "https://github.com";
const LOGIN_TIMEOUT_MS = 10 * 60_000;
const STEP_TIMEOUT_MS = 30_000;
// The repository page can serve the old og:image for a little while after an upload.
const VERIFY_TRIES = 12;
const VERIFY_EVERY_MS = 5_000;
const LOGIN = "npm run preview:upload -- --login";
const LOGIN_HINT = `Run: ${LOGIN}`;
const DAY_MS = 86_400_000;
// GitHub fixes the session's end at login (two weeks) and did not extend it on use, so warn in time to log in again.
const WARN_DAYS = 5;

export function repoSlug(pkg) {
	const url = typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
	const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(String(url ?? ""));
	if (!match) throw new Error("package.json does not name a GitHub repository.");
	return `${match[1]}/${match[2]}`;
}

export function ogImageUrl(html) {
	const match = /<meta[^>]+property="og:image"[^>]+content="([^"]+)"/.exec(html);
	if (!match) throw new Error("The repository page has no og:image.");
	return match[1].replaceAll("&amp;", "&");
}

/** Outside the repository: the file is a signed-in GitHub web session. */
export function sessionFile(env, home) {
	const state = env.XDG_STATE_HOME?.trim() || join(home, ".local", "state");
	return join(state, "pi-extras", "github-session.json");
}

/**
 * The image GitHub serves now, or undefined when it can't be read: right after an upload the
 * page names a fresh image that answers 403 until GitHub has published it.
 */
/** When the saved web session ends: GitHub signs out once its user_session cookie expires. */
export function sessionExpiry(state) {
	const cookie = state.cookies?.find((entry) => entry.name === "user_session" && entry.expires > 0);
	return cookie ? new Date(cookie.expires * 1000) : undefined;
}

export function sessionNote(expiry, now) {
	if (!expiry) return `No saved GitHub session. ${LOGIN_HINT}`;
	const day = expiry.toISOString().slice(0, 10);
	const left = expiry.getTime() - now;
	if (left <= 0) return `The GitHub session expired on ${day}. ${LOGIN_HINT}`;
	if (left < WARN_DAYS * DAY_MS) {
		const days = Math.ceil(left / DAY_MS);
		return `The GitHub session expires on ${day}, in ${days} ${days === 1 ? "day" : "days"}. Renew it now: ${LOGIN}`;
	}
	return `The GitHub session is valid until ${day}.`;
}

export function savedSessionExpiry(file) {
	return existsSync(file) ? sessionExpiry(JSON.parse(readFileSync(file, "utf8"))) : undefined;
}

async function servedImage(repo) {
	const page = await fetch(`${GITHUB}/${repo}`, { headers: { "cache-control": "no-cache" } });
	if (!page.ok) throw new Error(`GitHub answered ${page.status} for ${repo}.`);
	const image = await fetch(ogImageUrl(await page.text()));
	return image.ok ? Buffer.from(await image.arrayBuffer()) : undefined;
}

async function serves(repo, bytes) {
	return (await servedImage(repo))?.equals(bytes) === true;
}

/** Renders the git-ignored PNG from the committed frame, so it always matches this checkout. */
function localImage() {
	const dir = resolve(root, PREVIEW_DIR);
	const meta = join(dir, "meta.json");
	const kept = readFileSync(meta);
	execFileSync(process.execPath, [join(root, "scripts/preview/render.mjs"), "--reuse"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
	// --reuse stamps meta.json with this checkout's version; the committed file names the release that staged the frame.
	writeFileSync(meta, kept);
	const problems = socialProblems(dir);
	if (problems.length > 0) throw new Error(`The social preview is not ready: ${problems.join("; ")}.`);
	return join(dir, SOCIAL.file);
}

async function saveSession(context, file) {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	writeFileSync(file, JSON.stringify(await context.storageState()), { mode: 0o600 });
	// writeFileSync keeps the mode of an existing file.
	chmodSync(file, 0o600);
}

/** Opens the settings page with the saved session and keeps whatever cookies GitHub renews. */
async function openSettings(chromium, repo, file, work) {
	if (!existsSync(file)) throw new Error(`No saved GitHub session. ${LOGIN_HINT}`);
	const browser = await chromium.launch();
	try {
		const context = await browser.newContext({ storageState: file });
		const page = await context.newPage();
		page.setDefaultTimeout(STEP_TIMEOUT_MS);
		await page.goto(`${GITHUB}/${repo}/settings`);
		if (new URL(page.url()).pathname.startsWith("/login")) throw new Error(`The saved GitHub session has expired. ${LOGIN_HINT}`);
		await work(page);
		await saveSession(context, file);
	} finally {
		await browser.close();
	}
}

async function login(chromium, file) {
	const browser = await chromium.launch({ headless: false });
	try {
		const context = await browser.newContext();
		const page = await context.newPage();
		await page.goto(`${GITHUB}/login`);
		console.log("Log in to GitHub in the browser window. It closes by itself once you are in.");
		await page.waitForFunction(() => Boolean(document.querySelector('meta[name="user-login"]')?.getAttribute("content")?.trim()), null, { timeout: LOGIN_TIMEOUT_MS, polling: 500 });
		await saveSession(context, file);
		console.log(`Saved the GitHub session to ${file} (readable by you only).`);
	} finally {
		await browser.close();
	}
}

async function chooseImage(page, image) {
	await page.locator("xpath=//h2[normalize-space()='Social preview']").first().waitFor({ state: "attached" });
	const idInput = page.locator("input.js-repository-image-id").first();
	const before = (await idInput.count()) ? (await idInput.inputValue()).trim() : "";
	const edit = page.locator("#edit-social-preview-button")
		.or(page.locator("xpath=(//h2[normalize-space()='Social preview']/following::*[(self::button or self::summary) and normalize-space(.)='Edit'][1])")).first();
	if (await edit.count()) await edit.click({ force: true });
	// The PUT attaches the stored file to the repository; earlier responses only reserve the upload.
	const attached = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().includes("/upload/repository-images/") && response.ok());
	await page.locator("input#repo-image-file-input").first().setInputFiles(image);
	await attached;
	await page.waitForFunction((previous) => {
		const value = document.querySelector("input.js-repository-image-id")?.value?.trim();
		return Boolean(value) && value !== previous;
	}, before);
}

async function confirm(repo, bytes) {
	for (let attempt = 1; attempt <= VERIFY_TRIES; attempt++) {
		if (await serves(repo, bytes)) return;
		await new Promise((done) => setTimeout(done, VERIFY_EVERY_MS));
	}
	throw new Error(`GitHub accepted the upload, but ${GITHUB}/${repo} still serves another image after ${(VERIFY_TRIES * VERIFY_EVERY_MS) / 1000}s. Run npm run preview:upload -- --check later.`);
}

async function main(args) {
	const repo = repoSlug(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));
	const file = sessionFile(process.env, homedir());
	const { chromium } = await import("playwright-core");
	if (args.includes("--login")) return login(chromium, file);
	const image = localImage();
	const bytes = readFileSync(image);
	const due = args.includes("--force") || !(await serves(repo, bytes));
	if (args.includes("--check")) {
		console.log(due ? `The social preview of ${repo} is due: GitHub serves another image than ${image}.` : `The social preview of ${repo} is current.`);
		console.log(sessionNote(savedSessionExpiry(file), Date.now()));
		if (due) process.exitCode = 1;
		return;
	}
	if (!due) {
		// No upload, but a visit keeps the session's cookies fresh; an expired session is only a warning here.
		await openSettings(chromium, repo, file, async () => undefined).catch((error) => console.warn(error.message));
		console.log(`The social preview of ${repo} is current.`);
	} else {
		await openSettings(chromium, repo, file, (page) => chooseImage(page, image));
		await confirm(repo, bytes);
		console.log(`Uploaded ${image}; GitHub now serves it as the social preview of ${repo}.`);
	}
	console.log(sessionNote(savedSessionExpiry(file), Date.now()));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
