/**
 * gov_search against local servers only: a fake API, a fake HTTP CONNECT
 * proxy and, when openssl is on the machine, a TLS target with a throwaway
 * certificate. Nothing here reaches the network.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, createServer as createNetServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer as createTlsServer } from "node:tls";
import { GovSearchClient, type ClientOptions } from "../lib/gov-search/client.ts";
import type { ProxyAddress } from "../lib/gov-search/config.ts";
import { GovSearchError } from "../lib/gov-search/errors.ts";
import type { Secure } from "../lib/gov-search/transport.ts";

// Built from parts so secret scanners do not flag a synthetic value.
const KEY = ["fc", "synthetic", "test", "key", "0001"].join("-");
// Keeps a key file in the real home out of these tests.
const NO_KEY_FILE = join(tmpdir(), "gov-search-tests-no-such-key-file");
const plain: Secure = async (socket) => socket;

interface Seen { method?: string; url?: string; headers: IncomingMessage["headers"]; body: string }
type Handler = (seen: Seen, response: ServerResponse) => void;

async function listen(server: Server | ReturnType<typeof createNetServer>): Promise<number> {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return (server.address() as AddressInfo).port;
}

const close = (server: { close(cb: () => void): unknown; closeAllConnections?: () => void }) => new Promise<void>((resolve) => {
	server.closeAllConnections?.();
	server.close(() => resolve());
});

/** A fake API that records each request. */
async function fakeApi(handler: Handler) {
	const requests: Seen[] = [];
	const server = createServer((request, response) => {
		const chunks: Buffer[] = [];
		request.on("data", (chunk: Buffer) => chunks.push(chunk));
		request.on("end", () => {
			const seen = { method: request.method, url: request.url, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") };
			requests.push(seen);
			handler(seen, response);
		});
	});
	const port = await listen(server);
	return { requests, port, close: () => close(server) };
}

/** A CONNECT proxy that sends every tunnel to `upstreamPort`, whatever host was asked for, and records the CONNECT lines. */
async function fakeProxy(upstreamPort: number, answer = 200) {
	const connects: string[] = [];
	const sockets = new Set<Socket>();
	const server = createServer((_request, response) => response.writeHead(405).end());
	server.on("connect", (request: IncomingMessage, client: Socket, head: Buffer) => {
		connects.push(request.url ?? "");
		sockets.add(client);
		if (answer !== 200) {
			client.end(`HTTP/1.1 ${answer} Forbidden\r\nContent-Length: 0\r\n\r\n`);
			return;
		}
		const upstream = connect(upstreamPort, "127.0.0.1", () => {
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) upstream.write(head);
			upstream.pipe(client);
			client.pipe(upstream);
		});
		sockets.add(upstream);
		upstream.on("error", () => client.destroy());
		client.on("error", () => upstream.destroy());
	});
	const port = await listen(server);
	return { connects, port, close: () => { for (const socket of sockets) socket.destroy(); return close(server); } };
}

const ok = (web: unknown[]) => (_seen: Seen, response: ServerResponse) => response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ success: true, data: { web } }));
const web = [
	{ url: "https://www.agency.example.gov/rule", title: "Rule", description: "Rule text.", position: 1 },
	{ url: "https://search.agency.example.gov/rule", title: "Rule", description: "Rule text.", position: 2 },
	{ url: "https://code.example.gov/sec-1", title: "Sec. 1", description: "Section one.", position: 3 },
];

function client(port: number, options: ClientOptions = {}, env: NodeJS.ProcessEnv = {}) {
	return new GovSearchClient({ target: { host: "127.0.0.1", port }, secure: plain, env: () => env, proxy: () => undefined, defaultKeyFile: NO_KEY_FILE, ...options });
}

const failsWith = (code: string, pattern?: RegExp) => (error: unknown) => error instanceof GovSearchError && error.code === code && (!pattern || pattern.test(error.message));

test("a search posts JSON to /v2/search/gov and returns deduplicated results", async () => {
	const api = await fakeApi(ok(web));
	try {
		const result = await client(api.port).search({ query: "rule text", k: 3, jurisdiction: "us-tx" });
		assert.equal(api.requests.length, 1);
		const [seen] = api.requests;
		assert.equal(seen!.method, "POST");
		assert.equal(seen!.url, "/v2/search/gov");
		assert.equal(seen!.headers.host, "127.0.0.1");
		assert.equal(seen!.headers["content-type"], "application/json");
		assert.equal(seen!.headers.authorization, undefined, "no key, no Authorization header");
		assert.deepEqual(JSON.parse(seen!.body), { query: "rule text", k: 3, jurisdiction: "us-tx" });
		assert.equal(result.resultCount, 2);
		assert.equal(result.duplicateCount, 1);
		assert.equal(result.keyed, false);
		assert.equal(result.proxied, false);
		assert.match(result.text, /2 results for k=3 \(3 from the API; 1 duplicate removed\)/);
	} finally {
		await api.close();
	}
});

test("the key goes only in the Authorization header and never into an error", async () => {
	const api = await fakeApi((seen, response) => {
		if (seen.body.includes("quote")) ok([{ url: `https://e.example.gov/?k=${KEY}`, title: `Key ${KEY}`, description: `text ${KEY}` }])(seen, response);
		else if (seen.body.includes("echo")) response.writeHead(400).end(JSON.stringify({ success: false, error: `bad token ${KEY}`, details: [{ path: ["k"], message: `got ${encodeURIComponent(KEY)}` }] }));
		else ok(web)(seen, response);
	});
	try {
		const search = client(api.port, {}, { FIRECRAWL_API_KEY: KEY });
		const result = await search.search({ query: "q" });
		assert.equal(api.requests[0]!.headers.authorization, `Bearer ${KEY}`);
		assert.equal(result.keyed, true);
		assert.ok(!result.text.includes(KEY));
		const quoted = await search.search({ query: "quote" });
		assert.ok(!JSON.stringify(quoted).includes(KEY), "a result that quotes the key is redacted in text and details");
		await assert.rejects(search.search({ query: "echo" }), (error: unknown) => failsWith("badRequest", /HTTP 400.*bad token \[redacted\]; k: got \[redacted\]/)(error) && !(error as Error).message.includes(KEY));
	} finally {
		await api.close();
	}
});

test("HTTP errors become friendly messages", async () => {
	const statuses: Record<string, number> = { auth: 401, rate: 429, up: 502, odd: 418, big: 200, vpn: 403 };
	const api = await fakeApi((seen, response) => {
		const name = JSON.parse(seen.body).query as string;
		if (name === "big") response.writeHead(200, { "Content-Type": "application/json" }).end("x".repeat(2_100_000));
		else if (name === "html") response.writeHead(200).end("<html></html>");
		else if (name === "vpn") response.writeHead(403, { "WWW-Authenticate": "Bearer" }).end(JSON.stringify({ success: false, error: "Your IP looks like a VPN. Sign up at https://signup.example.test/?ref=synthetic-ref", signup_url: "https://signup.example.test/?ref=synthetic-ref" }));
		else response.writeHead(statuses[name] ?? 500, { "Retry-After": "1" }).end("{}");
	});
	try {
		const keyed = client(api.port, {}, { FIRECRAWL_API_KEY: KEY });
		await assert.rejects(keyed.search({ query: "auth" }), failsWith("auth", /rejected the API key \(HTTP 401\)/));
		await assert.rejects(client(api.port).search({ query: "rate" }), failsWith("rate", /daily limit for searches without a key.*free Firecrawl API key \(FIRECRAWL_API_KEY or ~\/.secrets\/firecrawl_api_key\)/));
		await assert.rejects(keyed.search({ query: "rate" }), failsWith("rate", /for this API key/));
		await assert.rejects(client(api.port).search({ query: "vpn" }), (error: unknown) => failsWith("blocked", /look like a VPN or proxy \(HTTP 403\).*FIRECRAWL_API_KEY or ~\/.secrets\/firecrawl_api_key.*remove the gov_search proxy setting/)(error) && !(error as Error).message.includes("synthetic-ref"));
		await assert.rejects(client(api.port, {}, { FIRECRAWL_API_KEY: KEY }).search({ query: "vpn" }), failsWith("auth"), "with a key, a 403 is about the key");
		await assert.rejects(client(api.port).search({ query: "up" }), failsWith("upstream", /HTTP 502/));
		await assert.rejects(client(api.port).search({ query: "odd" }), failsWith("http", /HTTP 418/));
		await assert.rejects(client(api.port).search({ query: "big" }), failsWith("response", /larger than 2 MB/));
		await assert.rejects(client(api.port).search({ query: "html" }), failsWith("response", /not JSON/));
	} finally {
		await api.close();
	}
});

test("after a 429, the same client stops sending until Retry-After ends", async () => {
	const api = await fakeApi((_seen, response) => response.writeHead(429, { "Retry-After": "120" }).end("{}"));
	try {
		const search = client(api.port);
		await assert.rejects(search.search({ query: "a" }), failsWith("rate"));
		await assert.rejects(search.search({ query: "b" }), failsWith("rate"));
		assert.equal(api.requests.length, 1);
	} finally {
		await api.close();
	}
});

test("a slow API times out, and an abort cancels", async () => {
	const api = await fakeApi(() => {});
	try {
		await assert.rejects(client(api.port, { timeoutMs: 150 }).search({ query: "slow" }), failsWith("timeout", /did not answer in 0 seconds|did not answer in/));
		const controller = new AbortController();
		const pending = client(api.port).search({ query: "slow" }, { signal: controller.signal });
		setTimeout(() => controller.abort(), 50);
		await assert.rejects(pending, failsWith("cancelled"));
		const aborted = new AbortController();
		aborted.abort();
		await assert.rejects(client(api.port).search({ query: "slow" }, { signal: aborted.signal }), failsWith("cancelled"));
	} finally {
		await api.close();
	}
});

test("a closed port is a network error", async () => {
	const server = createNetServer();
	const port = await listen(server);
	await close(server);
	await assert.rejects(client(port).search({ query: "q" }), failsWith("network", /ECONNREFUSED/));
	// The real TLS step must report the refused socket too, not wait for the deadline.
	const { tlsSecure } = await import("../lib/gov-search/transport.ts");
	await assert.rejects(client(port, { secure: tlsSecure(), timeoutMs: 5_000 }).search({ query: "q" }), failsWith("network", /ECONNREFUSED/));
});

test("through the proxy, the CONNECT line names the API host and the API sees the request", async () => {
	const api = await fakeApi(ok(web));
	const proxy = await fakeProxy(api.port);
	try {
		const address: ProxyAddress = { host: "127.0.0.1", port: proxy.port, source: "test" };
		// The target name does not resolve here, so the request works only if the proxy, not this process, looks it up.
		const search = client(0, { target: { host: "gov-api.invalid", port: 443 }, proxy: () => address });
		const result = await search.search({ query: "q" });
		assert.deepEqual(proxy.connects, ["gov-api.invalid:443"]);
		assert.equal(api.requests.length, 1);
		assert.equal(api.requests[0]!.headers.host, "gov-api.invalid");
		assert.equal(result.proxied, true);
		assert.equal(result.resultCount, 2);
	} finally {
		await proxy.close();
		await api.close();
	}
});

test("fail closed: a proxy that is down, refuses or is not allowed never leads to a direct request", async () => {
	const api = await fakeApi(ok(web));
	const refusing = await fakeProxy(api.port, 403);
	const stopped = createNetServer();
	const downPort = await listen(stopped);
	await close(stopped);
	try {
		// The direct target is the live fake API, so any fallback would show up in api.requests.
		const via = (proxy: () => ProxyAddress | undefined) => client(api.port, { proxy });
		await assert.rejects(via(() => ({ host: "127.0.0.1", port: downPort, source: "test" })).search({ query: "q" }), failsWith("proxy", /did not answer \(ECONNREFUSED\).*not sent directly/));
		await assert.rejects(via(() => ({ host: "127.0.0.1", port: refusing.port, source: "test" })).search({ query: "q" }), failsWith("proxyRefused", /HTTP 403.*not sent directly/));
		const unsafe = new GovSearchClient({ target: { host: "127.0.0.1", port: api.port }, secure: plain, defaultKeyFile: NO_KEY_FILE, env: () => ({ PI_GOV_SEARCH_PROXY: "http://203.0.113.5:8080" }) });
		await assert.rejects(unsafe.search({ query: "q" }), failsWith("proxyConfig", /PI_GOV_SEARCH_PROXY.*No request was sent/));
		assert.equal(api.requests.length, 0);
	} finally {
		await refusing.close();
		await api.close();
	}
});

function throwawayCert(): { key: string; cert: string } | undefined {
	const dir = mkdtempSync(join(tmpdir(), "gov-tls-"));
	try {
		const run = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=gov-api.invalid", "-addext", "subjectAltName=DNS:gov-api.invalid",
			"-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
		if (run.error || run.status !== 0) return undefined;
		return { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("TLS runs end to end inside the tunnel and checks the API host name", async (t) => {
	const pair = throwawayCert();
	if (!pair) return t.skip("openssl is not available");
	const api = await fakeApi(ok(web));
	// A TLS front that ends TLS and passes plain HTTP to the fake API.
	const front = createTlsServer({ key: pair.key, cert: pair.cert }, (secure) => {
		const upstream = connect(api.port, "127.0.0.1");
		secure.pipe(upstream).pipe(secure);
		secure.on("error", () => upstream.destroy());
		upstream.on("error", () => secure.destroy());
	});
	const frontPort = await listen(front);
	const proxy = await fakeProxy(frontPort);
	try {
		const { tlsSecure } = await import("../lib/gov-search/transport.ts");
		const address = () => ({ host: "127.0.0.1", port: proxy.port, source: "test" });
		const trusted = new GovSearchClient({ target: { host: "gov-api.invalid", port: 443 }, secure: tlsSecure({ ca: pair.cert }), env: () => ({}), proxy: address, defaultKeyFile: NO_KEY_FILE });
		assert.equal((await trusted.search({ query: "q" })).resultCount, 2);
		const untrusted = new GovSearchClient({ target: { host: "gov-api.invalid", port: 443 }, env: () => ({}), proxy: address, defaultKeyFile: NO_KEY_FILE });
		await assert.rejects(untrusted.search({ query: "q" }), failsWith("network", /through the proxy \(/));
		assert.equal(api.requests.length, 1, "a certificate the client does not trust stops the request before HTTP");
	} finally {
		await proxy.close();
		await close(front);
		await api.close();
	}
});

test("more calls than the limit at the same time are refused", async () => {
	const api = await fakeApi(() => {});
	try {
		const search = client(api.port, { maxInFlight: 1, timeoutMs: 300 });
		const first = search.search({ query: "a" });
		await assert.rejects(search.search({ query: "b" }), failsWith("busy"));
		await assert.rejects(first, failsWith("timeout"));
	} finally {
		await api.close();
	}
});

/** A TCP server that takes connections and never answers, like a tunnel that stalls before the TLS ServerHello. */
async function silentServer() {
	const sockets = new Set<Socket>();
	const server = createNetServer((socket) => {
		sockets.add(socket);
		socket.on("error", () => {});
	});
	const port = await listen(server);
	return { port, close: () => { for (const socket of sockets) socket.destroy(); return close(server); } };
}

test("a TLS handshake that never ends times out and frees its slot", { timeout: 5_000 }, async () => {
	const silent = await silentServer();
	try {
		const { tlsSecure } = await import("../lib/gov-search/transport.ts");
		const search = client(silent.port, { secure: tlsSecure(), timeoutMs: 200, maxInFlight: 1 });
		await assert.rejects(search.search({ query: "q" }), failsWith("timeout"));
		// A leaked slot would make this one fail as busy instead of timing out.
		await assert.rejects(search.search({ query: "q" }), failsWith("timeout"));
	} finally {
		await silent.close();
	}
});

test("an abort during the TLS handshake cancels at once", { timeout: 5_000 }, async () => {
	const silent = await silentServer();
	try {
		const { tlsSecure } = await import("../lib/gov-search/transport.ts");
		const controller = new AbortController();
		const pending = client(silent.port, { secure: tlsSecure(), timeoutMs: 10_000 }).search({ query: "q" }, { signal: controller.signal });
		setTimeout(() => controller.abort(), 100);
		const started = Date.now();
		await assert.rejects(pending, failsWith("cancelled"));
		assert.ok(Date.now() - started < 2_000);
	} finally {
		await silent.close();
	}
});

test("a proxy that accepts the tunnel and then closes it is a network error, not a direct request", { timeout: 5_000 }, async () => {
	const api = await fakeApi(ok(web));
	const proxy = createServer();
	const tunnels = new Set<Socket>();
	proxy.on("connect", (_request: IncomingMessage, socket: Socket) => {
		tunnels.add(socket);
		socket.end("HTTP/1.1 200 Connection Established\r\n\r\n");
	});
	const proxyPort = await listen(proxy);
	try {
		const { tlsSecure } = await import("../lib/gov-search/transport.ts");
		const address = () => ({ host: "127.0.0.1", port: proxyPort, source: "test" });
		for (const secure of [tlsSecure(), plain]) {
			await assert.rejects(client(api.port, { secure, timeoutMs: 2_000, proxy: address }).search({ query: "q" }), failsWith("network", /through the proxy/));
		}
		assert.equal(api.requests.length, 0);
	} finally {
		for (const socket of tunnels) socket.destroy();
		await close(proxy);
		await api.close();
	}
});

test("an abort while the body arrives cancels, and a body cut short is a network error", { timeout: 5_000 }, async () => {
	const api = await fakeApi((seen, response) => {
		response.writeHead(200, { "Content-Type": "application/json", "Content-Length": "1000" });
		response.write('{"success":true,');
		if (seen.body.includes("cut")) setTimeout(() => response.destroy(), 50);
	});
	try {
		const controller = new AbortController();
		const pending = client(api.port, { timeoutMs: 10_000 }).search({ query: "stall" }, { signal: controller.signal });
		setTimeout(() => controller.abort(), 100);
		await assert.rejects(pending, failsWith("cancelled"));
		await assert.rejects(client(api.port, { timeoutMs: 2_000 }).search({ query: "cut" }), failsWith("network"));
	} finally {
		await api.close();
	}
});

test("a key that a page quotes is removed before any cut, so no part of it is left", async () => {
	const api = await fakeApi(ok([{ url: "https://e.example.gov/a", title: `${"t".repeat(195)}${KEY}`, description: `${"d".repeat(290)}${KEY} more` }]));
	try {
		const result = await client(api.port, {}, { FIRECRAWL_API_KEY: KEY }).search({ query: "q" });
		assert.ok(!JSON.stringify(result).includes(KEY.slice(0, 8)), "no key prefix in text or details");
	} finally {
		await api.close();
	}
});

test("never more than k results, also when the API sends more", async () => {
	const many = Array.from({ length: 6 }, (_, i) => ({ url: `https://code.example.gov/${i}`, title: `S${i}`, description: `Text ${i}.` }));
	const api = await fakeApi(ok(many));
	try {
		const result = await client(api.port).search({ query: "q", k: 2 });
		assert.equal(result.resultCount, 2);
		assert.deepEqual(result.results.map((r) => r.url), ["https://code.example.gov/0", "https://code.example.gov/1"]);
	} finally {
		await api.close();
	}
});

test("a 429 on one path does not block the other path, which leaves from another address", async () => {
	let answered = 0;
	const api = await fakeApi((seen, response) => {
		if (answered++ === 0) response.writeHead(429, { "Retry-After": "120" }).end("{}");
		else ok(web)(seen, response);
	});
	const proxy = await fakeProxy(api.port);
	try {
		let via: ProxyAddress | undefined;
		const search = client(api.port, { proxy: () => via });
		await assert.rejects(search.search({ query: "q" }), failsWith("rate"));
		via = { host: "127.0.0.1", port: proxy.port, source: "test" };
		assert.equal((await search.search({ query: "q" })).proxied, true);
		via = undefined;
		await assert.rejects(search.search({ query: "q" }), failsWith("rate"));
		assert.equal(api.requests.length, 2, "the direct path stays in its cooldown");
	} finally {
		await proxy.close();
		await api.close();
	}
});
