import { afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('node:fs/promises', () => ({ open: mocks.open }));
import { credentialPath, readCredential } from '../../lib/kagi/credential.js';
afterEach(() => vi.unstubAllEnvs());
it('reads bounded regular credential file internally and closes it', async () => {
  vi.stubEnv('KAGI_TOKEN_FILE', '/synthetic/path'); expect(credentialPath()).toBe('/synthetic/path');
  const close = vi.fn(); mocks.open.mockResolvedValue({ stat: async () => ({ isFile: () => true, size: 10 }), readFile: async () => 'test-token', close });
  expect(await readCredential()).toBe('test-token'); expect(close).toHaveBeenCalledOnce();
  vi.stubEnv('KAGI_TOKEN_FILE', ''); expect(credentialPath()).toMatch(/\.secrets\/kagi_token$/);
});
it('sanitizes unavailable, oversized and cancelled credential reads', async () => {
  mocks.open.mockRejectedValue(new Error('sensitive-path'));
  await expect(readCredential()).rejects.toThrow('credential');
  mocks.open.mockResolvedValue({ stat: async () => ({ isFile: () => false, size: 9000 }), close: vi.fn() });
  await expect(readCredential()).rejects.toThrow('credential');
  const controller = new AbortController(); controller.abort(); await expect(readCredential(controller.signal)).rejects.toThrow('cancelled');
});
