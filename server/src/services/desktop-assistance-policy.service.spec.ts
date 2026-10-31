import { randomUUID } from 'node:crypto';
import { SystemMetadataKey } from 'src/enum.js';
import { DesktopAssistancePolicyService } from 'src/services/desktop-assistance-policy.service.js';

const owner = '8da8d162-c2c3-4d1d-b6e1-9148b0bfd327';
const other = '2bd5aa96-614a-4df1-bd20-1c285bd8be63';
let saved: unknown;
const metadata = { get: vi.fn(), set: vi.fn(), withConfigTransaction: vi.fn() };
let service: DesktopAssistancePolicyService;
beforeEach(() => {
  vi.resetAllMocks();
  saved = null;
  metadata.get.mockImplementation(() => Promise.resolve(saved));
  metadata.set.mockImplementation((_key, value) => {
    saved = structuredClone(value);
    return Promise.resolve();
  });
  metadata.withConfigTransaction.mockImplementation((write) => write(metadata));
  service = new DesktopAssistancePolicyService(metadata as never);
});
it('persists one account choice and preserves its identity on repeated setup', async () => {
  const first = await service.enable(owner);
  expect(first.revisionId).toMatch(/^[a-f0-9-]{36}$/);
  expect(await service.enable(owner)).toEqual(first);
  expect(await service.read(owner)).toEqual(first);
  expect(metadata.set).toHaveBeenCalledTimes(1);
  expect(metadata.set).toHaveBeenCalledWith(
    SystemMetadataKey.FrameleafDesktopAssistance,
    expect.objectContaining({ version: 1 }),
  );
});
it('keeps account consent separate and starts absent installations disabled', async () => {
  expect(await service.read(owner)).toBeUndefined();
  await service.enable(owner);
  expect(await service.read(other)).toBeUndefined();
  await service.enable(other);
  expect(await service.read(owner)).toBeDefined();
  expect(await service.read(other)).toBeDefined();
});
it('refuses malformed stored policy without replacing it', async () => {
  saved = { version: 2, accounts: {} };
  await expect(service.enable(owner)).rejects.toThrow('desktop_pool_policy_invalid');
  expect(metadata.set).not.toHaveBeenCalled();
});

it('refuses capacity overflow without erasing prior account choices', async () => {
  saved = {
    version: 1,
    accounts: Object.fromEntries(Array.from({ length: 256 }, () => [randomUUID(), { revisionId: randomUUID() }])),
  };
  await expect(service.enable(owner)).rejects.toThrow('desktop_pool_policy_capacity');
  expect(metadata.set).not.toHaveBeenCalled();
});
