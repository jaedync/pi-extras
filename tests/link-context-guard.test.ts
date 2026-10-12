import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
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

/** A hostile server: it ignores "Connection: close" and answers every request on a connection, as the first host would. */
async function keepAlive(name: string): Promise<Local> {
	const hits: string[] = [];
	const server = createNetServer((socket) => {
		let buffer = "";
		socket.on("data", (chunk) => {
			buffer += chunk.toString("latin1");
			let end = buffer.indexOf("\r\n\r\n");
			while (end >= 0) {
				const head = buffer.slice(0, end);
				buffer = buffer.slice(end + 4);
				hits.push(head.split("\r\n")[0].split(" ")[1] ?? "");
				socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${name.length}\r\nConnection: keep-alive\r\nKeep-Alive: timeout=60\r\n\r\n${name}`);
				end = buffer.indexOf("\r\n\r\n");
			}
		});
		socket.on("error", () => {});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as { port: number }).port;
	return { port, hits, close: () => new Promise((resolve) => { server.close(() => resolve()); }) };
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

test("guard proxy: one plain request per connection, so a reused connection never carries a request to the first host", { skip: python ? false : "python3 not available" }, async (t) => {
	const bodies: string[] = [];
	const first = await keepAlive("first");
	const second = await keepAlive("second");
	const poster = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk));
		req.on("end", () => {
			bodies.push(body);
			res.end("posted");
		});
	});
	await new Promise<void>((resolve) => poster.listen(0, "127.0.0.1", resolve));
	const posterPort = (poster.address() as { port: number }).port;
	t.after(async () => {
		await first.close();
		await second.close();
		await new Promise((resolve) => poster.close(resolve));
	});
	const code = `import sys, json, socket; sys.path.insert(0, sys.argv[1]); import net_guard
a, b, p = sys.argv[2], sys.argv[3], sys.argv[4]
proxy = net_guard.start([f"127.0.0.1:{a}", f"127.0.0.1:{b}", f"127.0.0.1:{p}"])
port = int(proxy.rsplit(":", 1)[1])
def read_response(s):
    data = b""
    while b"\\r\\n\\r\\n" not in data:
        chunk = s.recv(4096)
        if not chunk:
            break
        data += chunk
    head, _, rest = data.partition(b"\\r\\n\\r\\n")
    length = int([l.split(b":")[1] for l in head.split(b"\\r\\n") if l.lower().startswith(b"content-length")][0])
    while len(rest) < length:
        rest += s.recv(4096)
    return head.decode(), rest[:length].decode()
with socket.create_connection(("127.0.0.1", port), timeout=10) as s:
    s.sendall(f"GET http://127.0.0.1:{a}/x HTTP/1.1\\r\\nHost: 127.0.0.1:{a}\\r\\nConnection: keep-alive\\r\\n\\r\\n".encode())
    head, body = read_response(s)
    try:
        s.sendall(f"GET http://127.0.0.1:{b}/y HTTP/1.1\\r\\nHost: 127.0.0.1:{b}\\r\\nCookie: session=secret\\r\\n\\r\\n".encode())
        after = s.recv(4096).decode()
    except OSError as error:
        after = type(error).__name__
with socket.create_connection(("127.0.0.1", port), timeout=10) as s:
    s.sendall(f"POST http://127.0.0.1:{p}/form HTTP/1.1\\r\\nHost: 127.0.0.1:{p}\\r\\nContent-Length: 5\\r\\n\\r\\nhello".encode())
    posted = read_response(s)[1]
print(json.dumps({"head": head, "body": body, "after": after, "posted": posted}))`;
	const result = await runPython(python as string, ["-I", "-B", "-c", code, dirname(HELPER), String(first.port), String(second.port), String(posterPort)]);
	assert.equal(result.code, 0, result.stderr);
	const out = JSON.parse(result.stdout) as { head: string; body: string; after: string; posted: string };
	assert.equal(out.body, "first");
	assert.match(out.head, /\r\nConnection: close(\r\n|$)/i);
	assert.doesNotMatch(out.head, /keep-alive/i);
	assert.equal(out.after.startsWith("HTTP"), false, `the closed connection answered: ${out.after}`);
	assert.deepEqual(first.hits, ["/x"], "the second request never reached the first host");
	assert.deepEqual(second.hits, []);
	assert.equal(out.posted, "posted");
	assert.deepEqual(bodies, ["hello"]);
});

test("guard proxy: a DNS failure is a 502, NAT64 is checked by its IPv4 address, and each checked address is tried", { skip: python ? false : "python3 not available" }, async (t) => {
	const target = await listen((_path, res) => res.end("reached"));
	t.after(target.close);
	const code = `import sys, json, socket, urllib.request; sys.path.insert(0, sys.argv[1]); import net_guard
port = int(sys.argv[2])
real = socket.getaddrinfo
def fake(host, *args, **kwargs):
    if host == "nowhere.test":
        raise socket.gaierror(socket.EAI_NONAME, "no such name")
    if host == "two.test":
        # The server listens on 127.0.0.1 only, so the first address refuses the connection.
        return [(socket.AF_INET6, socket.SOCK_STREAM, 6, "", ("::1", port, 0, 0)), (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", port))]
    return real(host, *args, **kwargs)
socket.getaddrinfo = fake
proxy = net_guard.start([f"two.test:{port}"])
opener = urllib.request.build_opener(urllib.request.ProxyHandler({"http": proxy}))
def get(url):
    try:
        return opener.open(url, timeout=10).read().decode()
    except urllib.error.HTTPError as error:
        return f"{error.code} {error.read().decode().strip()}"
out = {"dns": get("http://nowhere.test/"), "two": get(f"http://two.test:{port}/"), "refused": net_guard.REFUSED,
       "nat64": [net_guard.private_address(a) for a in ("64:ff9b::808:808", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::1")],
       "queue": net_guard.Server.request_queue_size}
print(json.dumps(out))`;
	const result = await runPython(python as string, ["-I", "-B", "-c", code, dirname(HELPER), String(target.port)]);
	assert.equal(result.code, 0, result.stderr);
	const out = JSON.parse(result.stdout) as { dns: string; two: string; refused: string[]; nat64: boolean[]; queue: number };
	assert.match(out.dns, /^502 .*could not resolve nowhere\.test/);
	assert.deepEqual(out.refused, [], "a DNS failure is not reported as a private address");
	assert.equal(out.two, "reached");
	assert.deepEqual(out.nat64, [false, true, true, true]);
	assert.equal(out.queue, 128);
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
