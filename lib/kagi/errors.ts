export type ErrorCode = 'input' | 'credential' | 'auth' | 'challenge' | 'markup' | 'redirect' | 'rate' | 'body' | 'content' | 'network' | 'http' | 'requestCap' | 'cancelled' | 'queue' | 'pace';
const messages: Record<ErrorCode, string> = {
  input: 'Kagi input is invalid. Check query (1-512 characters), limit (1-20), domain, and unsupported fields.',
  credential: 'Kagi credential is unavailable or invalid. Check the token file exists, is readable and contains a raw token or Kagi session link; never paste credentials into chat.',
  auth: 'Kagi authentication expired or rejected. Requests stopped for this credential. Open https://kagi.com/settings?p=browser in your browser, obtain a new session link, edit the token FILE locally (never paste it into chat), then retry.',
  challenge: 'Kagi challenge detected. Live requests stopped; no bypass attempted.',
  markup: 'Kagi markup is unrecognized. Cannot confirm results or an empty search. Live retries for this query pause briefly; unrelated queries remain available.',
  redirect: 'Kagi redirect rejected. Credentials were not forwarded.',
  rate: 'Kagi rate limit reached. Live requests stopped for this client.',
  body: 'Kagi response body exceeds the safety limit.',
  content: 'Kagi response content type is not HTML.',
  network: 'Kagi network failure.',
  http: 'Kagi HTTP request failed.',
  requestCap: 'Kagi request cap reached.',
  cancelled: 'Kagi search cancelled or timed out.',
  queue: 'Kagi request queue is full.',
  pace: 'Kagi page requests are paced per minute to protect the account, and this search could not start before its deadline. Retry in a minute.',
};
export class KagiError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) { super(messages[code]); this.name = 'KagiError'; this.code = code; }
}
export function safeError(error: unknown): KagiError {
  return error instanceof KagiError ? error : new KagiError('network');
}
