import { CloudRouteMode, LoginResponseDto, Permission, updateConfig } from '@frameleaf/sdk';
import { app, asBearerAuth, asKeyAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Normal App auth/controller/worker/transfer/accounting path. The opt-in provider origin answers
 * recorded contract bytes and a synthetic metered charge; this does not certify Cloud's wallet
 * ledger, GPU metering, DPoP signature verification, or Activity cost rendering.
 */
const FIXTURE = process.env.FRAMELEAF_CLOUD_ACCOUNTING_FIXTURE_ORIGIN ?? 'http://127.0.0.1:3010';
const CLOUD = process.env.FRAMELEAF_CLOUD_ACCOUNTING_GATEWAY ?? 'http://frameleaf-cloud-fixture:3010';
const TOTAL_USD = 0.2026; // ml/job-completed.json, independent of App accounting output
const DESCRIPTION = 'A golden retriever runs along a sandy beach at sunset, kicking up spray at the edge of the waves.';
const PENDING = ['restoration-faithful', 'restoration-creative', 'upscale', 'interpolation'];

type ProviderState = {
  requests: string[];
  lifecycle: {
    jobs: {
      id: string;
      clientRef: string;
      inputs: { inputId: string; bytes: number; sha256: string }[];
      started: boolean;
      released: boolean;
      uploads: string[];
      totalUsd: number | null;
    }[];
    transport: { method: string; path: string; bound: boolean }[];
  };
};

const providerState = async (): Promise<ProviderState> => {
  const response = await fetch(`${FIXTURE}/__fixture/state`);
  expect(response.status).toBe(200);
  return response.json() as Promise<ProviderState>;
};

// The ML health check pings the gateway on its own schedule; only account-scoped calls show spend.
const accountScoped = ({ requests }: ProviderState) => requests.filter((line) => line !== 'GET /ping');

describe('FL-159 approved description job → App accounting', () => {
  let admin: LoginResponseDto;
  let destinationId: string;
  const auth = () => asBearerAuth(admin.accessToken);

  beforeAll(async () => {
    const reset = await fetch(`${FIXTURE}/__fixture/reset`, { method: 'POST' });
    expect(reset.status).toBe(200);
    // A non-opt-in origin must fail immediately, rather than pretend to qualify this journey.
    const initial = await providerState();
    expect(initial.lifecycle).toBeDefined();
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    // Fixture-only link identity. All App destination creation, routing, consent and config below
    // use normal APIs; no auth flags or job/accounting/result/cost rows are seeded.
    const database = await utils.connectDatabase();
    await database.query(
      `INSERT INTO system_metadata (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [
        'frameleaf-cloud-link',
        JSON.stringify({
          status: 'linked',
          cloudUrl: CLOUD,
          instanceId: '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e53',
          dataRegion: 'eu',
          heartbeat: { nextAt: '2099-01-01T00:00:00.000Z' },
        }),
      ],
    );
    const config = await utils.getSystemConfig(admin.accessToken);
    await updateConfig(
      {
        adminConfigDto: {
          ...config,
          frameleafCloud: {
            ...config.frameleafCloud,
            cloudMl: {
              ...config.frameleafCloud!.cloudMl,
              enabled: true,
              routing: {
                ...config.frameleafCloud!.cloudMl.routing,
                descriptions: CloudRouteMode.Both,
                restoration: CloudRouteMode.Both,
                upscale: CloudRouteMode.Both,
                interpolation: CloudRouteMode.Both,
              },
            },
          },
        },
      },
      { headers: auth() },
    );
    const { body: destination } = await request(app)
      .post('/admin/cloud/ml/destination')
      .set(auth())
      .send({ workloads: ['enrichment', ...PENDING] })
      .expect(201);
    destinationId = destination.id;
    const { body: terms } = await request(app)
      .get('/admin/cloud/ml/consent/terms?identityNames=false&medicalSignals=false')
      .set(auth())
      .expect(200);
    await request(app)
      .put(`/ml-destinations/${destinationId}/consent`)
      .set(auth())
      .send({
        acknowledgeMediaLeavesNetwork: true,
        version: terms.requiredVersion,
        textSha256: terms.textSha256,
        features: { identityNames: false, medicalSignals: false, ocrAddon: false },
      })
      .expect(200);
    await request(app).put('/ml-destinations/routes/enrichment').set(auth()).send({ destinationId }).expect(200);
  });

  afterAll(async () => {
    await utils.disconnectDatabase();
  });

  it('publishes one verified result and attributes its final charge without duplicate or unknown-job spend', async () => {
    const database = await utils.connectDatabase();
    const { body: walletBefore } = await request(app).get('/admin/cloud/ml/wallet').set(auth()).expect(200);
    expect(walletBefore).toMatchObject({ balanceUsd: 10, heldUsd: 0, spentTodayUsd: 0 });
    for (const workload of PENDING) {
      const refused = await request(app)
        .post(`/ml-destinations/${destinationId}/admission`)
        .set(auth())
        .send({ workload })
        .expect(400);
      // This fixture serves descriptions only; approval does not invent provider support.
      expect(refused.body.code).toBe('workload-not-served');
    }
    const beforeJob = await providerState();
    expect(beforeJob.lifecycle.jobs).toHaveLength(0);
    expect(beforeJob.requests).not.toContain('POST /v2/estimates');
    expect(beforeJob.requests).not.toContain('POST /v2/jobs');
    const asset = await utils.createAsset(admin.accessToken);
    expect(asset.id).toBeDefined();
    // Wait for the actual upload's normal preview worker; never seed a preview or result row.
    await vi.waitFor(
      async () => {
        await request(app).get(`/assets/${asset.id}/thumbnail?size=preview`).set(auth()).expect(200);
      },
      { timeout: 15_000, interval: 500 },
    );
    const { body: estimate } = await request(app).post('/admin/cloud/ml/descriptions/estimate').set(auth()).expect(200);
    expect(estimate.photos).toBe(1);
    expect(estimate.refusal).toBeNull();
    expect(estimate.estimateId).toBeTruthy();
    const { body: queued } = await request(app)
      .post('/admin/cloud/ml/descriptions/batches')
      .set(auth())
      .send({ estimateId: estimate.estimateId })
      .expect(201);
    expect(queued).toMatchObject({ batches: 1, photos: 1 });
    expect(queued.operationIds).toHaveLength(1);
    const operationId = queued.operationIds[0] as string;
    // Idempotent normal approval must not queue a second operation or remote job.
    const replay = await request(app)
      .post('/admin/cloud/ml/descriptions/batches')
      .set(auth())
      .send({ estimateId: estimate.estimateId })
      .expect(201);
    expect(replay.body).toEqual(queued);
    await vi.waitFor(
      async () => {
        const row = await database.query(
          'SELECT "costUsd", "cloudJobId" FROM ml_workload_accounting WHERE "jobId" = $1',
          [operationId],
        );
        expect(row.rows).toHaveLength(1);
        expect(row.rows[0].cloudJobId).toBeTruthy();
        expect(row.rows[0].costUsd).toBeNull();
      },
      { timeout: 60_000, interval: 500 },
    );
    // Production cron and 60s poll delay are retained. No direct service/worker calls or fake clock.
    await vi.waitFor(
      async () => {
        const { body: operation } = await request(app).get(`/media-operations/${operationId}`).set(auth()).expect(200);
        expect(operation.status).toBe('completed');
        expect(operation.processedUnits).toBe('1');
        // Current projection intentionally exposes no batch cost; do not call this Activity cost proof.
        expect(operation.cloudJob).toBeNull();
      },
      { timeout: 125_000, interval: 1000 },
    );
    const { body: enrichment } = await request(app).get(`/assets/${asset.id}/image-enrichment`).set(auth()).expect(200);
    expect(enrichment).toMatchObject({
      assetId: asset.id,
      description: { status: 'success', description: DESCRIPTION },
    });
    const state = await providerState();
    expect(state.lifecycle.jobs).toHaveLength(1);
    const job = state.lifecycle.jobs[0];
    expect(job).toMatchObject({
      clientRef: `batch-${operationId}`,
      started: true,
      released: true,
      totalUsd: TOTAL_USD,
    });
    expect(job.inputs).toHaveLength(1);
    expect(job.uploads).toEqual([job.inputs[0].inputId]);
    expect(job.inputs[0].sha256).toMatch(/^[a-f\d]{64}$/);
    expect(state.lifecycle.transport.length).toBeGreaterThan(0);
    expect(state.lifecycle.transport.every((entry) => entry.bound)).toBe(true);
    expect(state.requests).toContain(`PUT /fixture-storage/${job.id}/in/${job.inputs[0].inputId}`);
    expect(state.requests).toContain(`GET /fixture-storage/${job.id}/out/${job.inputs[0].inputId}`);
    const readRows = () =>
      database.query(
        'SELECT "cloudJobId", "costUsd", credits, "bytesSent" FROM ml_workload_accounting WHERE "destinationId" = $1',
        [destinationId],
      );
    const rows = await readRows();
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ cloudJobId: job.id, costUsd: TOTAL_USD, credits: null });
    expect(Number(rows.rows[0].bytesSent)).toBe(job.inputs[0].bytes);
    const { body: settlements } = await request(app).get('/admin/cloud/ml/settlements').set(auth()).expect(200);
    expect(settlements.items).toHaveLength(1);
    expect(settlements.items[0]).toMatchObject({
      cloudJobId: job.id,
      workload: 'enrichment',
      costUsd: TOTAL_USD,
      gpuSeconds: 2,
      workers: 1,
    });
    const { body: wallet } = await request(app).get('/admin/cloud/ml/wallet').set(auth()).expect(200);
    expect(wallet.balanceUsd).toBeCloseTo(10 - TOTAL_USD, 6);
    expect(wallet).toMatchObject({ heldUsd: 0, spentTodayUsd: TOTAL_USD });
    const unknown = await fetch(`${FIXTURE}/__fixture/unknown-usage`, { method: 'POST' });
    expect(unknown.status).toBe(204);
    for (let index = 0; index < 2; index++) {
      await request(app).post('/admin/cloud/ml/usage').set(auth()).expect(204);
      const repeated = await readRows();
      expect(repeated.rows).toEqual(rows.rows);
    }
    const unknownRows = await database.query('SELECT id FROM ml_workload_accounting WHERE "cloudJobId" = $1', [
      '0192f1b0-0000-7000-8000-000000000000',
    ]);
    expect(unknownRows.rows).toHaveLength(0);
    const { secret } = await utils.createApiKey(admin.accessToken, [Permission.AdminCloudMlRead]);
    await request(app).get('/admin/cloud/ml/settlements').set(asKeyAuth(secret)).expect(200);
    const beforeDenied = await providerState();
    await request(app).post('/admin/cloud/ml/usage').set(asKeyAuth(secret)).expect(403);
    const afterDenied = await providerState();
    expect(accountScoped(afterDenied)).toEqual(accountScoped(beforeDenied));
    const afterKey = await readRows();
    expect(afterKey.rows).toEqual(rows.rows);
    // The origin must have observed only the approved description job, never a pending workload.
    const terminal = await providerState();
    expect(terminal.lifecycle.jobs).toHaveLength(1);
  });
});
