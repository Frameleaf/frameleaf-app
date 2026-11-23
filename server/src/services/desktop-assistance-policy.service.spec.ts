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

describe('setTranscode (FL-1761)', () => {
  const device = '4a4f7c32-6c1c-4e7f-9d52-1a2b3c4d5e6f';
  const revisionId = '9f0f5a52-73f2-4e43-8f3d-7f1f6c1a2b3c';
  const auth = { user: { id: owner, isAdmin: true }, session: { id: other } } as never;
  const updateTable = vi.fn();
  const row = (value: unknown) => {
    const query: Record<string, unknown> = {};
    for (const name of ['select', 'innerJoin', 'where', 'forUpdate', 'forShare']) query[name] = () => query;
    query.executeTakeFirst = () => Promise.resolve(value);
    query.execute = () => Promise.resolve([{ id: device }]);
    return query;
  };
  let target: unknown;

  beforeEach(() => {
    target = { id: device, revokedAt: null };
    const tx = {
      selectFrom: (table: string) => row(table === 'desktop_device' ? target : { id: owner }),
      updateTable,
    };
    metadata.withConfigTransaction.mockImplementation((write) => write(metadata, tx));
  });

  it('is off until turned on, and turning it on leaves the household revision alone without a sign-out', async () => {
    saved = { version: 1, accounts: {}, household: { revisionId, devices: [device] } };
    await expect(service.setTranscode(auth, device, { enabled: true, everyone: false })).resolves.toEqual({
      enabled: true,
      everyone: false,
    });
    expect(saved).toEqual({
      version: 1,
      accounts: {},
      household: { revisionId, devices: [device] },
      transcodeEnabledDevices: [device],
    });
    expect(updateTable).not.toHaveBeenCalled();
  });

  it('turning a computer off also clears its everyone permission and removes empty lists', async () => {
    saved = {
      version: 1,
      accounts: {},
      household: { revisionId, devices: [device], transcodeDevices: [device] },
      transcodeEnabledDevices: [device],
    };
    await service.setTranscode(auth, device, { enabled: false, everyone: false });
    expect(saved).toEqual({ version: 1, accounts: {}, household: { revisionId, devices: [device] } });
  });

  it('refuses everyone without the switch on', async () => {
    await expect(service.setTranscode(auth, device, { enabled: false, everyone: true })).rejects.toThrow(
      'desktop_transcode_everyone_needs_enabled',
    );
  });

  it('refuses everyone for a computer outside the household', async () => {
    saved = { version: 1, accounts: {}, transcodeEnabledDevices: [device] };
    await expect(service.setTranscode(auth, device, { enabled: true, everyone: true })).rejects.toThrow(
      'desktop_transcode_household_required',
    );
    expect(metadata.set).not.toHaveBeenCalled();
  });

  it('refuses a non-administrator', async () => {
    const member = { user: { id: owner, isAdmin: false }, session: { id: other } } as never;
    await expect(service.setTranscode(member, device, { enabled: true, everyone: false })).rejects.toThrow(
      'desktop_administrator_photo_session_required',
    );
  });

  it('leaving the household clears the everyone permission but keeps the computer on', async () => {
    saved = {
      version: 1,
      accounts: {},
      household: { revisionId, devices: [device], transcodeDevices: [device] },
      transcodeEnabledDevices: [device],
    };
    const update = { set: () => update, where: () => update, execute: () => Promise.resolve() };
    updateTable.mockReturnValue(update);
    const deletion = { where: () => deletion, execute: () => Promise.resolve() };
    const tx = {
      selectFrom: (table: string) => row(table === 'desktop_device' ? target : { id: owner }),
      updateTable,
      withTables: () => ({ deleteFrom: () => deletion }),
    };
    metadata.withConfigTransaction.mockImplementation((write) => write(metadata, tx));
    await service.setHousehold(auth, device, false);
    expect(saved).toMatchObject({ household: { devices: [] }, transcodeEnabledDevices: [device] });
    expect((saved as { household: object }).household).not.toHaveProperty('transcodeDevices');
  });
});
