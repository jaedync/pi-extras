/**
 * `wv voice`: synthesize the narration with the local Kokoro model inside the
 * venv that `wv setup` created. No service, no network, no remote host.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SAMPLE_RATE, paths } from "./paths.mjs";
import { run } from "./proc.mjs";
import { checkVoice, voiceLanguage } from "./voices.mjs";

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Reads and checks the script before Python starts, so a typo costs no model load. */
export function readScript(file) {
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		throw new Error(`cannot read ${file}: ${error.message}`);
	}
	if (!Array.isArray(parsed) || parsed.length === 0) throw new Error(`${file} must be a non-empty array of {"id", "text"}`);
	const seen = new Set();
	return parsed.map((item, index) => {
		if (!item || typeof item !== "object") throw new Error(`${file}: line ${index} must be an object`);
		if (typeof item.id !== "string" || !ID.test(item.id)) throw new Error(`${file}: line ${index} id must match ${ID.source} (got ${JSON.stringify(item.id)})`);
		if (seen.has(item.id)) throw new Error(`${file}: duplicate id "${item.id}"`);
		seen.add(item.id);
		if (typeof item.text !== "string" || !item.text.trim()) throw new Error(`${file}: line ${index} (${item.id}) text must be a non-empty string`);
		return { id: item.id, text: item.text.trim() };
	});
}

export async function voice(options) {
	const log = options.log ?? (() => {});
	checkVoice(options.voice);
	const p = paths();
	if (!existsSync(p.python)) throw new Error(`the voice venv is not installed (${p.python}). Run "wv setup", then try again.`);
	const scriptPath = resolve(options.script);
	const lines = readScript(scriptPath);
	const outDir = resolve(options.out);
	mkdirSync(outDir, { recursive: true });

	const helper = join(dirname(fileURLToPath(import.meta.url)), "..", "voice.py");
	log(`synthesizing ${lines.length} line(s) with ${options.voice} (${voiceLanguage(options.voice)}), speed ${options.speed}`);
	const result = await run(p.python, [helper, "--script", scriptPath, "--out", outDir, "--voice", options.voice, "--speed", String(options.speed), "--model-dir", p.models], { timeoutMs: 30 * 60_000 });
	if (result.code !== 0) throw new Error(`voice synthesis failed: ${(result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ")}`);

	const written = JSON.parse(readFileSync(join(outDir, "voice.json"), "utf8"));
	if (!Array.isArray(written) || written.length !== lines.length) throw new Error(`voice.json must list ${lines.length} line(s), got ${Array.isArray(written) ? written.length : typeof written}`);
	const expected = new Set(lines.map((line) => line.id));
	for (const line of written) {
		if (!line || typeof line.id !== "string" || !ID.test(line.id)) throw new Error(`voice.json has an invalid id: ${JSON.stringify(line)}`);
		if (!expected.has(line.id)) throw new Error(`voice.json has an unexpected id "${line.id}"`);
		if (typeof line.text !== "string" || !line.text) throw new Error(`voice.json ${line.id}: text is missing`);
		if (typeof line.file !== "string" || !line.file.endsWith(".wav")) throw new Error(`voice.json ${line.id}: file must be a .wav name`);
		if (typeof line.seconds !== "number" || line.seconds <= 0) throw new Error(`voice.json ${line.id}: seconds must be a positive number`);
		if (!existsSync(join(outDir, line.file))) throw new Error(`voice.json names ${line.file}, which was not written`);
	}
	return { out: outDir, lines: written, sampleRate: SAMPLE_RATE, voice: options.voice, speed: options.speed };
}
