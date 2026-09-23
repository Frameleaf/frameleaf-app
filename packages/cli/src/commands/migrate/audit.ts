import { AssetUploadAction } from '@immich/sdk';
import { chunk } from 'lodash-es';
import { writeFile } from 'node:fs/promises';
import type { ServerClient } from 'src/commands/migrate/client';
import type { Controller } from 'src/commands/migrate/controller';
import type { Ledger } from 'src/commands/migrate/ledger';
import {
  buildReportSections,
  REPORT_FORMAT,
  REPORT_FORMAT_VERSION,
  safeName,
  sanitizeDetail,
  sanitizeUrl,
  type ReportSections,
  type UnresolvedItem,
} from 'src/commands/migrate/report';

const PAGE = 20_000;
const MAX_MISSING_DETAIL = 5000;

export interface AuditMeta {
  from: string;
  to: string;
  /** Destination account that owns everything migrated. */
  user: string;
  /** Source account the library was read from, when known. */
  sourceUser?: string | null;
  dryRun?: boolean;
  /** Values that must never appear in the written report (the two API keys). */
  secrets?: string[];
}

/**
 * Written to `<ledger>.audit.json`. The legacy top-level fields (`totals`, `missing`,
 * `verified`, `ok`) stay for scripts and the local dashboard; `format`/`formatVersion`
 * and the sections below are what the web Maintenance area reads.
 */
export interface AuditReport extends Omit<ReportSections, 'unresolved'> {
  format: typeof REPORT_FORMAT;
  formatVersion: typeof REPORT_FORMAT_VERSION;
  generatedAt: string;
  /** A dry run never wrote to the destination, so it can never clear the source. */
  dryRun: boolean;
  from: string;
  to: string;
  user: string;
  /** False when the audit was interrupted before checking every asset. */
  complete: boolean;
  /** How many transferred assets were checked against the destination (present or not). */
  verified: number;
  ok: boolean;
  /**
   * Transferred = recorded in the ledger as on the destination. Checked = looked up on the
   * destination by checksum in this audit. Verified = checked and found. Only verified
   * assets count towards decommissioning the source.
   */
  assets: {
    total: number;
    transferred: number;
    checked: number;
    verified: number;
    missing: number;
    failed: number;
  };
  totals: Record<string, number>;
  missing: Array<{ aId: string; filename: string; reason: string }>;
  unresolved: UnresolvedItem[];
  /** Exact count; `unresolved` is capped for readability. */
  unresolvedCount: number;
  /** The migration only copies. Retiring the source is always the operator's decision. */
  sourceDeletion: 'never-automatic';
}

/**
 * Phase 9: prove every source asset is present on B (verified by the SHA-256 B stores),
 * reconcile organizational counts, and write audit-report.json. `ok` is the green light to
 * decommission SERVER A: zero missing assets and zero unresolved failures.
 */
export async function audit(
  to: ServerClient,
  ledger: Ledger,
  controller: Controller,
  reportPath: string,
  meta: AuditMeta,
): Promise<AuditReport> {
  controller.setPhase('audit');
  const secrets = meta.secrets ?? [];
  const missing: AuditReport['missing'] = [];
  const assetUnresolved: UnresolvedItem[] = [];
  let missingCount = 0;
  let absentCount = 0;
  // Keep the report readable (and bounded) if a run went badly wrong; the count stays exact.
  const record = (
    row: { aId: string; filename: string; error?: string | null },
    reason: 'not-transferred' | 'absent-on-B',
  ) => {
    missingCount++;
    if (missing.length < MAX_MISSING_DETAIL) {
      missing.push({ aId: row.aId, filename: safeName(row.filename), reason });
      assetUnresolved.push({
        kind: 'asset',
        id: row.aId,
        name: safeName(row.filename),
        ...(reason === 'absent-on-B'
          ? { reason: 'absent-on-destination' }
          : row.error
            ? { reason: 'transfer-failed', detail: sanitizeDetail(row.error, secrets) }
            : { reason: 'not-transferred' }),
      });
    }
  };

  let checked = 0;
  let isInterrupted = false;
  let after = '';
  pages: for (;;) {
    const page = ledger.auditRows(after, PAGE);
    if (page.length === 0) {
      break;
    }
    after = page.at(-1)!.aId;

    // Anything never transferred is definitively missing.
    const verifiable = page.filter((r) => r.uploaded && r.bChecksum);
    for (const row of page) {
      if (!row.uploaded || !row.bChecksum) {
        record(row, 'not-transferred');
      }
    }

    // Defensively confirm transferred assets really exist on B, by the checksum B stores.
    for (const part of chunk(verifiable, 5000)) {
      await controller.gate();
      if (controller.stopped) {
        // Bailing out leaves the remaining rows unverified. That must never be reported as
        // a clean audit, or a partially-checked run would read as "safe to decommission".
        isInterrupted = true;
        break pages;
      }
      const res = await to.checkBulkUpload(part.map((r) => ({ id: r.aId, checksum: r.bChecksum! })));
      const present = new Set(res.results.filter((r) => r.action === AssetUploadAction.Reject).map((r) => r.id));
      const absent = part.filter((row) => !present.has(row.aId));
      absentCount += absent.length;
      for (const row of absent) {
        record(row, 'absent-on-B');
      }
      checked += part.length;
      controller.log(`audited ${checked}`);
    }
  }

  const counts = ledger.counts();
  const { sections, unresolvedCount } = buildReportSections(ledger, meta, assetUnresolved, missingCount, secrets);
  const isDryRun = !!meta.dryRun;
  const report: AuditReport = {
    format: REPORT_FORMAT,
    formatVersion: REPORT_FORMAT_VERSION,
    generatedAt: new Date().toISOString(),
    dryRun: isDryRun,
    from: sanitizeUrl(meta.from),
    to: sanitizeUrl(meta.to),
    user: meta.user,
    complete: !isInterrupted,
    verified: checked,
    ok: !isDryRun && !isInterrupted && missingCount === 0 && counts.assetsFailed === 0,
    assets: {
      total: counts.assetsTotal,
      transferred: counts.assetsUploaded,
      checked,
      verified: checked - absentCount,
      missing: missingCount,
      failed: counts.assetsFailed,
    },
    ...sections,
    unresolvedCount,
    sourceDeletion: 'never-automatic',
    totals: {
      assets: counts.assetsTotal,
      uploaded: counts.assetsUploaded,
      missing: missingCount,
      failed: counts.assetsFailed,
      albums: counts.albumsTotal,
      albumsLinked: counts.albumsLinked,
      tags: counts.tagsTotal,
      tagsAssigned: counts.tagsAssigned,
      stacks: counts.stacksTotal,
      stacksDone: counts.stacksDone,
      people: counts.peopleTotal,
      peopleDone: counts.peopleDone,
    },
    missing,
  };
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  return report;
}
