import assert from "node:assert/strict";
import test from "node:test";
import { CODEX_CANDIDATES, clientPath, locateBinaries, type Signature } from "../lib/computer-use/binaries.ts";
import { jobPlist, JOB_LABEL_PREFIX, staleLabels } from "../lib/computer-use/gui-job.ts";

const HOME = "/Users/someone";
const OPENAI = "2DC432GLL2";
const signed = (identifier: string, teamId = OPENAI): Signature => ({ valid: true, identifier, teamId });

function locate(signatures: Record<string, Signature>, present = Object.keys(signatures)) {
	return locateBinaries(HOME, { exists: (path) => present.includes(path), read: (path) => signatures[path], realpath: (path) => path });
}

test("finds the signed codex helper and Computer Use client", () => {
	const found = locate({ [CODEX_CANDIDATES[0]]: signed("codex"), [clientPath(HOME)]: signed("com.openai.sky.CUAService.cli") });
	assert.deepEqual(found, { ok: true, codex: CODEX_CANDIDATES[0], client: clientPath(HOME) });
});

test("explains what is missing before anything runs", () => {
	const noChatGpt = locate({ [clientPath(HOME)]: signed("com.openai.sky.CUAService.cli") });
	assert.equal(noChatGpt.ok, false);
	assert.match(noChatGpt.ok ? "" : noChatGpt.problem, /ChatGPT app/);

	const noClient = locate({ [CODEX_CANDIDATES[0]]: signed("codex") });
	assert.match(noClient.ok ? "" : noClient.problem, /Computer Use/);
});

test("refuses binaries that are not OpenAI's, or a codex Computer Use would not accept", () => {
	const client = { [clientPath(HOME)]: signed("com.openai.sky.CUAService.cli") };
	for (const codex of [signed("codex", "SOMEONEELSE"), { valid: false, identifier: "codex", teamId: OPENAI }, signed("com.example.codex")]) {
		const found = locate({ [CODEX_CANDIDATES[0]]: codex, ...client });
		assert.equal(found.ok, false, JSON.stringify(codex));
		assert.match(found.ok ? "" : found.problem, /not signed by OpenAI|not the codex helper/);
	}
	const tamperedClient = locate({ [CODEX_CANDIDATES[0]]: signed("codex"), [clientPath(HOME)]: signed("x", "SOMEONEELSE") });
	assert.equal(tamperedClient.ok, false);
});

test("the job plist runs the command in the GUI session, wired to the run directory's pipes", () => {
	const plist = jobPlist({ label: `${JOB_LABEL_PREFIX}1.ab`, command: "/Applications/ChatGPT.app/Contents/Resources/codex", args: ["sandbox", "a&b"], env: { PATH: "/usr/bin" }, runDir: "/tmp/run" });
	assert.match(plist, /<string>\/Applications\/ChatGPT\.app\/Contents\/Resources\/codex<\/string><string>sandbox<\/string><string>a&amp;b<\/string>/);
	assert.match(plist, /<key>StandardInPath<\/key><string>\/tmp\/run\/stdin<\/string>/);
	assert.match(plist, /<key>ProcessType<\/key><string>Interactive<\/string>/);
	assert.doesNotMatch(plist, /KeepAlive/);
});

test("only jobs whose Pi process is gone count as stale", () => {
	const listing = [
		"PID\tStatus\tLabel",
		`-\t0\t${JOB_LABEL_PREFIX}111.aaaa`,
		`42\t0\t${JOB_LABEL_PREFIX}222.bbbb`,
		"-\t0\tcom.pi-extras.voice.capture.111.1",
		`-\t0\t${JOB_LABEL_PREFIX}notapid.cccc`,
	].join("\n");
	assert.deepEqual(staleLabels(listing, (pid) => pid === 222), [`${JOB_LABEL_PREFIX}111.aaaa`]);
});
