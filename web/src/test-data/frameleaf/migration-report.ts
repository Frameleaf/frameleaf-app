/** Migration audit reports shaped exactly like the CLI's `<ledger>.audit.json` (FL-75). */
/** A report exactly as the CLI writes it after a clean run (legacy fields included). */
export const cleanMigrationReport = () => ({
  format: 'frameleaf-migration-audit',
  formatVersion: 1,
  generatedAt: '2026-09-23T08:00:00.000Z',
  dryRun: false,
  from: 'https://old.example.com/api',
  to: 'https://new.example.com/api',
  user: 'owner@new.example.com',
  complete: true,
  verified: 5,
  ok: true,
  assets: { total: 5, transferred: 5, checked: 5, verified: 5, missing: 0, failed: 0 },
  owners: [{ source: 'owner@old.example.com', destination: 'owner@new.example.com' }],
  albums: { total: 2, topLevel: 1, nested: 1, maxDepth: 1, created: 2, linked: 2 },
  tags: { total: 1, assigned: 1 },
  people: { total: 1, attached: 1 },
  stacks: { total: 1, created: 1 },
  physicalReferences: { newUploads: 4, matchedExisting: 1, livePhotoPairs: 1, livePhotoPairsLinked: 1 },
  unresolved: [] as Array<Record<string, unknown>>,
  unresolvedCount: 0,
  sourceDeletion: 'never-automatic',
  totals: { assets: 5, uploaded: 5, missing: 0, failed: 0 },
  missing: [] as Array<Record<string, unknown>>,
});

/** A partially failed run: one original failed to transfer, so its album is not linked yet. */
export const failedMigrationReport = () => ({
  ...cleanMigrationReport(),
  ok: false,
  verified: 4,
  assets: { total: 5, transferred: 4, checked: 4, verified: 4, missing: 1, failed: 1 },
  albums: { total: 2, topLevel: 1, nested: 1, maxDepth: 1, created: 2, linked: 1 },
  physicalReferences: { newUploads: 4, matchedExisting: 0, livePhotoPairs: 1, livePhotoPairsLinked: 1 },
  unresolved: [
    { kind: 'asset', id: 'a3', name: 'Lake morning.jpg', reason: 'transfer-failed', detail: 'HTTP 404 Not Found' },
    { kind: 'album', id: 'al-banff', name: 'Trips / Banff', reason: 'not-linked' },
  ],
  unresolvedCount: 2,
  missing: [{ aId: 'a3', filename: 'Lake morning.jpg', reason: 'not-transferred' }],
});
