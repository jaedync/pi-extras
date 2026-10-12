import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { HELPER, mediaHome } from "../lib/link-context/media/provision.ts";

// Every server here listens on 127.0.0.1 only; no request goes to a real private or metadata address.
const python = ["python3", "python"].find((bin) => spawnSync(bin, ["--version"]).status === 0);
const mediaPython = join(mediaHome(), "env", "bin", "python");
const hasYtDlp = existsSync(mediaPython) && spawnSync(mediaPython, ["-I", "-c", "import yt_dlp"]).status === 0;
const NO_PROXY_ENV = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:https?|all|no)_proxy$/i.test(name)));

interface Local { readonly port: number; readonly hits: string[]; readonly close: () => Promise<void> }

async function listen(answer: (path: string, res: import("node:http").ServerResponse) => void): Promise<Local> {
	const hits: string[] = [];
	const server: Server = createServer((req, res) => {
		hits.push(req.url ?? "");
		answer(req.url ?? "", res);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	return { port, hits, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

function runPython(bin: string, args: string[], input = ""): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(bin, args, { env: NO_PROXY_ENV, cwd: tmpdir() });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("close", (code) => resolve({ code, stdout, stderr }));
		child.stdin.end(input);
	});
}

test("guard: private, loopback, link-local, metadata and embedded-IPv4 addresses are refused", { skip: python ? false : "python3 not available" }, () => {
	const refused = ["127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "198.18.0.1", "::1", "fe80::1", "fec0::1", "fd00::1", "::ffff:127.0.0.1", "64:ff9b::a9fe:a9fe", "2002:7f00:1::", "2001:0:4136:e378::1", "fd00:ec2::254"];
	const allowed = ["93.184.216.34", "8.8.8.8", "2606:4700::1111"];
	const code = `import sys, json; sys.path.insert(0, sys.argv[1]); import net_guard
print(json.dumps({a: net_guard.private_address(a) for a in sys.argv[2:]}))`;
	const result = spawnSync(python as string, ["-I", "-B", "-c", code, dirname(HELPER), ...refused, ...allowed], { encoding: "utf8" });
	assert.equal(result.status, 0, result.stderr);
	const verdicts = JSON.parse(result.stdout) as Record<string, boolean>;
	for (const address of refused) assert.equal(verdicts[address], true, address);
	for (const address of allowed) assert.equal(verdicts[address], false, address);
});

test("guard proxy: plain and CONNECT requests to a loopback host are refused unless the test allows that exact host", { skip: python ? false : "python3 not available" }, async (t) => {
	const target = await listen((_path, res) => res.end("secret"));
	t.after(target.close);
	const code = `import sys, json, socket, urllib.request; sys.path.insert(0, sys.argv[1]); import net_guard
port = int(sys.argv[2])
def get(proxy):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy}))
    try:
        return opener.open(f"http://127.0.0.1:{port}/x", timeout=10).read().decode()
    except Exception as error:
        return str(error)
def connect(proxy):
    host, proxy_port = proxy.rsplit(":", 1)
    with socket.create_connection(("127.0.0.1", int(proxy_port)), timeout=10) as s:
        s.sendall(f"CONNECT 127.0.0.1:{port} HTTP/1.1\\r\\nHost: 127.0.0.1:{port}\\r\\n\\r\\n".encode())
        return s.recv(200).decode().split("\\r\\n")[0]
strict = net_guard.start()
allowing = net_guard.start([f"127.0.0.1:{port}"])
print(json.dumps({"get": get(strict), "connect": connect(strict), "allowed": get(allowing), "refused": net_guard.REFUSED}))`;
	const result = await runPython(python as string, ["-I", "-B", "-c", code, dirname(HELPER), String(target.port)]);
	assert.equal(result.code, 0, result.stderr);
	const out = JSON.parse(result.stdout) as { get: string; connect: string; allowed: string; refused: string[] };
	assert.match(out.get, /403/);
	assert.match(out.connect, /^HTTP\/1\.1 403/);
	assert.equal(out.allowed, "secret");
	assert.deepEqual(target.hits, ["/x"], "only the allowed request reached the server");
	assert.deepEqual(out.refused, ["127.0.0.1", "127.0.0.1"]);
});

test("yt-dlp: a redirect to a loopback host is refused, and the second server gets no request", { skip: hasYtDlp ? false : "the media tools are not installed" }, async (t) => {
	const second = await listen((_path, res) => res.writeHead(200, { "content-type": "video/mp4" }).end("not a video"));
	const first = await listen((_path, res) => res.writeHead(302, { location: `http://127.0.0.1:${second.port}/internal/video.mp4` }).end());
	const dir = mkdtempSync(join(tmpdir(), "link-guard-"));
	t.after(async () => {
		await first.close();
		await second.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const request = { url: `http://127.0.0.1:${first.port}/watch`, kind: "video", dir, sections: [[0, 1]], testAllowTargets: [`127.0.0.1:${first.port}`] };
	for (const command of ["info", "download"]) {
		const result = await runPython(mediaPython, ["-I", "-B", HELPER, command], JSON.stringify(request));
		assert.equal(result.code, 1, `${command}: ${result.stdout}`);
		assert.match(JSON.parse(result.stdout).error, /^Refusing a private or local address: 127\.0\.0\.1/, command);
	}
	assert.ok(first.hits.length >= 2);
	assert.deepEqual(second.hits, [], "the redirect target was never requested");
});
