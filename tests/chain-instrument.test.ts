import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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
