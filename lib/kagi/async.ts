import { KagiError } from './errors.js';
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new KagiError('cancelled'));
  return new Promise((resolve, reject) => {
    const abort = () => { cleanup(); reject(new KagiError('cancelled')); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
  });
}
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new KagiError('cancelled'));
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new KagiError('cancelled')); };
    const timer = setTimeout(() => { cleanup(); resolve(); }, Math.max(0, ms));
    signal.addEventListener('abort', abort, { once: true });
  });
}
