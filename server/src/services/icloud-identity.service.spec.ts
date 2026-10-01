import { randomUUID } from 'node:crypto';
import { AuthDto } from 'src/dtos/auth.dto.js';
import {
  ICloudCoverageConnection,
  ICloudIdentityRow,
  ICloudInventoryItem,
} from 'src/repositories/icloud-identity.repository.js';
import { ICloudIdentityService, connectionHealth } from 'src/services/icloud-identity.service.js';

const MASTER = 'AQohY6yKZR0+tXlMi9FUQ82zySGo';
const name = (n: number) => `${String(n).padStart(8, '0')}-75DF-41B2-8773-80C153D73A5A`;
const cloudIdentifier = (n: number) => `${name(n)}:001:${MASTER}`;
const DATE = '2026-06-01T10:00:00.000Z';
const metadata = { originalFilename: 'IMG_0001.HEIC', creationDate: DATE };
const fields = {
  asset: { assetDate: { value: Date.parse(DATE) } },
  master: { filenameEnc: { value: 'IMG_0001.HEIC', type: 'STRING' } },
};
const auth = { user: { id: 'owner' } } as unknown as AuthDto;
const sha = (byte: number) => Buffer.alloc(32, byte);

const connection = (overrides: Partial<ICloudCoverageConnection> = {}): ICloudCoverageConnection => ({
  id: randomUUID(),
  label: 'Family iCloud',
  state: 'connected',
  lastError: null,
  accountHint: 'a•••@icloud.com',
  unhealthySince: null,
  nextRunAt: new Date('2026-06-02T00:00:00Z'),
  config: { libraries: [], albums: [], includeEdits: true },
  lastCompleteInventoryAt: new Date('2026-07-01T00:00:00Z'),
  ...overrides,
});

const record = (
  connectionId: string,
  n: number,
  overrides: Partial<ICloudInventoryItem> = {},
): ICloudInventoryItem => ({
  connectionId,
  cplAssetRecordName: name(n),
  cplMasterRecordName: MASTER,
  assetFields: fields.asset,
  masterFields: fields.master,
  inScope: true,
  pendingRoles: [],
  pendingSince: null,
  ...overrides,
});

const identity = (n: number, overrides: Partial<ICloudIdentityRow> = {}): ICloudIdentityRow => ({
  id: randomUUID(),
  assetId: randomUUID(),
  libraryKey: 'library',
  cplAssetRecordName: name(n),
  cplMasterRecordName: MASTER,
  role: 'original',
  editVersion: '',
  sha256: sha(1),
  appleFingerprint: null,
  deliveredBy: 'icloud-sync:connection',
  deliveredAt: new Date('2026-06-01T00:00:00Z'),
  lastVerifiedAt: null,
  lastAuditResult: null,
  matchStrength: 'exact',
  ...overrides,
});

const setup = (state: {
  identities?: ICloudIdentityRow[];
  inventory?: ICloudInventoryItem[];
  connections?: ICloudCoverageConnection[];
  /** Asset ids the caller may see (FL-226 rules); default: every identity's asset. */
  visible?: string[];
  /** sha256 hex → asset id held by the caller. */
  hashes?: Record<string, string>;
}) => {
  const repository = {
    identities: vi.fn().mockResolvedValue(state.identities ?? []),
    inventory: vi.fn().mockResolvedValue(state.inventory ?? []),
    connections: vi.fn().mockResolvedValue(state.connections ?? []),
  };
  const visible = state.visible ?? (state.identities ?? []).map(({ assetId }) => assetId);
  const integrity = {
    getSafetyQuery: vi.fn((_auth: AuthDto, hashes?: string[]) => ({
      where: (_column: string, _op: string, ids: string[]) => ({
        execute: () => Promise.resolve(ids.filter((id) => visible.includes(id)).map((id) => ({ id }))),
      }),
      execute: () =>
        Promise.resolve(
          (hashes ?? []).flatMap((hash) => (state.hashes?.[hash] ? [{ id: state.hashes[hash], sha256: hash }] : [])),
        ),
    })),
  };
  const logger = { setContext: vi.fn(), log: vi.fn(), warn: vi.fn() };
  return {
    sut: new ICloudIdentityService(repository as never, integrity as never, logger as never),
    repository,
  };
};

const lookupItem = (n: number, overrides: Record<string, unknown> = {}) => ({
  id: `item-${n}`,
  cloudIdentifier: cloudIdentifier(n),
  roles: ['original' as const],
  ...metadata,
  ...overrides,
});

describe(ICloudIdentityService.name, () => {
  afterEach(() => {
    delete process.env.FRAMELEAF_ICLOUD_IDENTITY_MATCHING;
  });

  it('maps connection states to what the app explains', () => {
    expect(connectionHealth({ state: 'connected' })).toBe('healthy');
    expect(connectionHealth({ state: 'awaiting-2fa' })).toBe('reauthentication-required');
    expect(connectionHealth({ state: 'awaiting-device-approval' })).toBe('device-approval-required');
    expect(connectionHealth({ state: 'error' })).toBe('failing');
  });

  describe('lookup', () => {
    it('answers on-server, exactly, when the device holds the same bytes', async () => {
      const known = identity(1);
      const { sut } = setup({ identities: [known] });
      const { items } = await sut.lookup(auth, {
        items: [lookupItem(1, { sha256ByRole: { original: sha(1).toString('hex') } })],
      });
      expect(items[0].roles[0]).toMatchObject({
        state: 'on-server',
        assetId: known.assetId,
        matchStrength: 'exact',
        deliveredBy: 'icloud-sync:connection',
        auditVerifiedAt: null,
      });
    });

    it('acts on corroborated metadata, never on a hint', async () => {
      const c = connection();
      const known = identity(1);
      const { sut } = setup({ identities: [known], inventory: [record(c.id, 1)], connections: [c] });
      const agreed = await sut.lookup(auth, { items: [lookupItem(1)] });
      expect(agreed.items[0].roles[0]).toMatchObject({ state: 'on-server', matchStrength: 'corroborated' });

      const disagreed = await sut.lookup(auth, { items: [lookupItem(1, { originalFilename: 'OTHER.HEIC' })] });
      // reported, so hint rates can be measured, but never acted on
      expect(disagreed.items[0].roles[0]).toMatchObject({ state: 'unknown', assetId: null, matchStrength: 'hint' });
    });

    it('reports two assets for one item and role for review', async () => {
      const { sut } = setup({ identities: [identity(1), identity(1, { sha256: sha(2) })] });
      const { items } = await sut.lookup(auth, { items: [lookupItem(1)] });
      expect(items[0].roles[0].state).toBe('review');
    });

    it('never names an asset the caller may not see (Locked without an elevated session)', async () => {
      const known = identity(1);
      const { sut } = setup({ identities: [known], visible: [] });
      const { items } = await sut.lookup(auth, {
        items: [lookupItem(1, { sha256ByRole: { original: sha(1).toString('hex') } })],
      });
      expect(items[0].roles[0]).toMatchObject({ state: 'unknown', assetId: null });
    });

    it('says the sync will bring an item it covers, with the edits, and leaves the rest to the device', async () => {
      const c = connection();
      const { sut } = setup({
        connections: [c],
        inventory: [
          record(c.id, 1, { pendingRoles: ['original'], pendingSince: new Date('2026-06-01T12:00:00Z') }),
          record(c.id, 2, { inScope: false }),
        ],
      });
      const { items } = await sut.lookup(auth, { items: [lookupItem(1), lookupItem(2), lookupItem(3)] });
      expect(items[0]).toMatchObject({
        editOwner: { kind: 'icloud-sync', connectionId: c.id },
        roles: [
          {
            state: 'sync-pending',
            connectionId: c.id,
            expectedBy: '2026-06-02T00:00:00.000Z',
            pendingSince: '2026-06-01T12:00:00.000Z',
          },
        ],
      });
      expect(items[1]).toMatchObject({
        editOwner: { kind: 'device' },
        roles: [{ state: 'out-of-scope', connectionId: c.id }],
      });
      expect(items[2]).toMatchObject({ editOwner: { kind: 'device' }, roles: [{ state: 'unknown' }] });
    });

    it('never counts on an unhealthy sync, but leaves it the edits it will import on recovery', async () => {
      const c = connection({ state: 'reauthentication-required', unhealthySince: new Date() });
      const { sut } = setup({ connections: [c], inventory: [record(c.id, 1, { pendingRoles: ['original'] })] });
      const { items } = await sut.lookup(auth, { items: [lookupItem(1)] });
      // two renders of one edit would follow if the device took the edits over while the sync is down
      expect(items[0]).toMatchObject({ editOwner: { kind: 'icloud-sync', connectionId: c.id } });
      expect(items[0].roles).toMatchObject([{ state: 'unknown' }]);
    });

    it('says sync-pending only for the roles the sync is still bringing', async () => {
      const c = connection();
      const { sut } = setup({ connections: [c], inventory: [record(c.id, 1, { pendingRoles: ['original'] })] });
      const { items } = await sut.lookup(auth, {
        items: [lookupItem(1, { roles: ['original', 'live-motion', 'raw-alternate'] })],
      });
      // a role the sync does not bring (nothing queued, failed, unsupported) stays with the device
      expect(items[0].roles.map(({ state }) => state)).toEqual(['sync-pending', 'unknown', 'unknown']);
    });

    it('keeps edits with the device when the sync does not import them', async () => {
      const c = connection({ config: { includeEdits: false } });
      const { sut } = setup({ connections: [c], inventory: [record(c.id, 1, { pendingRoles: ['original'] })] });
      const { items } = await sut.lookup(auth, { items: [lookupItem(1, { roles: ['original', 'edit-render'] })] });
      expect(items[0].editOwner.kind).toBe('device');
      // an edit render is never "coming from the sync"
      expect(items[0].roles.map(({ state }) => state)).toEqual(['sync-pending', 'unknown']);
    });

    it("answers an edit render for the device's own edit version, or the latest one", async () => {
      const older = identity(1, { role: 'edit-render', editVersion: 'v1', deliveredAt: new Date('2026-06-01') });
      const newer = identity(1, { role: 'edit-render', editVersion: 'v2', deliveredAt: new Date('2026-06-02') });
      const { sut } = setup({ identities: [older, newer] });
      const item = (editVersion?: string) =>
        lookupItem(1, {
          roles: ['edit-render'],
          editVersion,
          sha256ByRole: { 'edit-render': sha(1).toString('hex') },
        });
      const { items } = await sut.lookup(auth, { items: [item(), item('v1'), item('v3')] });
      // v3 is no edit version on record: unknown
      expect(items.map(({ roles }) => roles[0].assetId)).toEqual([newer.assetId, older.assetId, null]);
    });

    it.each(['false', 'FALSE', '0', 'off', ' no '])('switches identity matching off with %j', async (value) => {
      process.env.FRAMELEAF_ICLOUD_IDENTITY_MATCHING = value;
      const { sut } = setup({});
      await expect(sut.lookup(auth, { items: [lookupItem(1)] })).resolves.toMatchObject({ identityMatching: false });
    });

    it('matches only by SHA-256 when identity matching is switched off', async () => {
      process.env.FRAMELEAF_ICLOUD_IDENTITY_MATCHING = 'false';
      const assetId = randomUUID();
      const { sut, repository } = setup({ identities: [identity(1)], hashes: { [sha(9).toString('hex')]: assetId } });
      const { identityMatching, items } = await sut.lookup(auth, {
        items: [lookupItem(1), lookupItem(2, { sha256ByRole: { original: sha(9).toString('hex') } })],
      });
      expect(identityMatching).toBe(false);
      expect(repository.identities).not.toHaveBeenCalled();
      expect(items.map(({ roles }) => roles[0].state)).toEqual(['unknown', 'on-server']);
      expect(items[1].roles[0]).toMatchObject({ assetId, matchStrength: null, deliveredBy: null });
    });
  });

  describe('coverage', () => {
    const samples = (count: number, overrides: Record<string, unknown> = {}) =>
      Array.from({ length: count }, (_, n) => ({ cloudIdentifier: cloudIdentifier(n), ...metadata, ...overrides }));

    it('covers with at least 20 samples and 95 % of them in the inventory', async () => {
      const c = connection();
      const other = connection({ label: 'Other' });
      const { sut } = setup({
        connections: [c, other],
        inventory: [
          ...Array.from({ length: 19 }, (_, n) => record(c.id, n)),
          ...Array.from({ length: 5 }, (_, n) => record(other.id, n)),
        ],
      });
      const { connections } = await sut.coverage(auth, { deviceKey: randomUUID(), samples: samples(20) });
      expect(connections[0]).toMatchObject({
        connectionId: c.id,
        account: 'a•••@icloud.com',
        state: 'healthy',
        scope: { kind: 'libraries' },
        sampled: 20,
        matched: 19,
        covers: true,
      });
      expect(connections[1]).toMatchObject({ sampled: 20, matched: 5, covers: false });
    });

    it('needs 20 samples, counts only those older than the last complete inventory, and only corroborated ones', async () => {
      const c = connection();
      const { sut } = setup({ connections: [c], inventory: Array.from({ length: 30 }, (_, n) => record(c.id, n)) });
      const few = await sut.coverage(auth, { deviceKey: randomUUID(), samples: samples(19) });
      expect(few.connections[0]).toMatchObject({ sampled: 19, matched: 19, covers: false });

      const recent = await sut.coverage(auth, {
        deviceKey: randomUUID(),
        samples: samples(25, { creationDate: '2026-08-01T00:00:00Z' }),
      });
      expect(recent.connections[0]).toMatchObject({ sampled: 0, covers: false });

      const unconfirmed = await sut.coverage(auth, {
        deviceKey: randomUUID(),
        samples: samples(25, { originalFilename: 'OTHER.HEIC' }),
      });
      expect(unconfirmed.connections[0]).toMatchObject({ sampled: 25, matched: 0, covers: false });
    });

    it('counts only dated samples, and proves nothing while identity matching is switched off', async () => {
      const c = connection();
      const { sut } = setup({ connections: [c], inventory: Array.from({ length: 30 }, (_, n) => record(c.id, n)) });
      const undated = await sut.coverage(auth, {
        deviceKey: randomUUID(),
        samples: samples(25, { creationDate: undefined }),
      });
      expect(undated.connections[0]).toMatchObject({ sampled: 0, covers: false });

      process.env.FRAMELEAF_ICLOUD_IDENTITY_MATCHING = 'false';
      const off = await sut.coverage(auth, { deviceKey: randomUUID(), samples: samples(25) });
      expect(off).toMatchObject({ identityMatching: false, connections: [{ sampled: 0, matched: 0, covers: false }] });
    });

    it('never covers before a complete inventory, and reports an albums-only scope', async () => {
      const c = connection({ lastCompleteInventoryAt: null, config: { albums: ['library:album'] } });
      const { sut } = setup({ connections: [c], inventory: Array.from({ length: 30 }, (_, n) => record(c.id, n)) });
      const { connections } = await sut.coverage(auth, { deviceKey: randomUUID(), samples: samples(25) });
      expect(connections[0]).toMatchObject({
        sampled: 0,
        covers: false,
        scope: { kind: 'albums', albums: ['library:album'] },
      });
    });
  });
});
