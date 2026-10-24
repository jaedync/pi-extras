/**
 * The optional Firecrawl API key: `FIRECRAWL_API_KEY`, else the key file
 * (`FIRECRAWL_API_KEY_FILE`, default ~/.secrets/firecrawl_api_key), as
 * Kagi reads its token file. Read at each search, so a key deployed or
 * changed later applies without /reload. No default file means a search
 * without a key; a file that is there but cannot be used is an error, since
 * its owner meant to send a key.
 */
import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { errorCode, errors, GovSearchError } from "./errors.ts";

export const KEY_ENV = "FIRECRAWL_API_KEY";
export const KEY_FILE_ENV = "FIRECRAWL_API_KEY_FILE";
const MAX_FILE_BYTES = 4096;

export const defaultKeyFile = () => join(homedir(), ".secrets", "firecrawl_api_key");

/** A key goes into a header, so anything but printable ASCII without spaces is refused before it can split one. */
function checked(raw: string, source: string): string {
	const key = raw.trim();
	if (!/^[\x21-\x7e]{8,256}$/.test(key)) throw errors.key(source);
	return key;
}

async function readKeyFile(path: string, explicit: boolean, signal?: AbortSignal): Promise<string | undefined> {
	const source = explicit ? `the file in ${KEY_FILE_ENV}` : "~/.secrets/firecrawl_api_key";
	let file;
	try {
		file = await open(path, "r");
	} catch (error) {
		if (errorCode(error) === "ENOENT" && !explicit) return undefined;
		throw errors.keyFile(source, errorCode(error));
	}
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw errors.keyFile(source, stat.isFile() ? "too large" : "not a file");
		const text = await file.readFile({ encoding: "utf8", signal });
		return text.trim() ? checked(text, source) : undefined;
	} catch (error) {
		if (signal?.aborted) throw errors.cancelled();
		throw error instanceof GovSearchError ? error : errors.keyFile(source, errorCode(error));
	} finally {
		await file.close();
	}
}

export async function readKey(env: NodeJS.ProcessEnv, signal?: AbortSignal, defaultFile = defaultKeyFile()): Promise<string | undefined> {
	const raw = env[KEY_ENV];
	if (raw !== undefined && raw.trim() !== "") return checked(raw, KEY_ENV);
	const explicit = env[KEY_FILE_ENV]?.trim();
	return readKeyFile(explicit || defaultFile, Boolean(explicit), signal);
}
