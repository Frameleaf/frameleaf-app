import { randomUUID } from 'node:crypto';
import z from 'zod';
import { compareCodeUnits } from 'src/utils/compare.js';

/**
 * Frameleaf Cloud's run coverage contract (FC-149), re-declared as the cloud publishes it in
 * `packages/contracts/src/backup/run-coverage.ts` (Apache-2.0) at Frameleaf/frameleaf-cloud
 * `022a9585d3d09d6b542ed5a9d4c8817cd4d32c1e`, blob `36d71a27f93c5202a176ca49d04f039e5fb46ade`
 * (`coverage.ts` blob `0780642a7824128381e5dda4314e0aad6f188f39`). No cloud code is imported.
 *
 * Routes (instance token, DPoP-bound; `{api}` from discovery), all under `{api}/v2/backup/runs/:runId/coverage`:
 * - `POST /revisions`: begin an immutable revision header.
 * - `PUT /revisions/:revisionId/pages/:pageIndex`: one page of at most 32 rows, 8192 UTF-8 bytes.
 * - `POST /revisions/:revisionId/finalize`: publish the complete revision.
 * - `GET /` and `GET /revisions/:revisionId/pages`: read published state and pages back.
 *
 * A row is an opaque account reference and four numbers. No album, person, tag, folder, date, name, path or
 * choice of any kind is ever part of it.
 */
export const BACKUP_COVERAGE_PAGE_ROWS = 32;
export const BACKUP_COVERAGE_MAX_BYTES = 8192;

const Count = z.int().min(0).max(Number.MAX_SAFE_INTEGER);
const Sequence = Count.min(1);
const Timestamp = z.iso.datetime({ offset: true });
const Fingerprint = z.string().regex(/^[a-f0-9]{64}$/);
const Digest = z.string().regex(/^[0-9a-f]{64}$/);
/** The run report's manifest key, extended or basic ISO (Cloud main since FC-149). */
export const LEGACY_MANIFEST_KEY = /^m\/(?:\d{4}-\d{2}-\d{2}T[\d.:-]+|\d{8}T\d{6})Z\.json\.gz$/;

export const backupCoverageRowSchema = z
  .strictObject({
    userFingerprint: Fingerprint,
    totalOriginals: Count,
    selectedOriginals: Count,
    licenceEligible: z.boolean(),
    includedOriginals: Count.nullable(),
  })
  .superRefine((row, ctx) => {
    if (row.selectedOriginals > row.totalOriginals) {
      ctx.addIssue({ code: 'custom', path: ['selectedOriginals'], message: 'Selection exceeds total originals.' });
    }
    if (row.includedOriginals !== null && row.includedOriginals > row.selectedOriginals) {
      ctx.addIssue({ code: 'custom', path: ['includedOriginals'], message: 'Inclusion exceeds selected originals.' });
    }
    if (!row.licenceEligible && row.includedOriginals !== null && row.includedOriginals !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['includedOriginals'],
        message: 'An ineligible account cannot have included originals.',
      });
    }
  });
export type BackupCoverageRow = z.infer<typeof backupCoverageRowSchema>;

export const backupCoverageSnapshotSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('legacy'), manifestKey: z.string().max(64).regex(LEGACY_MANIFEST_KEY) }),
    z.strictObject({ kind: z.literal('receipt'), vaultId: z.uuid(), snapshotId: z.uuid(), digest: Digest }),
  ])
  .nullable();
export type BackupCoverageSnapshot = z.infer<typeof backupCoverageSnapshotSchema>;

export const backupCoverageRevisionInputSchema = z
  .strictObject({
    revisionId: z.uuid(),
    sequence: Sequence,
    inventoryAt: Timestamp,
    accountCount: Count,
    pageCount: Count,
    snapshot: backupCoverageSnapshotSchema,
  })
  .superRefine((input, ctx) => {
    if (input.pageCount !== Math.ceil(input.accountCount / BACKUP_COVERAGE_PAGE_ROWS)) {
      ctx.addIssue({ code: 'custom', path: ['pageCount'], message: 'Page count does not match account count.' });
    }
  });
export type BackupCoverageRevisionInput = z.infer<typeof backupCoverageRevisionInputSchema>;

const rows = z
  .array(backupCoverageRowSchema)
  .max(BACKUP_COVERAGE_PAGE_ROWS)
  .superRefine((value, ctx) => {
    for (let index = 1; index < value.length; index++) {
      if (value[index - 1].userFingerprint >= value[index].userFingerprint) {
        ctx.addIssue({
          code: 'custom',
          path: [index, 'userFingerprint'],
          message: 'Fingerprints must be strictly increasing.',
        });
      }
    }
  });

export const backupCoveragePageInputSchema = z.strictObject({ rows: rows.min(1) });

export const backupCoverageRevisionSchema = z.strictObject({
  revisionId: z.uuid(),
  sequence: Sequence,
  inventoryAt: Timestamp,
  accountCount: Count,
  pageCount: Count,
  snapshot: backupCoverageSnapshotSchema,
  createdAt: Timestamp,
  publishedAt: Timestamp.nullable(),
  partialSelection: z.boolean().nullable(),
});
export type BackupCoverageRevision = z.infer<typeof backupCoverageRevisionSchema>;

export const backupRunCoverageStateSchema = z.strictObject({
  published: backupCoverageRevisionSchema.nullable(),
  pending: z.strictObject({ revisionId: z.uuid(), sequence: Sequence, inventoryAt: Timestamp }).nullable(),
});
export type BackupRunCoverageState = z.infer<typeof backupRunCoverageStateSchema>;

export const backupCoveragePageAcceptedSchema = z.strictObject({ revisionId: z.uuid(), pageIndex: Count });

export const backupCoverageRowsPageSchema = z.strictObject({
  revisionId: z.uuid(),
  sequence: Sequence,
  pageIndex: Count.nullable(),
  rows,
  nextPage: z.string().min(1).nullable(),
});
export type BackupCoverageRowsPage = z.infer<typeof backupCoverageRowsPageSchema>;

export const backupCoverageEndpoints = (api: string, runId: string) => {
  z.uuid().parse(runId);
  const base = `${api.replace(/\/+$/, '')}/v2/backup/runs/${runId}/coverage`;
  return {
    state: base,
    begin: `${base}/revisions`,
    page: (revisionId: string, pageIndex: number) => `${base}/revisions/${revisionId}/pages/${pageIndex}`,
    finalize: (revisionId: string) => `${base}/revisions/${revisionId}/finalize`,
    pages: (revisionId: string, afterPage: string | null) =>
      `${base}/revisions/${revisionId}/pages${afterPage ? `?afterPage=${encodeURIComponent(afterPage)}` : ''}`,
  };
};

/** One coverage revision ready to send: its header and the exact text of each page body. */
export type BackupCoverageRevisionBodies = {
  header: BackupCoverageRevisionInput;
  pages: string[];
};

/**
 * The bodies for one revision: rows in strict code-unit order of their fingerprint, exactly 32 on every
 * page but the last, each page serialised once with a fixed field order. Refuses duplicate fingerprints, a
 * row the contract would refuse, known inclusion without a snapshot, and a page over the byte limit.
 */
export const backupCoverageBodies = (input: {
  revisionId?: string;
  sequence: number;
  inventoryAt: string;
  snapshot: BackupCoverageSnapshot;
  rows: BackupCoverageRow[];
}): BackupCoverageRevisionBodies => {
  const sorted = input.rows
    .map((row) => backupCoverageRowSchema.parse(row))
    .toSorted((a, b) => compareCodeUnits(a.userFingerprint, b.userFingerprint));
  for (let index = 1; index < sorted.length; index++) {
    if (sorted[index - 1].userFingerprint === sorted[index].userFingerprint) {
      throw new Error('Two accounts share one coverage fingerprint');
    }
  }
  if (input.snapshot === null && sorted.some((row) => row.includedOriginals !== null)) {
    throw new Error('Coverage without a committed snapshot cannot claim included originals');
  }
  const pages: string[] = [];
  for (let at = 0; at < sorted.length; at += BACKUP_COVERAGE_PAGE_ROWS) {
    const body = JSON.stringify({
      rows: sorted.slice(at, at + BACKUP_COVERAGE_PAGE_ROWS).map((row) => ({
        userFingerprint: row.userFingerprint,
        totalOriginals: row.totalOriginals,
        selectedOriginals: row.selectedOriginals,
        licenceEligible: row.licenceEligible,
        includedOriginals: row.includedOriginals,
      })),
    });
    backupCoveragePageInputSchema.parse(JSON.parse(body));
    if (Buffer.byteLength(body, 'utf8') > BACKUP_COVERAGE_MAX_BYTES) {
      throw new Error('A coverage page exceeds the contract’s byte limit');
    }
    pages.push(body);
  }
  const header = backupCoverageRevisionInputSchema.parse({
    revisionId: input.revisionId ?? randomUUID(),
    sequence: input.sequence,
    inventoryAt: input.inventoryAt,
    accountCount: sorted.length,
    pageCount: pages.length,
    snapshot: input.snapshot,
  });
  return { header, pages };
};
