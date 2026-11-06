import { type Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import type { DB } from 'src/schema/index.js';
import { MlDestinationHealth, MlDestinationKind, MlProcessingSource, MlWorkload, SystemMetadataKey } from 'src/enum.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
let routes: MlDestinationRepository;

beforeAll(async () => {
  db = await getKyselyDB();
  routes = new MlDestinationRepository(db);
});
afterAll(async () => {
  await db?.destroy();
});
beforeEach(async () => {
  await db.deleteFrom('ml_workload_route').execute();
  await db.deleteFrom('ml_workload_route_origin').execute();
  await db.deleteFrom('ml_destination').execute();
  await db.deleteFrom('ml_processing_order').where('scope', '!=', 'default').execute();
  await routes.setProcessingOrder('default', [
    MlProcessingSource.Local,
    MlProcessingSource.Desktops,
    MlProcessingSource.Cloud,
  ]);
  routes.setCloudMlSettings(undefined);
});

const workloads = [MlWorkload.Clip, MlWorkload.Face, MlWorkload.Ocr, MlWorkload.Enrichment];
const destination = (kind: MlDestinationKind, overrides: { workloads?: MlWorkload[] } = {}) =>
  routes.create({
    kind,
    name: kind,
    url: kind === MlDestinationKind.FrameleafCloud ? null : `http://${randomUUID()}.lan:3003`,
    authToken: null,
    enabled: true,
    workloads: overrides.workloads ?? workloads,
    budgetLimitUsd: null,
    maxRuntimeMinutes: null,
    maxUploadBytes: null,
  });
const down = (id: string) =>
  routes.recordProbe(id, {
    health: MlDestinationHealth.Unhealthy,
    summary: 'not answering',
    workloads: null,
    probedAt: new Date(),
  });
const consent = (id: string) => routes.update(id, { consentAcknowledgedAt: new Date(), consentVersion: '2026-09-25' });

describe('where work goes (FL-456)', () => {
  it('runs on this server first, then a computer at home, then Frameleaf Cloud', async () => {
    const server = await destination(MlDestinationKind.Local);
    const home = await destination(MlDestinationKind.Lan);
    const cloud = await destination(MlDestinationKind.FrameleafCloud, { workloads: [MlWorkload.Enrichment] });
    await consent(cloud.id);
    await routes.setDefaultRoute(MlWorkload.Enrichment, server.id);

    expect((await routes.getRoute(MlWorkload.Enrichment))?.destinationId).toBe(server.id);
    await down(server.id);
    expect((await routes.getRoute(MlWorkload.Enrichment))?.destinationId).toBe(home.id);
    await down(home.id);
    expect((await routes.getRoute(MlWorkload.Enrichment))?.destinationId).toBe(cloud.id);
    // the route this server made is untouched: it still anchors the desktop helpers
    expect((await routes.getStoredRoute(MlWorkload.Enrichment))?.destinationId).toBe(server.id);
  });

  it('waits on the first place when none is available, and never uses a place outside the list', async () => {
    const server = await destination(MlDestinationKind.Local);
    const cloud = await destination(MlDestinationKind.FrameleafCloud, { workloads: [MlWorkload.Enrichment] });
    await routes.setProcessingOrder(MlWorkload.Enrichment, [MlProcessingSource.Local]);
    await down(server.id);
    await consent(cloud.id);
    const candidates = await routes.resolveRoute(MlWorkload.Enrichment);
    expect(candidates).toEqual([expect.objectContaining({ destinationId: server.id, available: false })]);
    expect((await routes.getRoute(MlWorkload.Enrichment))?.destinationId).toBe(server.id);
  });

  it('follows a reordered main list and a workload list of its own', async () => {
    const server = await destination(MlDestinationKind.Local);
    const cloud = await destination(MlDestinationKind.FrameleafCloud, { workloads: [MlWorkload.Enrichment] });
    await consent(cloud.id);
    await routes.setProcessingOrder('default', [
      MlProcessingSource.Cloud,
      MlProcessingSource.Local,
      MlProcessingSource.Desktops,
    ]);
    expect((await routes.getRoute(MlWorkload.Enrichment))?.destinationId).toBe(cloud.id);
    // Frameleaf Cloud may not read text, so text stays on this server
    expect((await routes.getRoute(MlWorkload.Ocr))?.destinationId).toBe(server.id);

    await routes.setProcessingOrder(MlWorkload.Enrichment, [MlProcessingSource.Local]);
    expect((await routes.getRoute(MlWorkload.Enrichment))?.destinationId).toBe(server.id);
    await routes.setProcessingOrder(MlWorkload.Enrichment, []);
    expect(await routes.getRoute(MlWorkload.Enrichment)).toBeUndefined();
    await routes.setProcessingOrder(MlWorkload.Enrichment, null);
    expect((await routes.getProcessingOrder()).overrides).toEqual({});
  });

  it('skips Frameleaf Cloud without consent, or while its processing is off for the work', async () => {
    const server = await destination(MlDestinationKind.Local);
    const cloud = await destination(MlDestinationKind.FrameleafCloud, { workloads: [MlWorkload.Enrichment] });
    await down(server.id);
    await routes.setProcessingOrder('default', [MlProcessingSource.Cloud, MlProcessingSource.Local]);
    expect((await routes.getRoute(MlWorkload.Enrichment))?.destinationId).toBe(cloud.id); // waits: no consent
    expect((await routes.resolveRoute(MlWorkload.Enrichment))[0].available).toBe(false);

    await consent(cloud.id);
    routes.setCloudMlSettings({
      enabled: true,
      routing: {
        descriptions: 'local',
        upscale: 'local',
        restoration: 'local',
        studio: 'local',
        interpolation: 'local',
      },
    });
    expect((await routes.resolveRoute(MlWorkload.Enrichment))[0].available).toBe(false);
    routes.setCloudMlSettings({
      enabled: true,
      routing: {
        descriptions: 'both',
        upscale: 'local',
        restoration: 'local',
        studio: 'local',
        interpolation: 'local',
      },
    });
    expect((await routes.resolveRoute(MlWorkload.Enrichment))[0].available).toBe(true);
  });

  it('keeps a pinned workload in its one place, and brings back the default route when it follows the order', async () => {
    const server = await destination(MlDestinationKind.Local);
    const home = await destination(MlDestinationKind.Lan);
    await routes.setRoute(MlWorkload.Face, home.id);
    expect((await routes.resolveRoute(MlWorkload.Face)).map(({ destinationId }) => destinationId)).toEqual([home.id]);

    await routes.restoreDefaultRoute(MlWorkload.Face);
    const state = (await routes.getRouteStates()).find((route) => route.workload === MlWorkload.Face);
    expect(state).toMatchObject({ destinationId: server.id, origin: 'default' });
    expect((await routes.getRoute(MlWorkload.Face))?.destinationId).toBe(server.id);
  });

  it('counts no desktop helpers without desktop assistance', async () => {
    await db.deleteFrom('system_metadata').where('key', '=', SystemMetadataKey.FrameleafDesktopAssistance).execute();
    expect(await routes.getDesktopCounts()).toEqual({ approved: 0, ready: 0 });
    expect(await routes.getDesktopHelpers()).toEqual([]);
    expect(await routes.hasReadyDesktop()).toBe(false);
  });
});
