/**
 * One HTTPS POST, either direct or through an HTTP CONNECT proxy, built on
 * node:http, node:net and node:tls only. Through a proxy, the CONNECT line
 * carries the host name, so the proxy (for example wireproxy on a VPN)
 * resolves api.firecrawl.dev and this machine makes no DNS lookup for it.
 * TLS runs end to end inside the tunnel, so the proxy sees only the host
 * name. There is no fallback: when the proxy fails, the request fails.
 */
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import { isIP, connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type ConnectionOptions } from "node:tls";
import type { ProxyAddress } from "./config.ts";
import { errorCode, errors, GovSearchError } from "./errors.ts";

export interface Target {
	host: string;
	port: number;
}

/** Turns a connected (or connecting) socket into the one HTTP runs on: TLS in use, plain in tests. */
export type Secure = (socket: Socket, target: Target) => Promise<Socket>;

export interface Reply {
	status: number;
	headers: IncomingHttpHeaders;
	body: string;
}

export interface PostOptions {
	target: Target;
	proxy?: ProxyAddress;
	secure: Secure;
	signal: AbortSignal;
	maxBodyBytes: number;
}

export function tlsSecure(options: ConnectionOptions = {}): Secure {
	return (socket, target) => new Promise((resolve, reject) => {
		// SNI takes host names only; the API target is always one, and test targets can be IP addresses.
		const secured = tlsConnect({ ...options, socket, host: target.host, ...(isIP(target.host) ? {} : { servername: target.host }), ALPNProtocols: ["http/1.1"] });
		const fail = (error: Error) => {
			secured.destroy();
			reject(error);
		};
		secured.once("error", fail);
		secured.once("secureConnect", () => {
			secured.off("error", fail);
			resolve(secured);
		});
	});
}

/** Opens a CONNECT tunnel to `target`; any answer but 200 is a refusal. */
export function tunnel(proxy: ProxyAddress, target: Target, signal: AbortSignal): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const authority = `${target.host}:${target.port}`;
		const request = httpRequest({ host: proxy.host, port: proxy.port, method: "CONNECT", path: authority, headers: { Host: authority }, agent: false, signal });
		request.once("connect", (response: IncomingMessage, socket: Socket, head: Buffer) => {
			if (response.statusCode !== 200) {
				socket.destroy();
				reject(errors.proxyRefused(response.statusCode));
				return;
			}
			// Bytes the proxy sent after its answer belong to the tunnel.
			if (head.length) socket.unshift(head);
			resolve(socket);
		});
		// `on`, not `once`: a second socket error after the first must not crash Pi; the promise settles once.
		request.on("error", (error) => reject(errors.proxy(errorCode(error))));
		request.end();
	});
}

function readReply(response: IncomingMessage, maxBytes: number, proxied: boolean): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const tooLarge = () => errors.response(`the response is larger than ${Math.round(maxBytes / 1_000_000)} MB`);
		if (Number(response.headers["content-length"]) > maxBytes) {
			reject(tooLarge());
			response.destroy();
			return;
		}
		const chunks: Buffer[] = [];
		let bytes = 0;
		response.on("data", (chunk: Buffer) => {
			bytes += chunk.byteLength;
			if (bytes > maxBytes) {
				// Settle first: the destroy below also fires the error listener.
				reject(tooLarge());
				response.destroy();
				return;
			}
			chunks.push(chunk);
		});
		response.once("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
		response.on("error", (error) => reject(errors.network(errorCode(error), proxied)));
		response.once("aborted", () => reject(errors.network("ECONNRESET", proxied)));
	});
}

function exchange(socket: Socket, path: string, headers: Record<string, string>, body: string, options: PostOptions): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const proxied = options.proxy !== undefined;
		const request = httpRequest({
			createConnection: () => socket,
			method: "POST",
			path,
			// The socket already reaches the target, so Host is set by hand; Node would otherwise write localhost.
			headers: { ...headers, Host: options.target.host, "Content-Length": String(Buffer.byteLength(body)), Connection: "close" },
			signal: options.signal,
		});
		request.once("response", (response) => readReply(response, options.maxBodyBytes, proxied).then(resolve, reject));
		request.on("error", (error) => reject(errors.network(errorCode(error), proxied)));
		request.end(body);
	});
}

export async function post(path: string, headers: Record<string, string>, body: string, options: PostOptions): Promise<Reply> {
	const sockets: Socket[] = [];
	const track = (socket: Socket) => {
		// TLS and HTTP report socket errors through their own listeners; this one only keeps an
		// error that comes before they attach from crashing Pi. The deadline bounds any hang.
		socket.on("error", () => {});
		sockets.push(socket);
		return socket;
	};
	const destroyAll = () => { for (const socket of sockets) socket.destroy(); };
	options.signal.addEventListener("abort", destroyAll, { once: true });
	try {
		if (options.signal.aborted) throw errors.cancelled();
		const proxied = options.proxy !== undefined;
		const raw = track(options.proxy ? await tunnel(options.proxy, options.target, options.signal) : netConnect(options.target.port, options.target.host));
		// A tunnel that the abort listener missed (it opened during the await) must not live on.
		if (options.signal.aborted) throw errors.cancelled();
		let secured: Socket;
		try {
			secured = track(await options.secure(raw, options.target));
		} catch (error) {
			throw error instanceof GovSearchError ? error : errors.network(errorCode(error), proxied);
		}
		return await exchange(secured, path, headers, body, options);
	} finally {
		options.signal.removeEventListener("abort", destroyAll);
		destroyAll();
	}
}
