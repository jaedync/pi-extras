/**
 * The gov_search proxy setting. `PI_GOV_SEARCH_PROXY` wins over `proxy` in
 * the `govSearch` section of pi-extras.json, so a per-machine environment can
 * override the shared file. The setting is read at each search, and every
 * doubt about it (a bad URL, a public address, a settings file that does not
 * parse) stops the search: a request that was meant to go through a VPN must
 * never go out directly.
 */
import { BlockList, isIP } from "node:net";
import { CONFIG_FILE } from "../extras-config.ts";
import { readJsonObject } from "../json-file.ts";
import { errors } from "./errors.ts";

export const SECTION = "govSearch";
export const PROXY_ENV = "PI_GOV_SEARCH_PROXY";
const MAX_PROXY_CHARS = 200;

export interface ProxyAddress {
	host: string;
	port: number;
	/** Where the setting came from, for messages; never the URL itself. */
	source: string;
}

/**
 * Loopback, RFC 1918, Tailscale's CGNAT range and IPv6 unique local
 * addresses (which hold Tailscale's fd7a:115c:a1e0::/48). A proxy on a public
 * address would see every query in clear text before the tunnel, and a host
 * name would need a local DNS lookup that could point anywhere.
 */
const PRIVATE = (() => {
	const list = new BlockList();
	list.addSubnet("127.0.0.0", 8, "ipv4");
	list.addSubnet("10.0.0.0", 8, "ipv4");
	list.addSubnet("172.16.0.0", 12, "ipv4");
	list.addSubnet("192.168.0.0", 16, "ipv4");
	list.addSubnet("100.64.0.0", 10, "ipv4");
	list.addAddress("::1", "ipv6");
	list.addSubnet("fc00::", 7, "ipv6");
	return list;
})();

export function isPrivateHost(host: string): boolean {
	if (host === "localhost") return true;
	const family = isIP(host);
	if (family === 4) return PRIVATE.check(host, "ipv4");
	// BlockList checks an IPv4-mapped IPv6 address (::ffff:7f00:1) against the IPv4 ranges.
	return family === 6 && PRIVATE.check(host, "ipv6");
}

/** Parses a proxy URL; the reasons never repeat the URL, which could hold a password. */
export function parseProxyUrl(raw: string, source: string): ProxyAddress {
	const fail = (reason: string) => errors.proxyConfig(source, reason);
	if (raw.length > MAX_PROXY_CHARS) throw fail(`it is longer than ${MAX_PROXY_CHARS} characters`);
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw fail("it is not a URL; use http://host:port");
	}
	if (url.protocol !== "http:") throw fail("use an http:// URL for an HTTP CONNECT proxy");
	if (url.username || url.password) throw fail("remove the user name and password; gov_search does not send proxy credentials");
	if ((url.pathname && url.pathname !== "/") || url.search || url.hash) throw fail("remove the path, query and fragment; use http://host:port");
	const host = url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
	if (!isPrivateHost(host)) {
		throw fail("the host must be localhost, a loopback address, a private address (10/8, 172.16/12, 192.168/16, fc00::/7) or a Tailscale address (100.64/10, fd7a:115c:a1e0::/48)");
	}
	const port = url.port ? Number(url.port) : 80;
	if (port < 1) throw fail("the port must be from 1 to 65535");
	return { host, port, source };
}

/** The raw setting and its source, or undefined when no proxy is set. */
export function proxySetting(env: NodeJS.ProcessEnv, file = CONFIG_FILE): { raw: string; source: string } | undefined {
	const fromEnv = env[PROXY_ENV]?.trim();
	if (fromEnv) return { raw: fromEnv, source: PROXY_ENV };
	const source = `${SECTION}.proxy in pi-extras.json`;
	let config: Record<string, unknown>;
	try {
		config = readJsonObject(file);
	} catch {
		throw errors.proxyConfig(source, "pi-extras.json does not parse, so gov_search cannot tell whether a proxy is set. Correct or remove the file");
	}
	const section = config[SECTION];
	if (section === undefined) return undefined;
	if (!section || typeof section !== "object" || Array.isArray(section)) throw errors.proxyConfig(source, `${SECTION} must be an object`);
	const value = (section as Record<string, unknown>).proxy;
	if (value === undefined || value === null || value === "") return undefined;
	if (typeof value !== "string") throw errors.proxyConfig(source, "proxy must be a string such as http://127.0.0.1:8080");
	return value.trim() ? { raw: value.trim(), source } : undefined;
}

/** The proxy to use, undefined for a direct request, or a thrown error when the setting is not safe to use. */
export function resolveProxy(env: NodeJS.ProcessEnv, file = CONFIG_FILE): ProxyAddress | undefined {
	const setting = proxySetting(env, file);
	return setting ? parseProxyUrl(setting.raw, setting.source) : undefined;
}
