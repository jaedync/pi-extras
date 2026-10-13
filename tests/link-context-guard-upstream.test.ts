import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createServer as createTlsServer } from "node:tls";
import { HELPER } from "../lib/link-context/media/provision.ts";

// The guard with the user's own proxy behind it. Every server here, the fake proxies too, listens on 127.0.0.1 only.
const python = [process.env.PI_LINK_TEST_MEDIA_PYTHON, "python3", "python"].find((bin) => !!bin && spawnSync(bin, ["--version"]).status === 0);
const SKIP = python ? false : "python3 not available";
const mediaPython = process.env.PI_LINK_TEST_MEDIA_PYTHON;
const SKIP_YTDLP = mediaPython && spawnSync(mediaPython, ["-I", "-B", "-c", "import yt_dlp"]).status === 0 ? false : "set PI_LINK_TEST_MEDIA_PYTHON to a Python with yt-dlp";
const home = mkdtempSync(join(tmpdir(), "link-guard-upstream-"));
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
const BASE_ENV = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(?:https?|all|no)_proxy$/i.test(name))), HOME: home, XDG_CACHE_HOME: join(home, ".cache") };

interface Closable { readonly port: number; readonly close: () => Promise<void> }

async function listening<T extends Server>(server: T): Promise<{ server: T; port: number; close: () => Promise<void> }> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const sockets = new Set<Socket>();
	server.on("connection", (socket: Socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	server.on("secureConnection", (socket: Socket) => sockets.add(socket));
	const close = () => new Promise<void>((resolve) => {
		for (const socket of sockets) socket.destroy();
		server.close(() => resolve());
	});
	return { server, port: (server.address() as { port: number }).port, close };
}

/** The site the requests are for: it records each path and its Host header. */
async function origin(): Promise<Closable & { readonly hits: string[]; readonly hosts: string[] }> {
	const hits: string[] = [];
	const hosts: string[] = [];
	const big = Buffer.alloc(1024 * 1024, 0x62);
	const { port, close } = await listening(createHttpServer((req, res) => {
		hits.push(req.url ?? "");
		hosts.push(req.headers.host ?? "");
		res.writeHead(200, { "content-type": "text/plain" }).end(req.url === "/big" ? big : `origin ${req.url}`);
	}));
	return { port, hits, hosts, close };
}

/** Reads a socket in exact pieces, then hands the rest of its bytes to a pipe. */
function reader(socket: Socket): { take: (n: number) => Promise<Buffer>; head: () => Promise<string>; rest: () => Buffer } {
	let buffer = Buffer.alloc(0);
	let wake: (() => void) | undefined;
	socket.on("data", (chunk: Buffer) => {
		buffer = Buffer.concat([buffer, chunk]);
		wake?.();
	});
	const until = async (ready: () => boolean) => {
		while (!ready()) await new Promise<void>((resolve) => (wake = resolve));
	};
	return {
		take: async (n) => {
			await until(() => buffer.length >= n);
			const out = buffer.subarray(0, n);
			buffer = buffer.subarray(n);
			return out;
		},
		head: async () => {
			await until(() => buffer.includes("\r\n\r\n"));
			const end = buffer.indexOf("\r\n\r\n") + 4;
			const out = buffer.subarray(0, end).toString("latin1");
			buffer = buffer.subarray(end);
			return out;
		},
		rest: () => {
			socket.removeAllListeners("data");
			return buffer;
		},
	};
}

function splice(client: Socket, target: Socket, rest: Buffer): void {
	if (rest.length) target.write(rest);
	client.pipe(target).on("error", () => {});
	target.pipe(client).on("error", () => {});
	client.on("error", () => target.destroy());
	target.on("error", () => client.destroy());
}

/** A site that ignores "Connection: close" and keeps each connection open after its answer. */
async function keepAliveOrigin(): Promise<Closable> {
	const { port, close } = await listening(createServer((socket) => {
		socket.on("error", () => {});
		socket.once("data", () => socket.write("HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: keep-alive\r\n\r\nkept"));
	}));
	return { port, close };
}

interface FakeHttpProxy extends Closable { readonly lines: string[]; readonly auths: (string | undefined)[]; readonly hosts: (string | undefined)[] }

/** An HTTP proxy that records each request line, Proxy-Authorization and Host, then connects where the line says. */
async function httpProxy(options: { auth?: string; tls?: { key: string; cert: string } } = {}): Promise<FakeHttpProxy> {
	const lines: string[] = [];
	const auths: (string | undefined)[] = [];
	const hosts: (string | undefined)[] = [];
	const serve = async (client: Socket) => {
		client.on("error", () => {});
		const read = reader(client);
		const head = await read.head();
		const [line, ...headers] = head.slice(0, -4).split("\r\n");
		const field = (name: string) => headers.find((h) => h.toLowerCase().startsWith(`${name}:`))?.split(":").slice(1).join(":").trim();
		lines.push(line);
		auths.push(field("proxy-authorization"));
		hosts.push(field("host"));
		if (options.auth && field("proxy-authorization") !== options.auth) {
			client.end("HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n");
			return;
		}
		const [method, target, version] = line.split(" ");
		const url = method === "CONNECT" ? new URL(`http://${target}`) : new URL(target);
		const upstream = connect(Number(url.port || 80), url.hostname.replace(/^\[|\]$/g, ""));
		upstream.on("error", () => client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n"));
		upstream.on("connect", () => {
			if (method === "CONNECT") client.write("HTTP/1.1 200 Connection established\r\n\r\n");
			else upstream.write(`${method} ${url.pathname}${url.search} ${version}\r\n${headers.filter((h) => !/^proxy-/i.test(h)).join("\r\n")}\r\n\r\n`);
			splice(client, upstream, read.rest());
		});
	};
	const server = options.tls ? createTlsServer(options.tls, (socket) => void serve(socket)) : createServer((socket) => void serve(socket));
	const { port, close } = await listening(server);
	return { port, lines, auths, hosts, close };
}

interface FakeSocks extends Closable { readonly greetings: number[][]; readonly logins: string[]; readonly targets: string[] }

/** A SOCKS5 proxy (RFC 1928, RFC 1929) that records each greeting, login and target, and refuses the targets in `deny`. */
async function socks5(options: { login?: string; deny?: string[] } = {}): Promise<FakeSocks> {
	const greetings: number[][] = [];
	const logins: string[] = [];
	const targets: string[] = [];
	const serve = async (client: Socket) => {
		client.on("error", () => {});
		const read = reader(client);
		const [, count] = await read.take(2);
		const methods = [...(await read.take(count))];
		greetings.push(methods);
		if (options.login) {
			if (!methods.includes(2)) return void client.end(Buffer.from([5, 0xff]));
			client.write(Buffer.from([5, 2]));
			const [, userLength] = await read.take(2);
			const user = (await read.take(userLength)).toString();
			const [passwordLength] = await read.take(1);
			const login = `${user}:${(await read.take(passwordLength)).toString()}`;
			logins.push(login);
			if (login !== options.login) return void client.end(Buffer.from([1, 1]));
			client.write(Buffer.from([1, 0]));
		} else {
			client.write(Buffer.from([5, 0]));
		}
		const [, , , type] = await read.take(4);
		const raw = await read.take(type === 1 ? 4 : type === 4 ? 16 : (await read.take(1))[0]);
		const port = (await read.take(2)).readUInt16BE(0);
		const host = type === 1 ? [...raw].join(".") : type === 4 ? Array.from({ length: 8 }, (_, i) => raw.readUInt16BE(i * 2).toString(16)).join(":") : `name ${raw.toString()}`;
		targets.push(`${host}:${port}`);
		const reply = (code: number) => Buffer.from([5, code, 0, 1, 0, 0, 0, 0, 0, 0]);
		// 4 is "host unreachable": the guard should try its next checked address.
		if (options.deny?.includes(host)) return void client.end(reply(4));
		const upstream = connect(port, host);
		upstream.on("error", () => client.end(reply(5)));
		upstream.on("connect", () => {
			client.write(reply(0));
			splice(client, upstream, read.rest());
		});
	};
	const { port, close } = await listening(createServer((socket) => void serve(socket)));
	return { port, greetings, logins, targets, close };
}

/** A SOCKS4 proxy that records each target and user id. */
async function socks4(): Promise<Closable & { readonly targets: string[] }> {
	const targets: string[] = [];
	const serve = async (client: Socket) => {
		client.on("error", () => {});
		const read = reader(client);
		const request = await read.take(8);
		let user = "";
		for (let byte = (await read.take(1))[0]; byte !== 0; byte = (await read.take(1))[0]) user += String.fromCharCode(byte);
		const host = [...request.subarray(4, 8)].join(".");
		const port = request.readUInt16BE(2);
		targets.push(`${host}:${port} ${user}`);
		const upstream = connect(port, host);
		upstream.on("error", () => client.end(Buffer.from([0, 0x5b, 0, 0, 0, 0, 0, 0])));
		upstream.on("connect", () => {
			client.write(Buffer.from([0, 0x5a, 0, 0, 0, 0, 0, 0]));
			splice(client, upstream, read.rest());
		});
	};
	const { port, close } = await listening(createServer((socket) => void serve(socket)));
	return { port, targets, close };
}

async function closedPort(): Promise<number> {
	const { port, close } = await listening(createServer());
	await close();
	return port;
}

interface Step { readonly kind: "get" | "connect"; readonly host: string; readonly port: number; readonly path: string }
interface Run { readonly setup?: string; readonly results: string[]; readonly refused: string[]; readonly env: Record<string, string | null>; readonly guard: string; readonly raw: string }

/**
 * Runs helper.guard_network as a network command would, then sends each step through the proxy it set up.
 * `dns` maps fake names to the addresses that the guard's lookup returns.
 */
async function drive(config: { proxy?: string; env?: Record<string, string>; allow?: string[]; dns?: Record<string, string[]>; steps: Step[] }): Promise<Run> {
	const code = `import sys, json, os, socket, urllib.request, urllib.error; sys.path.insert(0, sys.argv[1]); import helper
cfg = json.loads(sys.argv[2])
real = socket.getaddrinfo
def fake(host, port, *args, **kwargs):
    if host in cfg["dns"]:
        return [(socket.AF_INET6 if ":" in a else socket.AF_INET, socket.SOCK_STREAM, 6, "", (a, port, 0, 0) if ":" in a else (a, port)) for a in cfg["dns"][host]]
    return real(host, port, *args, **kwargs)
socket.getaddrinfo = fake
req = {"testAllowTargets": cfg["allow"]}
if cfg.get("proxy"):
    req["proxy"] = cfg["proxy"]
try:
    guard = helper.guard_network(req)
except Exception as error:
    print(json.dumps({"setup": f"{type(error).__name__}: {error}", "results": [], "refused": [], "env": {}, "guard": ""}))
    sys.exit(0)
def get(step):
    try:
        with urllib.request.urlopen(f"http://{step['host']}:{step['port']}{step['path']}", timeout=20) as response:
            return f"{response.status} {response.read().decode()}"
    except urllib.error.HTTPError as error:
        return f"{error.code} {error.read().decode().strip()}"
    except Exception as error:
        return f"error {error}"
def tunnel(step):
    with socket.create_connection(("127.0.0.1", int(req["proxy"].rsplit(":", 1)[1])), timeout=20) as s:
        s.sendall(f"CONNECT {step['host']}:{step['port']} HTTP/1.1\\r\\nHost: {step['host']}:{step['port']}\\r\\n\\r\\n".encode())
        head = b""
        while b"\\r\\n\\r\\n" not in head:
            chunk = s.recv(1)
            if not chunk:
                return "error closed"
            head += chunk
        status = head.split(b"\\r\\n")[0].decode()
        if " 200 " not in status + " ":
            body = b""
            while chunk := s.recv(4096):
                body += chunk
            return f"{status.split(' ')[1]} {body.decode().strip()}"
        s.sendall(f"GET {step['path']} HTTP/1.0\\r\\nHost: {step['host']}\\r\\nConnection: close\\r\\n\\r\\n".encode())
        data = b""
        while chunk := s.recv(65536):
            data += chunk
        head, _, body = data.partition(b"\\r\\n\\r\\n")
        text = body.decode()
        return f"{head.split(b' ')[1].decode()} {text if len(text) < 1000 else len(text)}"
results = [get(step) if step["kind"] == "get" else tunnel(step) for step in cfg["steps"]]
names = ("http_proxy", "https_proxy", "all_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY")
print(json.dumps({"results": results, "refused": guard.REFUSED, "env": {n: os.environ.get(n) for n in names}, "guard": req["proxy"]}))`;
	const input = JSON.stringify({ allow: config.allow ?? [], dns: config.dns ?? {}, proxy: config.proxy, steps: config.steps });
	const env = { ...BASE_ENV, ...config.env };
	const { status, stdout, stderr } = await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => {
		const child = spawn(python as string, ["-I", "-B", "-c", code, dirname(HELPER), input], { env, cwd: tmpdir() });
		let out = "";
		let err = "";
		child.stdout.on("data", (chunk) => (out += chunk));
		child.stderr.on("data", (chunk) => (err += chunk));
		child.on("close", (exit) => resolve({ status: exit, stdout: out, stderr: err }));
	});
	assert.equal(status, 0, stderr);
	return { ...(JSON.parse(stdout) as Omit<Run, "raw">), raw: stdout + stderr };
}

const basic = (login: string) => `Basic ${Buffer.from(login).toString("base64")}`;

test("guard upstream: an http proxy gets each checked request with the checked IP, the original Host and the credentials", { skip: SKIP }, async (t) => {
	const site = await origin();
	const login = "us@er:p:ss";
	const proxy = await httpProxy({ auth: basic(login) });
	t.after(async () => {
		await site.close();
		await proxy.close();
	});
	const run = await drive({
		proxy: `http://us%40er:p%3Ass@127.0.0.1:${proxy.port}`,
		allow: [`site.test:${site.port}`],
		dns: { "site.test": ["127.0.0.1"] },
		steps: [
			{ kind: "get", host: "site.test", port: site.port, path: "/plain?q=1" },
			{ kind: "connect", host: "site.test", port: site.port, path: "/tunnel" },
		],
	});
	assert.deepEqual(run.results, ["200 origin /plain?q=1", "200 origin /tunnel"]);
	assert.deepEqual(proxy.lines, [`GET http://127.0.0.1:${site.port}/plain?q=1 HTTP/1.1`, `CONNECT 127.0.0.1:${site.port} HTTP/1.1`], "the proxy gets the checked address, not the name");
	assert.equal(proxy.hosts[0], `site.test:${site.port}`, "plain http keeps the original Host");
	assert.deepEqual(proxy.auths, [basic(login), basic(login)]);
	assert.deepEqual(site.hits, ["/plain?q=1", "/tunnel"]);
	for (const secret of ["p:ss", "p%3Ass", Buffer.from(login).toString("base64")]) assert.equal(run.raw.includes(secret), false, `output shows ${secret}`);
});

test("guard upstream: a private target is refused and never reaches the user's proxy", { skip: SKIP }, async (t) => {
	const site = await origin();
	const proxy = await httpProxy();
	const socks = await socks5();
	t.after(async () => {
		await site.close();
		await proxy.close();
		await socks.close();
	});
	const steps: Step[] = [
		{ kind: "get", host: "127.0.0.1", port: site.port, path: "/private" },
		{ kind: "connect", host: "127.0.0.1", port: site.port, path: "/private" },
		{ kind: "get", host: "inside.test", port: site.port, path: "/rebound" },
	];
	const dns = { "inside.test": ["93.184.216.34", "10.0.0.7"] };
	const viaHttp = await drive({ proxy: `http://127.0.0.1:${proxy.port}`, dns, steps });
	const viaSocks = await drive({ proxy: `socks5h://127.0.0.1:${socks.port}`, dns, steps });
	for (const run of [viaHttp, viaSocks]) {
		assert.match(run.results[0], /^403 /);
		assert.match(run.results[1], /^403 /);
		assert.match(run.results[2], /^403 .*inside\.test/);
		assert.deepEqual(run.refused, ["127.0.0.1", "127.0.0.1", "inside.test"]);
	}
	assert.deepEqual(proxy.lines, []);
	assert.deepEqual(socks.greetings, []);
	assert.deepEqual(site.hits, []);
});

test("guard upstream: SOCKS5 without a login gets the checked IPv4 address, for tunnels and plain http", { skip: SKIP }, async (t) => {
	const site = await origin();
	const socks = await socks5();
	t.after(async () => {
		await site.close();
		await socks.close();
	});
	const run = await drive({
		env: { ALL_PROXY: `socks5h://127.0.0.1:${socks.port}` },
		allow: [`site.test:${site.port}`],
		dns: { "site.test": ["127.0.0.1"] },
		steps: [
			{ kind: "connect", host: "site.test", port: site.port, path: "/tunnel" },
			{ kind: "get", host: "site.test", port: site.port, path: "/plain" },
		],
	});
	assert.deepEqual(run.results, ["200 origin /tunnel", "200 origin /plain"]);
	assert.deepEqual(socks.targets, [`127.0.0.1:${site.port}`, `127.0.0.1:${site.port}`]);
	assert.deepEqual(socks.greetings, [[0], [0]]);
	assert.deepEqual(site.hosts, ["site.test", `site.test:${site.port}`]);
	assert.equal(run.env.http_proxy, run.guard);
	assert.equal(run.env.https_proxy, run.guard);
	assert.equal(run.env.ALL_PROXY, null, "no client can reach the user's proxy around the guard");
});

test("guard upstream: SOCKS5 with a login, and a refused login is a 502 that names only host:port", { skip: SKIP }, async (t) => {
	const site = await origin();
	const socks = await socks5({ login: "user:s3cret pass" });
	t.after(async () => {
		await site.close();
		await socks.close();
	});
	const base = { allow: [`site.test:${site.port}`], dns: { "site.test": ["127.0.0.1"] }, steps: [{ kind: "connect", host: "site.test", port: site.port, path: "/tunnel" } as const] };
	const good = await drive({ ...base, proxy: `socks5://user:s3cret%20pass@127.0.0.1:${socks.port}` });
	const bad = await drive({ ...base, proxy: `socks5://user:wr0ng@127.0.0.1:${socks.port}` });
	assert.deepEqual(good.results, ["200 origin /tunnel"]);
	assert.match(bad.results[0], new RegExp(`^502 .*127\\.0\\.0\\.1:${socks.port}`));
	assert.deepEqual(socks.logins, ["user:s3cret pass", "user:wr0ng"]);
	assert.ok(socks.greetings.every((methods) => methods.includes(2)));
	assert.equal(good.raw.includes("s3cret"), false);
	assert.equal(bad.raw.includes("wr0ng"), false);
	assert.deepEqual(site.hits, ["/tunnel"]);
});

test("guard upstream: SOCKS4a gets the checked IPv4 address and the user id, and skips IPv6 addresses", { skip: SKIP }, async (t) => {
	const site = await origin();
	const socks = await socks4();
	t.after(async () => {
		await site.close();
		await socks.close();
	});
	const run = await drive({
		proxy: `socks4a://reader@127.0.0.1:${socks.port}`,
		allow: [`site.test:${site.port}`],
		dns: { "site.test": ["::1", "127.0.0.1"] },
		steps: [{ kind: "connect", host: "site.test", port: site.port, path: "/four" }],
	});
	assert.deepEqual(run.results, ["200 origin /four"]);
	assert.deepEqual(socks.targets, [`127.0.0.1:${site.port} reader`]);
});

test("guard upstream: IPv4 goes first, and the next checked address is tried when the proxy cannot reach one", { skip: SKIP }, async (t) => {
	const site = await origin();
	const socks = await socks5({ deny: ["127.0.0.3"] });
	t.after(async () => {
		await site.close();
		await socks.close();
	});
	const run = await drive({
		proxy: `socks5://127.0.0.1:${socks.port}`,
		allow: [`multi.test:${site.port}`],
		dns: { "multi.test": ["::1", "127.0.0.3", "127.0.0.1"] },
		steps: [{ kind: "connect", host: "multi.test", port: site.port, path: "/retry" }],
	});
	assert.deepEqual(run.results, ["200 origin /retry"]);
	assert.deepEqual(socks.targets, [`127.0.0.3:${site.port}`, `127.0.0.1:${site.port}`]);
});

test("guard upstream: a NO_PROXY host goes direct and is still checked", { skip: SKIP }, async (t) => {
	const site = await origin();
	const proxy = await httpProxy();
	t.after(async () => {
		await site.close();
		await proxy.close();
	});
	const run = await drive({
		env: { HTTP_PROXY: `http://127.0.0.1:${proxy.port}`, https_proxy: `http://127.0.0.1:${proxy.port}`, NO_PROXY: "direct.test,private.test" },
		allow: [`direct.test:${site.port}`, `proxied.test:${site.port}`],
		dns: { "direct.test": ["127.0.0.1"], "private.test": ["127.0.0.1"], "proxied.test": ["127.0.0.1"] },
		steps: [
			{ kind: "get", host: "direct.test", port: site.port, path: "/direct" },
			{ kind: "connect", host: "direct.test", port: site.port, path: "/direct-tunnel" },
			{ kind: "get", host: "private.test", port: site.port, path: "/private" },
			{ kind: "get", host: "proxied.test", port: site.port, path: "/proxied" },
		],
	});
	assert.deepEqual(run.results.map((r) => r.split(" ")[0]), ["200", "200", "403", "200"]);
	assert.deepEqual(run.refused, ["private.test"]);
	assert.deepEqual(proxy.lines, [`GET http://127.0.0.1:${site.port}/proxied HTTP/1.1`]);
	assert.deepEqual(site.hits, ["/direct", "/direct-tunnel", "/proxied"]);
	assert.equal(run.env.no_proxy, null);
	assert.equal(run.env.NO_PROXY, null);
});

test("guard upstream: HTTPS_PROXY takes tunnels and HTTP_PROXY plain http, and linkContext.proxy wins over both", { skip: SKIP }, async (t) => {
	const site = await origin();
	const plain = await httpProxy();
	const tls = await httpProxy();
	const chosen = await httpProxy();
	t.after(async () => {
		await site.close();
		await plain.close();
		await tls.close();
		await chosen.close();
	});
	const base = {
		env: { HTTP_PROXY: `http://127.0.0.1:${plain.port}`, https_proxy: `http://127.0.0.1:${tls.port}` },
		allow: [`site.test:${site.port}`],
		dns: { "site.test": ["127.0.0.1"] },
		steps: [{ kind: "get", host: "site.test", port: site.port, path: "/a" } as const, { kind: "connect", host: "site.test", port: site.port, path: "/b" } as const],
	};
	const fromEnv = await drive(base);
	assert.deepEqual(fromEnv.results, ["200 origin /a", "200 origin /b"]);
	assert.deepEqual(plain.lines, [`GET http://127.0.0.1:${site.port}/a HTTP/1.1`]);
	assert.deepEqual(tls.lines, [`CONNECT 127.0.0.1:${site.port} HTTP/1.1`]);
	const fromConfig = await drive({ ...base, proxy: `http://127.0.0.1:${chosen.port}` });
	assert.deepEqual(fromConfig.results, ["200 origin /a", "200 origin /b"]);
	assert.equal(chosen.lines.length, 2);
	assert.equal(plain.lines.length + tls.lines.length, 2, "the variables' proxies got nothing more");
});

test("guard upstream: an unsupported scheme or a bad proxy URL stops the call before any request", { skip: SKIP }, async (t) => {
	const site = await origin();
	t.after(site.close);
	const steps: Step[] = [{ kind: "get", host: "127.0.0.1", port: site.port, path: "/never" }];
	const bad: { proxy?: string; env?: Record<string, string> }[] = [
		{ proxy: "ftp://user:hunter2@127.0.0.1:21" },
		{ proxy: "user:hunter2@127.0.0.1:8080" },
		{ proxy: "127.0.0.1:8080" },
		{ proxy: "http://[::1" },
		{ proxy: "http://user:hunter2@:8080" },
		{ proxy: "http://user:hunter2@127.0.0.1:99999" },
		{ env: { HTTPS_PROXY: "gopher://user:hunter2@127.0.0.1:70" } },
		{ env: { ALL_PROXY: "socks://user:hunter2@127.0.0.1:1080" } },
	];
	for (const config of bad) {
		const run = await drive({ ...config, allow: [`127.0.0.1:${site.port}`], steps });
		assert.match(run.setup ?? "", /^BadProxy: .*(linkContext\.proxy|_proxy)/i, JSON.stringify(config));
		assert.deepEqual(run.results, []);
		assert.equal(run.raw.includes("hunter2"), false, `${JSON.stringify(config)}: ${run.raw}`);
	}
	assert.deepEqual(site.hits, []);
});

test("guard upstream: a proxy that is down or refuses the login gives a 502 that names its host:port only", { skip: SKIP }, async (t) => {
	const site = await origin();
	const strict = await httpProxy({ auth: basic("right:answer") });
	const down = await closedPort();
	t.after(async () => {
		await site.close();
		await strict.close();
	});
	const base = {
		allow: [`site.test:${site.port}`],
		dns: { "site.test": ["127.0.0.1"] },
		steps: [{ kind: "get", host: "site.test", port: site.port, path: "/a" } as const, { kind: "connect", host: "site.test", port: site.port, path: "/b" } as const],
	};
	const gone = await drive({ ...base, proxy: `http://user:hunter2@127.0.0.1:${down}` });
	const refused = await drive({ ...base, proxy: `http://right:hunter2@127.0.0.1:${strict.port}` });
	for (const result of gone.results) assert.match(result, new RegExp(`^502 .*proxy 127\\.0\\.0\\.1:${down}`));
	for (const result of refused.results) assert.match(result, new RegExp(`^502 .*proxy 127\\.0\\.0\\.1:${strict.port}.*(user name or password|login)`));
	assert.equal(gone.raw.includes("hunter2") || refused.raw.includes("hunter2"), false);
	assert.deepEqual(site.hits, []);
});

/** A self-signed certificate for 127.0.0.1, or undefined when openssl is missing. */
function selfSigned(dir: string): { key: string; cert: string; certFile: string } | undefined {
	const key = join(dir, "key.pem");
	const cert = join(dir, "cert.pem");
	const made = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], { encoding: "utf8" });
	if (made.status !== 0) return undefined;
	return { key: readFileSync(key, "utf8"), cert: readFileSync(cert, "utf8"), certFile: cert };
}

const certDir = mkdtempSync(join(home, "cert-"));
const certificate = spawnSync("openssl", ["version"]).status === 0 ? selfSigned(certDir) : undefined;

test("guard upstream: an https proxy gets TLS that is verified, and each answer comes through whole and at once", { skip: SKIP || (certificate ? false : "openssl not available") }, async (t) => {
	const cert = certificate as NonNullable<typeof certificate>;
	const site = await origin();
	const kept = await keepAliveOrigin();
	const proxy = await httpProxy({ tls: { key: cert.key, cert: cert.cert }, auth: basic("tls:pass") });
	t.after(async () => {
		await site.close();
		await kept.close();
		await proxy.close();
	});
	const base = {
		proxy: `https://tls:pass@127.0.0.1:${proxy.port}`,
		allow: [`site.test:${site.port}`, `site.test:${kept.port}`],
		dns: { "site.test": ["127.0.0.1"] },
		steps: [
			{ kind: "connect", host: "site.test", port: site.port, path: "/big" } as const,
			{ kind: "get", host: "site.test", port: site.port, path: "/plain" } as const,
			// The answer comes in one TLS record and the connection stays open, so only the bytes TLS already decrypted can finish it.
			{ kind: "get", host: "site.test", port: kept.port, path: "/kept" } as const,
		],
	};
	const trusted = await drive({ ...base, env: { SSL_CERT_FILE: cert.certFile } });
	assert.deepEqual(trusted.results, [`200 ${1024 * 1024}`, "200 origin /plain", "200 kept"]);
	assert.deepEqual(proxy.lines.slice(0, 2), [`CONNECT 127.0.0.1:${site.port} HTTP/1.1`, `GET http://127.0.0.1:${site.port}/plain HTTP/1.1`]);
	const untrusted = await drive(base);
	for (const result of untrusted.results) assert.match(result, new RegExp(`^502 .*proxy 127\\.0\\.0\\.1:${proxy.port}`));
	assert.equal(proxy.lines.length, 3, "an unverified proxy gets no request");
});

test("yt-dlp: with linkContext.proxy set, its requests go through that proxy and a redirect to a loopback host is still refused", { skip: SKIP_YTDLP }, async (t) => {
	const inside = await origin();
	const { port, close } = await listening(createHttpServer((_req, res) => res.writeHead(302, { location: `http://127.0.0.1:${inside.port}/internal/video.mp4` }).end()));
	const proxy = await httpProxy({ auth: basic("user:hunter2") });
	const dir = mkdtempSync(join(home, "pull-"));
	t.after(async () => {
		await inside.close();
		await close();
		await proxy.close();
	});
	const request = { url: `http://127.0.0.1:${port}/watch`, kind: "video", dir, sections: [[0, 1]], proxy: `http://user:hunter2@127.0.0.1:${proxy.port}`, testAllowTargets: [`127.0.0.1:${port}`] };
	const result = await new Promise<{ code: number | null; out: string }>((resolve) => {
		const child = spawn(mediaPython as string, ["-I", "-B", HELPER, "info"], { env: BASE_ENV, cwd: tmpdir() });
		let out = "";
		child.stdout.on("data", (chunk) => (out += chunk));
		child.stderr.on("data", (chunk) => (out += chunk));
		child.on("close", (code) => resolve({ code, out }));
		child.stdin.end(JSON.stringify(request));
	});
	assert.equal(result.code, 1, result.out);
	assert.match(JSON.parse(result.out).error, /^Refusing a private or local address: 127\.0\.0\.1/);
	assert.ok(proxy.lines.includes(`GET http://127.0.0.1:${port}/watch HTTP/1.1`), proxy.lines.join("\n"));
	assert.ok(proxy.auths.every((auth) => auth === basic("user:hunter2")));
	assert.deepEqual(inside.hits, [], "the redirect target was never requested");
	assert.equal(result.out.includes("hunter2"), false);
});
