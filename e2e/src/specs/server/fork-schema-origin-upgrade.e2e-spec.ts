import { describe, expect, it } from 'vitest';
import {
  api,
  authHeaders,
  digest,
  ensureAdmin,
  loadState,
  OFFICIAL_WORKFLOW_MIGRATION,
  phase,
  saveState,
  uploadAsset,
  waitFor,
  withDatabase,
  workflowEvidence,
} from './fork-schema-certification';

const lane = 'origin-v3.1.0-to-fork';
const backfillFixtureCount = 256;

/**
 * FL-289: the first Frameleaf boot adopts the official library, which applies the post-certified
 * upstream `1786741078327-AddWorkflowLogsTable`. That adds `workflow.logging` (default false) and
 * changes nothing else in a workflow row. Compare the official columns and check the new one.
 */
const officialWorkflowDigests = (rows: any[]) =>
  rows.map((row) => {
    const { logging, ...official } = row;
    expect(logging ?? false).toBe(false);
    return digest(official);
  });

describe.runIf(phase === 'origin-seed')(`${lane}: exact official origin`, () => {
  it('seeds users, assets, albums, plugins, methods, workflows, and steps in the real official image', async () => {
    const ping = await api<{ res: string }>('/server/ping');
    expect(ping.res).toBe('pong');
    const admin = await ensureAdmin();
    const methods = await waitFor(
      () =>
        api<Array<{ name: string; pluginName: string }>>('/plugins/methods', {
          headers: authHeaders(admin.accessToken),
        }),
      (items) => items.length > 0,
    );
    expect(methods.some(({ name }) => name === 'assetFavorite')).toBe(true);

    const workflow = await api<{ id: string }>('/workflows', {
      body: JSON.stringify({
        description: 'Official-origin executable fixture',
        enabled: true,
        name: 'official-origin-favorite',
        steps: [{ config: { inverse: false }, method: 'immich-plugin-core#assetFavorite' }],
        trigger: 'AssetCreate',
      }),
      headers: { ...authHeaders(admin.accessToken), 'content-type': 'application/json' },
      method: 'POST',
    });
    const assets = await Promise.all(
      Array.from({ length: backfillFixtureCount }, (_, index) =>
        uploadAsset(admin.accessToken, `official-origin-${index}.png`),
      ),
    );
    const albums = await Promise.all(
      assets.map((asset, index) =>
        api<{ id: string }>('/albums', {
          body: JSON.stringify({ albumName: `Official origin album ${index}`, assetIds: [asset.id] }),
          headers: { ...authHeaders(admin.accessToken), 'content-type': 'application/json' },
          method: 'POST',
        }),
      ),
    );
    const fixtureCounts = await withDatabase(async (client) => {
      const result = await client.query<{ albums: number; assets: number }>(
        `SELECT
          (SELECT count(*)::int FROM public.album) AS albums,
          (SELECT count(*)::int FROM public.asset) AS assets`,
      );
      return result.rows[0]!;
    });
    expect(fixtureCounts).toEqual({ albums: backfillFixtureCount, assets: backfillFixtureCount });
    const evidence = await workflowEvidence();
    expect(evidence.ledger).toContainEqual(expect.objectContaining({ name: OFFICIAL_WORKFLOW_MIGRATION }));
    expect(evidence.rows.plugin.length).toBeGreaterThan(0);
    expect(evidence.rows.plugin_method.length).toBeGreaterThan(0);
    expect(evidence.rows.workflow.length).toBeGreaterThan(0);
    expect(evidence.rows.workflow_step.length).toBeGreaterThan(0);
    await saveState(lane, {
      admin,
      albumCount: fixtureCounts.albums,
      albumId: albums[0]!.id,
      assetCount: fixtureCounts.assets,
      assetId: assets[0]!.id,
      evidence,
      workflowId: workflow.id,
    });
  });
});

type GettingReadyObservation = {
  ping: string;
  redirect: string;
  page: number;
  /** The container health check's exit code, run while the status answered (null otherwise). */
  healthcheck: number | null;
  status: { state: string; copy?: string; backup?: { filename: string } } | null;
};

/** Recorded by scripts/test-fork-roundtrip.sh (start_fork_first_launch) while the fork first started. */
type FirstLaunchEvidence = {
  expected: 'taken' | 'skipped';
  copy: { filename: string; complete: boolean; forkSchemaStatements: number } | null;
  backups: string[];
  /** The backups the skip log lines name (the worker's skip and the boot's check before migrating). */
  skippedFor: string[];
  observations: GettingReadyObservation[];
};

const PRE_UPGRADE_COPY = /^immich-db-backup-\d{8}T\d{6}-pre-upgrade-v[\d.]+-pg[\d.]+\.sql\.gz$/;
const OFFICIAL_BACKUP = /^immich-db-backup-\d{8}T\d{6}-v3\.1\.0-pg[\d.]+\.sql\.gz$/;

describe.runIf(phase === 'origin-pre-migrator')(`${lane}: compatible fork pre-migrator`, () => {
  // FL-295: the first start served "Getting Ready…" (every page sent to it, every API call refused with
  // 503 and Retry-After) while it took the safety copy, or skipped it for a recent official backup.
  it('showed "Getting Ready…" and took or skipped the safety copy before upgrading', async () => {
    const evidence = await loadState<FirstLaunchEvidence>('first-launch');
    const preparing = evidence.observations.filter(({ status }) => status !== null);

    expect(preparing.length).toBeGreaterThan(0);
    // Each observation makes four requests in turn, so the server can start listening, or hand over,
    // between two of them ('000' is no answer). Whatever answered was the "Getting Ready…" worker.
    const gettingReady = /^302 http:\/\/127\.0\.0\.1:\d+\/getting-ready\?continue=%2Fphotos$/;
    for (const observation of preparing) {
      expect(['503 5', '000 ']).toContain(observation.ping);
      expect(observation.redirect === '000 ' || gettingReady.test(observation.redirect)).toBe(true);
    }
    expect(
      preparing.some(({ ping, redirect, page }) => ping === '503 5' && gettingReady.test(redirect) && page === 1),
    ).toBe(true);
    // the container reported healthy while it got ready, so no orchestrator restarts it mid-copy
    expect(preparing.some(({ healthcheck }) => healthcheck === 0)).toBe(true);
    expect(evidence.observations.at(-1)?.ping).toMatch(/^200/);

    const states = new Set(preparing.map(({ status }) => status!.state));
    if (evidence.expected === 'taken') {
      expect(evidence.copy).toEqual({
        filename: expect.stringMatching(PRE_UPGRADE_COPY),
        complete: true,
        forkSchemaStatements: 0,
      });
      expect([...states].some((state) => ['backing-up', 'done', 'ready'].includes(state))).toBe(true);
      expect(states.has('skipped')).toBe(false);
      // only the boot's own check before migrating, finding the copy just taken
      for (const filename of evidence.skippedFor) {
        expect(filename).toBe(evidence.copy!.filename);
      }
    } else {
      expect(evidence.copy).toBeNull();
      expect(evidence.backups.some((name) => OFFICIAL_BACKUP.test(name))).toBe(true);
      expect(states.has('skipped')).toBe(true);
      expect(states.has('backing-up')).toBe(false);
      const skipped = preparing.find(({ status }) => status!.state === 'skipped')!.status!;
      expect(skipped.backup?.filename).toMatch(OFFICIAL_BACKUP);
      expect(evidence.skippedFor[0]).toBe(skipped.backup?.filename);
    }
  });

  // FL-289: swapping the image is the upgrade. The first boot adopts the official library by itself
  // (inside the boot migration lock, without maintenance mode) and the API worker starts the backfill.
  it('adopts the official library at its first boot and preserves the official workflow ledger and rows', async () => {
    const ping = await api<{ res: string }>('/server/ping');
    expect(ping.res).toBe('pong');
    const before = await loadState<{ evidence: Awaited<ReturnType<typeof workflowEvidence>> }>(lane);
    const after = await workflowEvidence();
    expect(after.ledger).toEqual(before.evidence.ledger);
    expect(after.rowIds.workflow).toEqual(before.evidence.rowIds.workflow);
    expect(after.rowIds.workflow_step).toEqual(before.evidence.rowIds.workflow_step);
    expect(officialWorkflowDigests(after.rows.workflow)).toEqual(
      before.evidence.rows.workflow.map((row: any) => digest(row)),
    );
    expect(after.rowDigests.workflow_step).toEqual(before.evidence.rowDigests.workflow_step);
    const adoption = await withDatabase(async (client) => {
      const result = await client.query<{ adoptions: number; phase: string }>(
        `SELECT
          (SELECT count(*)::int FROM immich_fork.migration_audit
            WHERE name = 'official-origin-adoption' AND status = 'applied') AS adoptions,
          (SELECT phase FROM immich_fork.state WHERE id = 1) AS phase`,
      );
      return result.rows[0]!;
    });
    // Only the API worker runs in this phase, so the started backfill has not finished.
    expect(adoption).toEqual({ adoptions: 1, phase: 'dual-write' });
  });
});

describe.runIf(phase === 'origin-post-migrator')(`${lane}: compatible fork post-migrator`, () => {
  it('applies newer official migrations without deleting original workflow data', async () => {
    const before = await loadState<{ evidence: Awaited<ReturnType<typeof workflowEvidence>> }>(lane);
    const after = await workflowEvidence();
    expect(after.rowIds.workflow).toEqual(before.evidence.rowIds.workflow);
    expect(after.rowIds.workflow_step).toEqual(before.evidence.rowIds.workflow_step);
    expect(officialWorkflowDigests(after.rows.workflow)).toEqual(
      before.evidence.rows.workflow.map((row: any) => digest(row)),
    );
  });
});
