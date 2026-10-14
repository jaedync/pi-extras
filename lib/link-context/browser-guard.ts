/**
 * The local browser's only way out: a small HTTP proxy on loopback that
 * resolves each name itself and refuses private, loopback, link-local and
 * reserved addresses. A public page can redirect the browser, or load a
 * script, from any address; without this check a planted link could make the
 * browser read a router or a metadata service and return it as the page.
 * The proxy connects to the address it checked, so a second DNS answer
 * cannot swap in a private one.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { isPrivateHost } from "./url.ts";

export type Lookup = (host: string) => Promise<ReadonlyArray<{ address: string; family: number }>>;
/** The address to connect to for a host, or a rejection when the host is refused. */
export type Resolve = (host: string) => Promise<string>;

const systemLookup: Lookup = (host) => dnsLookup(host, { all: true, verbatim: true });

/**
 * An address of a public host, IPv4 first because many hosts have no IPv6
 * route. Every address must be public, or a later connection could reach a
 * private one.
 */
export async function publicAddress(host: string, lookup: Lookup = systemLookup): Promise<string> {
	const name = host.replace(/^\[|\]$/g, "");
	if (isPrivateHost(name)) throw new Error(`Refusing a private or local address: ${name}`);
	const addresses = await lookup(name);
	const refused = addresses.find((entry) => isPrivateHost(entry.address));
	if (refused) throw new Error(`Refusing ${name}: it resolves to the private address ${refused.address}`);
	const first = [...addresses].sort((a, b) => a.family - b.family)[0];
	if (!first) throw new Error(`${name} has no address`);
	return first.address;
}

export interface Guard {
	readonly port: number;
	close(): Promise<void>;
}

const REFUSED = "HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

function target(authority: string, defaultPort: number): { host: string; port: number } {
	const url = new URL(`http://${authority}`);
	return { host: url.hostname, port: Number(url.port) || defaultPort };
}

function tunnel(resolve: Resolve, req: IncomingMessage, client: Duplex, head: Buffer): void {
	client.on("error", () => client.destroy());
	let to: { host: string; port: number };
	try {
		to = target(req.url ?? "", 443);
	} catch {
		client.end(REFUSED);
		return;
	}
	resolve(to.host).then((address) => {
		const upstream = connect(to.port, address, () => {
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) upstream.write(head);
			upstream.pipe(client);
			client.pipe(upstream);
		});
		upstream.on("error", () => client.destroy());
		client.on("close", () => upstream.destroy());
	}, () => client.end(REFUSED));
}

function withoutProxyHeaders(headers: IncomingMessage["headers"]): IncomingMessage["headers"] {
	return Object.fromEntries(Object.entries(headers).filter(([key]) => !/^proxy-/i.test(key)));
}

function relay(resolve: Resolve, req: IncomingMessage, res: ServerResponse): void {
	let url: URL;
	try {
		url = new URL(req.url ?? "");
		if (url.protocol !== "http:") throw new Error("not http");
	} catch {
		res.writeHead(403).end();
		return;
	}
	resolve(url.hostname).then((address) => {
		const upstream = httpRequest({ host: address, port: Number(url.port) || 80, method: req.method, path: url.pathname + url.search, headers: withoutProxyHeaders(req.headers), setHost: false }, (answer) => {
			res.writeHead(answer.statusCode ?? 502, answer.headers);
			answer.pipe(res);
		});
		upstream.on("error", () => res.destroy());
		req.pipe(upstream);
	}, () => res.writeHead(403).end());
}

/** Starts the guard on a free loopback port. */
export async function startGuard(resolve: Resolve = (host) => publicAddress(host)): Promise<Guard> {
	const sockets = new Set<Socket | Duplex>();
	const server = createServer((req, res) => relay(resolve, req, res));
	server.on("connect", (req: IncomingMessage, client: Duplex, head: Buffer) => {
		sockets.add(client);
		client.on("close", () => sockets.delete(client));
		tunnel(resolve, req, client, head);
	});
	server.on("connection", (socket: Socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});
	await new Promise<void>((done, fail) => {
		server.once("error", fail);
		server.listen(0, "127.0.0.1", done);
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("The browser guard did not get a port");
	return {
		port: address.port,
		close: () => new Promise<void>((done) => {
			for (const socket of sockets) socket.destroy();
			server.close(() => done());
		}),
	};
}
