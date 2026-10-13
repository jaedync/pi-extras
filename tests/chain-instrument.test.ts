import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { instrument, MarkStripper, supportedShell, type Mark } from "../lib/chain/instrument.ts";
import { splitChain } from "../lib/chain/split.ts";

const NONCE = "t3st";

/** Runs the original and the rewrite, strips the marks from the rewrite's output, and returns both. */
function compare(shell: string, command: string) {
	const chain = splitChain(command);
	assert.ok(chain, `splits: ${command}`);
	const original = spawnSync(shell, ["-c", command], { encoding: "buffer", cwd: "/" });
	const rewritten = spawnSync(shell, ["-c", instrument(chain, NONCE)], { encoding: "buffer", cwd: "/" });
	const marks: Mark[] = [];
	const clean = (buffer: Buffer) => {
		const stripper = new MarkStripper(NONCE);
		const pieces = [...stripper.push(buffer), ...stripper.flush()];
		for (const piece of pieces) if (!Buffer.isBuffer(piece)) marks.push(piece);
		return Buffer.concat(pieces.filter((piece): piece is Buffer => Buffer.isBuffer(piece))).toString();
	};
	return {
		original: { stdout: original.stdout.toString(), stderr: original.stderr.toString(), code: original.status },
		rewritten: { stdout: clean(rewritten.stdout), stderr: rewritten.stderr.toString(), code: rewritten.status },
		marks,
	};
}

const COMMANDS = [
	"echo a && echo b && echo c",
	"false || echo handled",
	"false && echo never; echo after",
	"echo x; false",
	"false; echo $?",
	"(exit 3) || echo \"got $?\"",
	"x=5 && echo \"x is $x\"",
	"cd /tmp && pwd && cd .. && pwd",
	"printf abc && printf def",
	"echo out; echo err >&2; echo more",
	"# a comment\necho one # trailing && not a split\necho two",
	"echo 'a && b' && echo \"c; d\" && echo $(echo e && echo f)",
	"true && { echo grouped; echo still; } && echo done",
	"echo first \\\n  second && echo third",
	"f=$(printf 'x\\036y') && printf '%s\\n' \"$f\"",
];

for (const shell of ["/bin/bash", "/bin/sh", "/bin/zsh"]) {
	test(`the rewrite runs exactly like the original in ${shell}`, { skip: !existsSync(shell) }, () => {
		for (const command of COMMANDS) {
			const { original, rewritten } = compare(shell, command);
			assert.deepEqual(rewritten, original, command);
		}
	});
}

/** As `compare`, with Pi's shellCommandPrefix on the line before and an environment of its own. */
function compareUnder(shell: string, command: string, prefix: string, env: NodeJS.ProcessEnv = {}) {
	const chain = splitChain(command);
	assert.ok(chain, `splits: ${command}`);
	const run = (script: string) => spawnSync(shell, ["-c", prefix ? `${prefix}\n${script}` : script], { encoding: "buffer", cwd: "/", env: { PATH: process.env.PATH, ...env } });
	const original = run(command);
	const rewritten = run(instrument(chain, NONCE));
	const stripper = new MarkStripper(NONCE);
	const clean = Buffer.concat([...stripper.push(rewritten.stdout), ...stripper.flush()].filter((piece): piece is Buffer => Buffer.isBuffer(piece))).toString();
	return {
		original: { stdout: original.stdout.toString(), stderr: original.stderr.toString(), code: original.status },
		rewritten: { stdout: clean, stderr: rewritten.stderr.toString(), code: rewritten.status },
	};
}

// Recovery with || and &&, steps whose failure errexit ignores, and steps that end the script.
const ERREXIT_COMMANDS = [
	"ls /nonexistent || echo missing; echo done",
	"grep -q zzz /etc/hosts || true\necho after",
	"test -f nope && echo yes || echo no; echo end",
	"false || echo recovered; echo next",
	"false && echo never; echo after",
	"! true; echo after",
	"true && ! true; echo after",
	"{ false && true; }; echo after",
	"echo a && (exit 3) || echo \"got $?\"; echo b",
	"false; echo unreachable",
	"false || false; echo unreachable",
	"echo a; (exit 4)",
];

for (const [shell, prefix] of [["/bin/bash", ""], ["/bin/bash", "set -euo pipefail"], ["/bin/sh", "set -e"], ["/bin/zsh", "set -e"]] as const) {
	test(`errexit from a ${prefix || "missing"} prefix decides as it would without the rewrite in ${shell}`, { skip: !existsSync(shell) }, () => {
		for (const command of ERREXIT_COMMANDS) {
			const { original, rewritten } = compareUnder(shell, command, prefix);
			assert.deepEqual(rewritten, original, command);
		}
	});
}

test("errexit set inside the command, from SHELLOPTS or from BASH_ENV changes nothing either", { skip: !existsSync("/bin/bash") }, () => {
	for (const command of ["shopt -so errexit; false || echo recovered; echo next", "builtin set -e; ls /nonexistent || echo missing; echo done", "shopt -so errexit; ! true; echo after"]) {
		const { original, rewritten } = compareUnder("/bin/bash", command, "");
		assert.deepEqual(rewritten, original, command);
	}
	const dir = mkdtempSync(join(tmpdir(), "chain-errexit-"));
	try {
		const bashEnv = join(dir, "env.sh");
		writeFileSync(bashEnv, "set -e\n");
		for (const env of [{ SHELLOPTS: "errexit" }, { BASH_ENV: bashEnv }]) {
			for (const command of ERREXIT_COMMANDS) {
				const { original, rewritten } = compareUnder("/bin/bash", command, "", env);
				assert.deepEqual(rewritten, original, `${JSON.stringify(env)} ${command}`);
			}
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// bash drops the rest of a line after an arithmetic error, so steps joined by `;` must share a line, and steps on lines of their own must not.
const ARITHMETIC_COMMANDS = [
	"m=08; echo $((m+1)); echo next",
	"m=08; echo $((m+1)) && echo ok; echo next",
	"echo a\necho $((08))\necho n",
	"x=; echo $((x+)); echo after",
	"echo $[1/0]; echo after",
	"echo a;\necho $((08)); echo b\necho c",
	"echo a; { echo $((08)); }; echo b",
];
// Another bash to compare with, such as a newer one than macOS ships: PI_TEST_BASH=/path/to/bash.
const EXTRA_BASH = process.env.PI_TEST_BASH;

for (const shell of ["/bin/bash", EXTRA_BASH ?? "", "/bin/sh", "/bin/zsh"]) {
	test(`an arithmetic error ends as much of the script as without the rewrite in ${shell || "PI_TEST_BASH (unset)"}`, { skip: shell === "" || !existsSync(shell) }, () => {
		for (const prefix of ["", "set -e"]) {
			for (const command of ARITHMETIC_COMMANDS) {
				const { original, rewritten } = compareUnder(shell, command, prefix);
				// Line numbers in the error text move with the rewrite, as they always did.
				const lineless = (run: typeof original) => ({ ...run, stderr: run.stderr.replace(/(?:line )?\d+: /g, "") });
				assert.deepEqual(lineless(rewritten), lineless(original), `${prefix} ${command}`);
			}
		}
	});
}

test("each step reports its start and its exit status", { skip: !existsSync("/bin/bash") }, () => {
	const { marks } = compare("/bin/bash", "echo a && false || echo c; (exit 4)");
	assert.deepEqual(marks, [
		{ kind: "start", step: 0 }, { kind: "end", step: 0, code: 0 },
		{ kind: "start", step: 1 }, { kind: "end", step: 1, code: 1 },
		{ kind: "start", step: 2 }, { kind: "end", step: 2, code: 0 },
		{ kind: "start", step: 3 }, { kind: "end", step: 3, code: 4 },
	]);
});

test("a skipped step writes no marks", { skip: !existsSync("/bin/bash") }, () => {
	const { marks } = compare("/bin/bash", "false && echo never && echo nor; echo last");
	assert.deepEqual(marks.map((mark) => `${mark.kind}${mark.step}`), ["start0", "end0", "start3", "end3"]);
});

test("marks split across chunks are still removed, and other bytes pass through", () => {
	const stripper = new MarkStripper(NONCE);
	const stream = Buffer.from(`out\x1ePI:${NONCE}:s 1\nmore\x1eother\n\x1ePI:${NONCE}:e 1 7\ntail\x1e`);
	const pieces: Array<Buffer | Mark> = [];
	for (let index = 0; index < stream.length; index += 3) pieces.push(...stripper.push(stream.subarray(index, index + 3)));
	pieces.push(...stripper.flush());
	const text = Buffer.concat(pieces.filter((piece): piece is Buffer => Buffer.isBuffer(piece))).toString();
	assert.equal(text, "outmore\x1eother\ntail\x1e");
	assert.deepEqual(pieces.filter((piece) => !Buffer.isBuffer(piece)), [{ kind: "start", step: 0 }, { kind: "end", step: 0, code: 7 }]);
});

test("a mark with another nonce is ordinary output", () => {
	const stripper = new MarkStripper(NONCE);
	const text = Buffer.from(`\x1ePI:other:s 1\n`);
	assert.deepEqual(Buffer.concat([...stripper.push(text), ...stripper.flush()].filter(Buffer.isBuffer)).toString(), text.toString());
});

test("only POSIX shells get the rewrite", () => {
	assert.equal(supportedShell("/bin/bash"), true);
	assert.equal(supportedShell("/usr/local/bin/zsh"), true);
	assert.equal(supportedShell("/bin/sh"), true);
	assert.equal(supportedShell("C:\\Program Files\\Git\\bin\\bash.exe"), true);
	assert.equal(supportedShell("/usr/bin/fish"), false);
	assert.equal(supportedShell("/usr/bin/nu"), false);
	assert.equal(supportedShell(undefined), false);
});
