import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isPrivateHost, parseProxyUrl, PROXY_ENV, resolveProxy } from "../lib/gov-search/config.ts";
import { GovSearchError } from "../lib/gov-search/errors.ts";

const isConfigError = (pattern: RegExp) => (error: unknown) => error instanceof GovSearchError && error.code === "proxyConfig" && pattern.test(error.message);

test("only loopback, private and Tailscale addresses can be the proxy", () => {
	for (const host of ["localhost", "127.0.0.1", "127.8.9.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.5", "100.64.0.1", "100.127.255.254", "::1", "fd7a:115c:a1e0::1", "fc00::5", "::ffff:127.0.0.1"]) {
		assert.equal(isPrivateHost(host), true, host);
	}
	for (const host of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "192.169.0.1", "2001:db8::1", "::ffff:8.8.8.8", "proxy.example.com", "localhost.example", "fe80::1"]) {
		assert.equal(isPrivateHost(host), false, host);
	}
});

test("a proxy URL parses to host and port", () => {
	assert.deepEqual(parseProxyUrl("http://127.0.0.1:8080", "env"), { host: "127.0.0.1", port: 8080, source: "env" });
	assert.deepEqual(parseProxyUrl("http://[fd7a:115c:a1e0::5]:3128/", "env"), { host: "fd7a:115c:a1e0::5", port: 3128, source: "env" });
	assert.deepEqual(parseProxyUrl("http://100.101.102.103", "env"), { host: "100.101.102.103", port: 80, source: "env" });
});

test("a proxy URL that is not safe is refused, and the reason never repeats it", () => {
	const cases: Array<[string, RegExp]> = [
		["socks5://127.0.0.1:1080", /http:\/\/ URL/],
		["https://127.0.0.1:8080", /http:\/\/ URL/],
		["http://user:secret-pass@127.0.0.1:8080", /user name and password/],
		["http://127.0.0.1:8080/path", /path, query/],
		["http://127.0.0.1:8080/?a=1", /path, query/],
		["http://203.0.113.9:8080", /must be localhost/],
		["http://proxy.example.com:8080", /must be localhost/],
		["http://127.0.0.1:0", /port/],
		["not a url", /not a URL/],
	];
	for (const [raw, pattern] of cases) {
		assert.throws(() => parseProxyUrl(raw, "test"), (error: unknown) => isConfigError(pattern)(error) && !(error as Error).message.includes("secret-pass") && !(error as Error).message.includes(raw), raw);
	}
});

test("the env var wins over the file; the file section works alone", () => {
	const dir = mkdtempSync(join(tmpdir(), "gov-config-"));
	try {
		const file = join(dir, "pi-extras.json");
		assert.equal(resolveProxy({}, file), undefined, "no file, no proxy");
		writeFileSync(file, JSON.stringify({ govSearch: { proxy: "http://192.168.7.2:8888" } }));
		assert.deepEqual(resolveProxy({}, file), { host: "192.168.7.2", port: 8888, source: "govSearch.proxy in pi-extras.json" });
		assert.deepEqual(resolveProxy({ [PROXY_ENV]: " http://127.0.0.1:9000 " }, file), { host: "127.0.0.1", port: 9000, source: PROXY_ENV });
		assert.deepEqual(resolveProxy({ [PROXY_ENV]: "" }, file)?.port, 8888, "an empty env var does not hide the file");
		writeFileSync(file, JSON.stringify({ govSearch: { proxy: "" }, other: 1 }));
		assert.equal(resolveProxy({}, file), undefined);
		writeFileSync(file, JSON.stringify({ other: 1 }));
		assert.equal(resolveProxy({}, file), undefined);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a setting gov_search cannot read stops the search instead of going direct", () => {
	const dir = mkdtempSync(join(tmpdir(), "gov-config-"));
	try {
		const file = join(dir, "pi-extras.json");
		writeFileSync(file, '{ "govSearch": { "proxy": "http://127.0.0.1:8080", } }');
		assert.throws(() => resolveProxy({}, file), isConfigError(/does not parse/));
		writeFileSync(file, JSON.stringify({ govSearch: { proxy: 8080 } }));
		assert.throws(() => resolveProxy({}, file), isConfigError(/must be a string/));
		writeFileSync(file, JSON.stringify({ govSearch: "http://127.0.0.1:8080" }));
		assert.throws(() => resolveProxy({}, file), isConfigError(/must be an object/));
		writeFileSync(file, JSON.stringify({ govSearch: { proxy: "http://8.8.8.8:80" } }));
		assert.throws(() => resolveProxy({}, file), isConfigError(/must be localhost/));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
