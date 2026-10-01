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

describe.runIf(phase === 'origin-pre-migrator')(`${lane}: compatible fork pre-migrator`, () => {
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
