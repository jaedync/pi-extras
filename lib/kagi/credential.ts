import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { KagiError } from './errors.js';

export const credentialPath = () => process.env.KAGI_TOKEN_FILE || join(homedir(), '.secrets', 'kagi_token');
export function parseCredential(value: string): string {
  let token = value.trim();
  if (/^https?:/i.test(token)) {
    try {
      const link = new URL(token);
      if (link.origin !== 'https://kagi.com' || link.username || link.password || link.hash ||
        !['/', '/search', '/html/search'].includes(link.pathname) || link.searchParams.getAll('token').length !== 1) throw new Error();
      token = link.searchParams.get('token')!;
    } catch { throw new KagiError('credential'); }
  }
  // Cookie-octet subset: no whitespace, quote, semicolon or backslash/header injection.
  if (!token || token.length > 4096 || !/^[A-Za-z0-9._~+/%=:-]+$/.test(token)) throw new KagiError('credential');
  return token;
}
export async function readCredential(signal?: AbortSignal, path = credentialPath()): Promise<string> {
  let file;
  try {
    signal?.throwIfAborted();
    file = await open(path, 'r');
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 8192) throw new KagiError('credential');
    const data = await file.readFile({ encoding: 'utf8', signal });
    return parseCredential(data);
  } catch { throw new KagiError(signal?.aborted ? 'cancelled' : 'credential'); }
  finally { await file?.close(); }
}
