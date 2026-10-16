import { access, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LibraryMlLifecycleAdapter,
  type LifecycleTestingApi,
} from 'test/fixtures/frameleaf-cloud-lifecycle-adapter.js';

vi.mock('node:http', async (original) => {
  const actual = await original<typeof import('node:http')>();
  return { ...actual, createServer: vi.fn(actual.createServer) };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, mkdtemp: vi.fn(actual.mkdtemp) };
});

describe('ML lifecycle fixture cleanup', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const result of vi.mocked(createServer).mock.results) {
      if (result.type === 'return') {
        result.value.closeAllConnections();
        await new Promise<void>((resolve) => result.value.close(() => resolve()));
      }
    }
    for (const result of vi.mocked(mkdtemp).mock.results) {
      if (result.type === 'return') {
        const folder = await result.value.catch(() => {});
        if (folder) await rm(folder, { recursive: true, force: true });
      }
    }
  });

  const api = () => ({
    createRecordedMlLifecycleServer: vi.fn(() => ({})),
    fixture: vi.fn(() => {
      throw new Error('fixture setup failed');
    }),
  });
  const run = (testing: ReturnType<typeof api>) =>
    new LibraryMlLifecycleAdapter(testing as unknown as LifecycleTestingApi).run('output-sha256');
  const listener = () => vi.mocked(createServer).mock.results[0].value;

  it('closes the listener when the recorded server factory throws', async () => {
    const testing = api();
    testing.createRecordedMlLifecycleServer.mockImplementation(() => {
      throw new Error('factory failed');
    });
    await expect(run(testing)).rejects.toThrow();
    expect(listener().listening).toBe(false);
  });

  it('closes the listener when temporary directory creation fails', async () => {
    vi.mocked(mkdtemp).mockRejectedValueOnce(new Error('temporary directory unavailable'));
    await expect(run(api())).rejects.toThrow();
    expect(listener().listening).toBe(false);
  });

  it('removes the temporary directory after an action fails', async () => {
    await expect(run(api())).rejects.toThrow('Library lifecycle action unavailable');
    expect(listener().listening).toBe(false);
    const folder = await vi.mocked(mkdtemp).mock.results[0].value;
    await expect(access(folder)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('still removes the temporary directory if listener cleanup reports failure', async () => {
    const testing = api();
    testing.createRecordedMlLifecycleServer.mockImplementation(() => {
      const server = listener();
      const close = server.close.bind(server);
      vi.spyOn(server, 'close').mockImplementation((callback) => close(() => callback?.(new Error('close failed'))));
      return {};
    });
    await expect(run(testing)).rejects.toThrow('Local lifecycle server cleanup failed');
    const folder = await vi.mocked(mkdtemp).mock.results[0].value;
    await expect(access(folder)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
