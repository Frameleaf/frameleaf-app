import fs from 'node:fs/promises';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { getDiskUsage, getDiskUsageBigInt } from 'src/utils/disk-usage.js';

const { probe } = vi.hoisted(() => ({ probe: vi.fn() }));
vi.mock('node:child_process', async () => {
  const { promisify } = await import('node:util');
  return { execFile: Object.assign(vi.fn(), { [promisify.custom]: probe }) };
});

beforeEach(() => {
  probe.mockReset();
});
afterEach(() => vi.restoreAllMocks());

it('uses the OS capacity instead of the optimal I/O size on virtiofs', async () => {
  vi.spyOn(fs, 'statfs').mockResolvedValue({
    bsize: 1_048_576,
    blocks: 487_106_130,
    bfree: 71_265_908,
    bavail: 71_265_908,
  } as never);
  probe.mockResolvedValue({
    stdout:
      'Filesystem 1024-blocks Used Available Capacity Mounted on\nvirtiofs 1948424520 1663360888 285063632 86% /data\n',
  });
  const storage = new StorageRepository(LoggingRepository.create());
  expect(await storage.checkDiskUsage('/data')).toEqual({
    total: 487_106_130 * 4096,
    free: 71_265_908 * 4096,
    available: 71_265_908 * 4096,
  });
});

const output = (total: bigint | number, used: bigint | number, available: bigint | number) =>
  `Filesystem 1024-blocks Used Available Capacity Mounted on\nvolume with spaces ${total} ${used} ${available} 50% /mount with spaces\n`;

it.each([
  { allocation: 512, optimal: 4096 },
  { allocation: 4096, optimal: 1_048_576 },
  { allocation: 4096, optimal: 4096 },
])('does not derive byte units from the optimal block size: %o', async ({ allocation, optimal }) => {
  const blocks = 8192;
  const total = blocks * allocation;
  vi.spyOn(fs, 'statfs').mockResolvedValue({ bsize: optimal, blocks, bfree: blocks / 2, bavail: blocks / 4 } as never);
  probe.mockResolvedValue({ stdout: output(total / 1024, total / 2048, total / 4096) });
  expect(await getDiskUsage('/path with spaces')).toEqual({ total, free: total / 2, available: total / 4 });
  expect(fs.statfs).not.toHaveBeenCalled();
  expect(probe).toHaveBeenCalledWith(
    'df',
    ['-Pk', '/path with spaces'],
    expect.objectContaining({
      encoding: 'utf8',
      env: expect.objectContaining({ LC_ALL: 'C' }),
      timeout: 5000,
      killSignal: 'SIGKILL',
      maxBuffer: 65_536,
    }),
  );
});

it('keeps large admission comparisons exact and refuses unsafe numeric responses', async () => {
  const blocks = 9_007_199_254_740_993n;
  probe.mockResolvedValue({ stdout: output(blocks, 0, blocks) });
  expect((await getDiskUsageBigInt('/data')).available).toBe(blocks * 1024n);
  await expect(getDiskUsage('/data')).rejects.toThrow('supported numeric range');
});

it('reports an overfull filesystem as no available bytes', async () => {
  probe.mockResolvedValue({ stdout: output(100, 90, -2) });
  expect(await getDiskUsage('/data')).toEqual({ total: 102_400, free: 10_240, available: 0 });
});

it.each([
  '',
  'Filesystem 1024-blocks Used Available Capacity Mounted on\nwrapped\n100 50 40 50% /data\n',
  output(100, 101, 0),
  output(100, 50, 51),
  'Filesystem 1024-blocks Used Available Capacity Mounted on\nlabel 100 50 40 50% /fake 200 100 80 50% /data\n',
  output(100, 50, 40).replace('1024-blocks', '512-blocks'),
  output(100, 50, 40).replace('100 50 40', '100 not-a-count 40'),
])('refuses malformed or inconsistent OS capacity output', async (stdout) => {
  probe.mockResolvedValue({ stdout });
  await expect(getDiskUsage('/data')).rejects.toThrow('Invalid filesystem capacity');
});

it('propagates probe failures without using the misleading Node capacity', async () => {
  const fallback = vi.spyOn(fs, 'statfs');
  probe.mockRejectedValue(new Error('timed out'));
  await expect(getDiskUsage('/data')).rejects.toThrow('Filesystem capacity probe failed');
  expect(fallback).not.toHaveBeenCalled();
});
