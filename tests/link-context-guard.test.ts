import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { HELPER } from "../lib/link-context/media/provision.ts";

// Every server here listens on 127.0.0.1 only; no request goes to a real private or metadata address.
const systemPython = ["python3", "python"].find((bin) => spawnSync(bin, ["--version"]).status === 0);
// The yt-dlp tests run only with an explicit media Python (PI_LINK_TEST_MEDIA_PYTHON=~/.cache/pi-extras/link-context/env/bin/python),
// never the user's install by default; each child gets a temporary HOME and cache.
const mediaPython = process.env.PI_LINK_TEST_MEDIA_PYTHON;
const hasYtDlp = !!mediaPython && existsSync(mediaPython) && spawnSync(mediaPython, ["-I", "-B", "-c", "import yt_dlp"]).status === 0;
const SKIP_YTDLP = hasYtDlp ? false : "set PI_LINK_TEST_MEDIA_PYTHON to a Python with yt-dlp";
const childHome = mkdtempSync(join(tmpdir(), "link-guard-home-"));
process.on("exit", () => rmSync(childHome, { recursive: true, force: true }));
// The guard runs on the media Python (3.12); the system one is the fallback for its address and proxy tests.
const python = hasYtDlp ? mediaPython : systemPython;
const NO_PROXY_ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:https?|all|no)_proxy$/i.test(name))), HOME: childHome, XDG_CACHE_HOME: join(childHome, ".cache") };

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

function runPython(bin: string, args: string[], input = "", env: NodeJS.ProcessEnv = NO_PROXY_ENV): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(bin, args, { env, cwd: tmpdir() });
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
	const result = spawnSync(python as string, ["-I", "-B", "-c", code, dirname(HELPER), ...refused, ...allowed], { encoding: "utf8", env: NO_PROXY_ENV });
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

test("yt-dlp: a redirect to a loopback host is refused, and the second server gets no request", { skip: SKIP_YTDLP }, async (t) => {
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
		const result = await runPython(mediaPython as string, ["-I", "-B", HELPER, command], JSON.stringify(request));
		assert.equal(result.code, 1, `${command}: ${result.stdout}`);
		assert.match(JSON.parse(result.stdout).error, /^Refusing a private or local address: 127\.0\.0\.1/, command);
	}
	assert.ok(first.hits.length >= 2);
	assert.deepEqual(second.hits, [], "the redirect target was never requested");
});

/** A bare TCP listener that records any connection, with an FTP banner so an FTP client sends its first command. */
async function rawListener(): Promise<Local> {
	const hits: string[] = [];
	const server = createNetServer((socket) => {
		socket.on("error", () => {});
		socket.write("220 hi\r\n");
		socket.once("data", (chunk) => hits.push(chunk.toString("latin1").slice(0, 40)));
		hits.push("connect");
		setTimeout(() => socket.destroy(), 500);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { port: (server.address() as { port: number }).port, hits, close: () => new Promise((resolve) => { server.close(() => resolve()); }) };
}

test("helper: formats on other schemes are refused before a download, and ffmpeg reads only HTTP", { skip: systemPython ? false : "python3 not available" }, () => {
	const code = `import sys, json; sys.path.insert(0, sys.argv[1]); import helper
info = {"requested_formats": [{"url": "https://cdn.test/v.mp4"}, {"url": "ftp://10.0.0.5/a.m4a"}]}
plain = {"url": "http://cdn.test/v.mp4", "fragments": [{"url": "rtsp://10.0.0.5/f1"}]}
safe = {"url": "https://cdn.test/v.m3u8", "manifest_url": "https://cdn.test/v.m3u8", "fragments": [{"path": "seg1.ts"}, {"url": "data:video/mp2t;base64,AA=="}]}
print(json.dumps({"mixed": helper.other_scheme_urls(info), "fragment": helper.other_scheme_urls(plain), "safe": helper.other_scheme_urls(safe),
    "ffmpeg": helper.download_limits("video")["external_downloader_args"]}))`;
	const result = spawnSync(systemPython as string, ["-I", "-B", "-c", code, dirname(HELPER)], { encoding: "utf8", env: NO_PROXY_ENV });
	assert.equal(result.status, 0, result.stderr);
	const out = JSON.parse(result.stdout) as { mixed: string[]; fragment: string[]; safe: string[]; ffmpeg: Record<string, string[]> };
	assert.deepEqual(out.mixed, ["ftp://10.0.0.5/a.m4a"]);
	assert.deepEqual(out.fragment, ["rtsp://10.0.0.5/f1"]);
	assert.deepEqual(out.safe, []);
	assert.deepEqual(out.ffmpeg, { ffmpeg_i: ["-protocol_whitelist", "http,https,tls,tcp,crypto,data,httpproxy"] });
});

test("guard proxy: an ftp:// request sent through it is refused", { skip: python ? false : "python3 not available" }, async (t) => {
	const ftp = await rawListener();
	t.after(ftp.close);
	const code = `import sys, socket; sys.path.insert(0, sys.argv[1]); import net_guard
proxy = net_guard.start([f"127.0.0.1:{sys.argv[2]}"])
with socket.create_connection(("127.0.0.1", int(proxy.rsplit(":", 1)[1])), timeout=10) as s:
    s.sendall(f"GET ftp://127.0.0.1:{sys.argv[2]}/v.mp4 HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\n\\r\\n".encode())
    print(s.recv(200).decode().split("\\r\\n")[0])`;
	const result = await runPython(python as string, ["-I", "-B", "-c", code, dirname(HELPER), String(ftp.port)]);
	assert.equal(result.code, 0, result.stderr);
	assert.match(result.stdout, /^HTTP\/1\.1 403/);
	assert.deepEqual(ftp.hits, [], "even an allowed host gets no ftp request");
});

test("yt-dlp: an ftp:// video, or HLS segments on ftp://, never reach ffmpeg's FTP client", { skip: SKIP_YTDLP }, async (t) => {
	const ftp = await rawListener();
	const page = await listen((path, res) => {
		const html = (src: string) => res.writeHead(200, { "content-type": "text/html" }).end(`<html><head><title>t</title></head><body><video src="${src}"></video></body></html>`);
		if (path === "/direct") html(`ftp://127.0.0.1:${ftp.port}/v.mp4`);
		else if (path === "/hls") html(`http://127.0.0.1:${page.port}/list.m3u8`);
		else res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl" }).end(`#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nftp://127.0.0.1:${ftp.port}/seg.ts\n#EXT-X-ENDLIST\n`);
	});
	const dir = mkdtempSync(join(tmpdir(), "link-guard-"));
	t.after(async () => {
		await ftp.close();
		await page.close();
		rmSync(dir, { recursive: true, force: true });
	});
	for (const [path, kind] of [["/direct", "video"], ["/direct", "audio"], ["/hls", "video"]]) {
		const request = { url: `http://127.0.0.1:${page.port}${path}`, kind, dir, sections: [[0, 1]], testAllowTargets: [`127.0.0.1:${page.port}`] };
		const result = await runPython(mediaPython as string, ["-I", "-B", HELPER, "download"], JSON.stringify(request));
		assert.equal(result.code, 1, `${path} ${kind}: ${result.stdout}`);
	}
	await new Promise((resolve) => setTimeout(resolve, 600));
	assert.deepEqual(ftp.hits, [], "the FTP listener got no connection");
});

/** A fake rtmpdump on PATH that records each run: yt-dlp would start it for rtmp:// media, and a real one connects around the guard. */
function fakeRtmpdump(): { bin: string; calls: () => string } {
	const bin = mkdtempSync(join(childHome, "fakebin-"));
	writeFileSync(join(bin, "rtmpdump"), `#!/bin/sh\necho "rtmpdump $*" >> "${bin}/calls.log"\ncase "$*" in *-h*|*--help*) echo "RTMPDump v2.4"; exit 0;; esac\nexit 1\n`, { mode: 0o755 });
	return { bin, calls: () => (existsSync(join(bin, "calls.log")) ? readFileSync(join(bin, "calls.log"), "utf8") : "") };
}

test("yt-dlp: media and captions on rtmp:// or ftp:// stop the call, and no external downloader runs", { skip: SKIP_YTDLP }, async (t) => {
	const ftp = await rawListener();
	const rtmpdump = fakeRtmpdump();
	const page = await listen((path, res) => {
		const [, scheme, mode] = /^\/(\w+)\/(\w+)$/.exec(path) ?? [];
		const media = mode === "captions" ? `http://127.0.0.1:${page.port}/v.mp4` : `${scheme}://127.0.0.1:${ftp.port}/v.mp4`;
		const track = mode === "captions" ? `<track kind="captions" srclang="en" src="${scheme}://127.0.0.1:${ftp.port}/sub.vtt">` : "";
		res.writeHead(200, { "content-type": "text/html" }).end(`<html><head><title>t</title></head><body><video src="${media}" type='video/mp4; codecs="avc1.42E01E"'>${track}</video></body></html>`);
	});
	const dir = mkdtempSync(join(tmpdir(), "link-guard-"));
	t.after(async () => {
		await ftp.close();
		await page.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const env = { ...NO_PROXY_ENV, PATH: `${rtmpdump.bin}:${process.env.PATH ?? ""}` };
	for (const scheme of ["rtmp", "ftp"]) {
		for (const sections of [[[0, 1]], undefined]) {
			const request = { url: `http://127.0.0.1:${page.port}/${scheme}/media`, kind: "video", dir, sections, testAllowTargets: [`127.0.0.1:${page.port}`] };
			const result = await runPython(mediaPython as string, ["-I", "-B", HELPER, "download"], JSON.stringify(request), env);
			assert.equal(result.code, 1, `${scheme} sections=${!!sections}: ${result.stdout}`);
			assert.match(JSON.parse(result.stdout).error, new RegExp(`only http and https media, not ${scheme}://`), `${scheme} sections=${!!sections}`);
		}
		const captions = { url: `http://127.0.0.1:${page.port}/${scheme}/captions`, dir, testAllowTargets: [`127.0.0.1:${page.port}`] };
		await runPython(mediaPython as string, ["-I", "-B", HELPER, "captions"], JSON.stringify(captions), env);
	}
	await new Promise((resolve) => setTimeout(resolve, 600));
	assert.equal(rtmpdump.calls().split("\n").filter((line) => line && !/-h|--help/.test(line)).join("\n"), "", "rtmpdump never ran for a download");
	assert.deepEqual(ftp.hits, [], "nothing connected to the listener");
});

test("guard proxy: a bad Content-Length is a 400, a closed client frees its thread, and a slow reader gets the whole body", { skip: python ? false : "python3 not available" }, async (t) => {
	const hostile = await keepAlive("kept");
	const big = Buffer.alloc(8 * 1024 * 1024, 0x61);
	const bulk = await listen((_path, res) => res.writeHead(200, { "content-length": String(big.length) }).end(big));
	t.after(async () => {
		await hostile.close();
		await bulk.close();
	});
	const code = `import sys, json, socket, threading, time; sys.path.insert(0, sys.argv[1]); import net_guard
net_guard.HEAD_TIMEOUT = 0.5
h, b = sys.argv[2], sys.argv[3]
proxy = net_guard.start([f"127.0.0.1:{h}", f"127.0.0.1:{b}"])
port = int(proxy.rsplit(":", 1)[1])
def status(extra):
    with socket.create_connection(("127.0.0.1", port), timeout=10) as s:
        s.sendall(f"POST http://127.0.0.1:{h}/p HTTP/1.1\\r\\nHost: x\\r\\n{extra}\\r\\nabcde".encode("latin-1"))
        return s.recv(100).decode().split("\\r\\n")[0]
# Byte 0xB2 reads as "²", which str.isdigit() accepts and int() refuses.
out = {"duplicate": status("Content-Length: 5\\r\\nContent-Length: 50\\r\\n"), "negative": status("Content-Length: -5\\r\\n"), "superscript": status("Content-Length: \\xb2\\r\\n")}
time.sleep(0.3)
before = threading.active_count()
for _ in range(5):
    with socket.create_connection(("127.0.0.1", port), timeout=10) as s:
        s.sendall(f"GET http://127.0.0.1:{h}/k HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n".encode())
        s.recv(4096)
time.sleep(1)
out["threads"] = threading.active_count() - before
with socket.create_connection(("127.0.0.1", port), timeout=30) as s:
    s.sendall(f"GET http://127.0.0.1:{b}/big HTTP/1.1\\r\\nHost: x\\r\\n\\r\\n".encode())
    time.sleep(1.5)
    got = b""
    while True:
        chunk = s.recv(1 << 20)
        if not chunk:
            break
        got += chunk
out["body"] = len(got.partition(b"\\r\\n\\r\\n")[2])
print(json.dumps(out))`;
	const result = await runPython(python as string, ["-I", "-B", "-c", code, dirname(HELPER), String(hostile.port), String(bulk.port)]);
	assert.equal(result.code, 0, result.stderr);
	assert.doesNotMatch(result.stderr, /Traceback/);
	const out = JSON.parse(result.stdout) as { duplicate: string; negative: string; superscript: string; threads: number; body: number };
	assert.match(out.duplicate, /^HTTP\/1\.1 400/);
	assert.match(out.negative, /^HTTP\/1\.1 400/);
	assert.match(out.superscript, /^HTTP\/1\.1 400/);
	assert.equal(out.threads, 0, "no guard thread waits on a keep-alive upstream after its client closed");
	assert.equal(out.body, big.length);
	assert.equal(hostile.hits.filter((path) => path === "/p").length, 0, "a bad request never goes upstream");
});
