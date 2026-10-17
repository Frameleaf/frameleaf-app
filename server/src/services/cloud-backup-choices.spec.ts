import { BadRequestException } from '@nestjs/common';
import { CloudBackupChoices } from 'src/services/cloud-backup-choices.js';
import type { CloudBackupManifest } from 'src/utils/cloud-backup.js';
import { backupUserFingerprint, canonicalSelection, selectionHash } from 'src/utils/cloud-backup-selection.js';

const INSTANCE = '01900000-0000-7000-8000-000000000001';
const ALBUM = '01900000-0000-7000-8000-0000000000a1';
const FOREIGN = '01900000-0000-7000-8000-0000000000a2';

const manifestHolding = (...assetIds: string[]) =>
  ({
    assets: Object.fromEntries(
      assetIds.map((id) => [id, { owner: 'owner', files: [{ role: 'original', path: '/x', sha256: 'a', size: 1 }] }]),
    ),
  }) as unknown as CloudBackupManifest;

describe(CloudBackupChoices.name, () => {
  const repository = () => ({
    getSelection: vi.fn().mockResolvedValue(null),
    setSelection: vi.fn().mockResolvedValue(undefined),
    choosable: vi.fn(),
    estimate: vi.fn().mockResolvedValue({ total: 10, selected: 4 }),
    getLatestCoverageReport: vi.fn(),
    listAccounts: vi.fn().mockResolvedValue([
      { id: 'user-a', name: 'Ann', email: 'ann@example.test', deletedAt: null },
      { id: 'user-b', name: 'Ben', email: 'ben@example.test', deletedAt: null },
    ]),
    findDecisionRunByManifest: vi.fn(),
    getInventoryPage: vi.fn(),
  });

  it('saves a choice made only from the account’s own library, and says how much it keeps', async () => {
    const selection = repository();
    selection.choosable.mockResolvedValue({ albumIds: [ALBUM], collectionIds: [], personIds: [], tagIds: [] });
    const sut = new CloudBackupChoices(selection as never);

    const saved = await sut.set('user-a', {
      mode: 'chosen',
      albumIds: [ALBUM, ALBUM],
      collectionIds: [],
      personIds: [],
      tagIds: [],
      folders: ['/library/a/Trips/', '  '],
      favorites: true,
      dateRanges: [{ kind: 'recent', months: 12 }],
    });

    expect(selection.setSelection).toHaveBeenCalledWith('user-a', {
      albumIds: [ALBUM],
      collectionIds: [],
      personIds: [],
      tagIds: [],
      folders: ['/library/a/Trips'],
      favorites: true,
      dateRanges: [{ kind: 'recent', months: 12 }],
    });
    expect(saved).toMatchObject({
      mode: 'chosen',
      totalOriginals: 10,
      selectedOriginals: 4,
      folders: ['/library/a/Trips'],
    });
  });

  it('refuses an album, person or tag the account cannot choose', async () => {
    const selection = repository();
    selection.choosable.mockResolvedValue({ albumIds: [], collectionIds: [], personIds: [], tagIds: [] });
    const sut = new CloudBackupChoices(selection as never);

    await expect(
      sut.set('user-a', {
        mode: 'chosen',
        albumIds: [FOREIGN],
        collectionIds: [],
        personIds: [],
        tagIds: [],
        folders: [],
        favorites: false,
        dateRanges: [],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(selection.setSelection).not.toHaveBeenCalled();
  });

  it('returns to Everything', async () => {
    const selection = repository();
    const sut = new CloudBackupChoices(selection as never);
    await expect(
      sut.set('user-a', {
        mode: 'everything',
        albumIds: [ALBUM],
        collectionIds: [],
        personIds: [],
        tagIds: [],
        folders: [],
        favorites: false,
        dateRanges: [],
      }),
    ).resolves.toMatchObject({ mode: 'everything', albumIds: [] });
    expect(selection.setSelection).toHaveBeenCalledWith('user-a', null);
  });

  it('shows an administrator each account’s published numbers by name, never its choice', async () => {
    const selection = repository();
    const row = (userId: string, overrides: Record<string, unknown>) => ({
      userFingerprint: backupUserFingerprint(INSTANCE, userId),
      totalOriginals: 3400,
      selectedOriginals: 1204,
      licenceEligible: true,
      includedOriginals: 1204,
      ...overrides,
    });
    selection.getLatestCoverageReport.mockResolvedValue({
      runId: 'run-1',
      inventoryAt: new Date('2026-10-16T12:00:00Z'),
      status: 'published',
      pages: [
        JSON.stringify({
          rows: [row('user-a', {}), row('user-b', { licenceEligible: false, includedOriginals: 0 })].toSorted((a, b) =>
            a.userFingerprint.localeCompare(b.userFingerprint),
          ),
        }),
      ],
    });
    const sut = new CloudBackupChoices(selection as never);

    const view = await sut.coverage(INSTANCE);

    expect(view).toMatchObject({ runId: 'run-1', state: 'published' });
    expect(view.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Ann', selectedOriginals: 1204, includedOriginals: 1204 }),
        expect.objectContaining({ name: 'Ben', licenceEligible: false, includedOriginals: 0 }),
      ]),
    );
    expect(JSON.stringify(view)).not.toMatch(/album|person|tag|folder|favorite|dateRange/i);
    await expect(
      new CloudBackupChoices({ ...selection, getLatestCoverageReport: vi.fn() } as never).coverage(INSTANCE),
    ).resolves.toEqual({
      runId: null,
      inventoryAt: null,
      state: 'unknown',
      accounts: [],
    });
  });

  it('labels what a backup left out by that backup’s own decision, per account, counts only', async () => {
    const selection = repository();
    selection.findDecisionRunByManifest.mockResolvedValue({ runId: 'run-1' });
    selection.getInventoryPage.mockResolvedValueOnce([
      { id: 'kept', ownerId: 'user-a', originalFileName: 'kept.jpg', locked: false, reason: 'included' },
      { id: 'chosen-out', ownerId: 'user-a', originalFileName: 'a.jpg', locked: false, reason: 'selection' },
      { id: 'unlicensed', ownerId: 'user-b', originalFileName: 'b.jpg', locked: false, reason: 'licence' },
      { id: 'missed', ownerId: 'user-b', originalFileName: 'c.jpg', locked: false, reason: 'included' },
      { id: 'later', ownerId: 'user-b', originalFileName: 'd.jpg', locked: false, reason: null },
    ]);
    const sut = new CloudBackupChoices(selection as never);

    const result = await sut.exclusions(manifestHolding('kept'), 'm/20261016T120000Z.json.gz');

    expect(result).toEqual({
      manifestKey: 'm/20261016T120000Z.json.gz',
      decisionKnown: true,
      totals: { selection: 1, licence: 1, notCommitted: 2, unknown: 0 },
      accounts: [
        { userId: 'user-a', name: 'Ann', selection: 1, licence: 0, notCommitted: 0, unknown: 0 },
        { userId: 'user-b', name: 'Ben', selection: 0, licence: 1, notCommitted: 2, unknown: 0 },
      ],
    });
  });

  it('never calls an exclusion deliberate without the backup’s decision', async () => {
    const selection = repository();
    selection.findDecisionRunByManifest.mockResolvedValue(undefined);
    selection.getInventoryPage.mockResolvedValueOnce([
      { id: 'x', ownerId: 'user-a', originalFileName: 'x.jpg', locked: false, reason: null },
    ]);
    const sut = new CloudBackupChoices(selection as never);
    await expect(sut.exclusions(manifestHolding(), 'm/20261016T120000Z.json.gz')).resolves.toMatchObject({
      decisionKnown: false,
      totals: { selection: 0, licence: 0, notCommitted: 0, unknown: 1 },
    });
  });

  it('lists an account’s own excluded items with their reason, never naming a Locked one', async () => {
    const selection = repository();
    selection.findDecisionRunByManifest.mockResolvedValue({ runId: 'run-1' });
    selection.getInventoryPage.mockResolvedValueOnce([
      { id: 'a', ownerId: 'user-a', originalFileName: 'a.jpg', locked: false, reason: 'selection' },
      { id: 'b', ownerId: 'user-a', originalFileName: 'secret.jpg', locked: true, reason: 'selection' },
      { id: 'c', ownerId: 'user-a', originalFileName: 'c.jpg', locked: false, reason: 'included' },
    ]);
    const sut = new CloudBackupChoices(selection as never);

    const page = await sut.ownerExclusions('user-a', manifestHolding('c'), {
      manifestKey: 'm/20261016T120000Z.json.gz',
      limit: 2,
    });

    expect(selection.getInventoryPage).toHaveBeenCalledWith('run-1', null, 5000, 'user-a');
    expect(page).toEqual({
      manifestKey: 'm/20261016T120000Z.json.gz',
      decisionKnown: true,
      items: [
        { assetId: 'a', name: 'a.jpg', reason: 'selection' },
        { assetId: 'b', name: '', reason: 'selection' },
      ],
      nextAfterId: 'b',
    });
  });
});

describe('selection hash', () => {
  it('is the same for the same choice in any order, and null for Everything', () => {
    const one = {
      albumIds: ['b', 'a'],
      collectionIds: [],
      personIds: [],
      tagIds: [],
      folders: ['/x/'],
      favorites: false,
      dateRanges: [{ kind: 'recent' as const, months: 12 }],
    };
    const two = { ...one, albumIds: ['a', 'b', 'a'], folders: ['/x'] };
    expect(selectionHash(one)).toBe(selectionHash(two));
    expect(canonicalSelection(one).albumIds).toEqual(['a', 'b']);
    expect(selectionHash(null)).toBeNull();
    expect(selectionHash({ ...one, favorites: true })).not.toBe(selectionHash(one));
  });
});
