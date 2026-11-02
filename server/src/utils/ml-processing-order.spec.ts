import { describe, expect, it } from 'vitest';
import type { MlDestinationRow } from 'src/repositories/ml-destination.repository.js';
import { defaults } from 'src/config.js';
import {
  DEFAULT_ML_PROCESSING_ORDER,
  MlDestinationHealth,
  MlProcessingSource,
  MlProcessingSourceState,
  MlWorkload,
} from 'src/enum.js';
import {
  MlRoutePlanInput,
  firstCandidate,
  followsMainOrder,
  isProcessingOrder,
  planMlRoute,
  processingOrderOf,
  processingSourceStatuses,
} from 'src/utils/ml-processing-order.js';
import { mlDestinationStub } from 'test/fixtures/ml-destination.stub.js';

const { local, libraryLan } = mlDestinationStub;
/** Frameleaf Cloud allowed descriptions, with consent recorded and nothing spent. */
const cloud = {
  ...mlDestinationStub.frameleafCloud,
  consentAcknowledgedAt: new Date(),
  lastProbeHealth: MlDestinationHealth.Healthy,
};
const cloudOn = {
  enabled: true,
  routing: { ...defaults.frameleafCloud.cloudMl.routing, descriptions: 'both' as const },
};

const plan = (overrides: Partial<MlRoutePlanInput> = {}) =>
  planMlRoute({
    workload: MlWorkload.Face,
    order: { order: [...DEFAULT_ML_PROCESSING_ORDER], overrides: {} },
    destinations: [local, libraryLan, cloud],
    storedRoute: { destinationId: local.id, origin: 'default' },
    cloudMl: cloudOn,
    desktopsReady: true,
    ...overrides,
  });

const places = (candidates: ReturnType<typeof plan>) =>
  candidates.map(({ destinationId, desktopPool, available }) => ({ destinationId, desktopPool, available }));

describe('processing order (FL-456)', () => {
  describe('processingOrderOf', () => {
    it('defaults to this server, then your computers, then Frameleaf Cloud', () => {
      expect(processingOrderOf([])).toEqual({
        order: [MlProcessingSource.Local, MlProcessingSource.Desktops, MlProcessingSource.Cloud],
        overrides: {},
      });
    });

    it('reads the main list and every workload list, ignoring unreadable rows', () => {
      expect(
        processingOrderOf([
          { scope: 'default', sources: ['cloud', 'local', 'desktops'] },
          { scope: MlWorkload.Enrichment, sources: ['cloud'] },
          { scope: MlWorkload.Ocr, sources: [] },
          { scope: MlWorkload.Clip, sources: ['local', 'local'] },
          { scope: 'not-a-workload', sources: ['local'] },
        ]),
      ).toEqual({
        order: [MlProcessingSource.Cloud, MlProcessingSource.Local, MlProcessingSource.Desktops],
        overrides: { [MlWorkload.Enrichment]: [MlProcessingSource.Cloud], [MlWorkload.Ocr]: [] },
      });
    });

    it('falls back to the default order when the main row is unreadable', () => {
      expect(processingOrderOf([{ scope: 'default', sources: 'local' }]).order).toEqual(DEFAULT_ML_PROCESSING_ORDER);
      expect(isProcessingOrder(['local', 'elsewhere'])).toBe(false);
    });
  });

  describe('planMlRoute', () => {
    it('tries this server, then a computer added by address, then the desktop helpers, in order', () => {
      expect(places(plan())).toEqual([
        { destinationId: local.id, desktopPool: false, available: true },
        { destinationId: libraryLan.id, desktopPool: false, available: true },
        { destinationId: local.id, desktopPool: true, available: true },
      ]);
    });

    it('follows a reordered main list', () => {
      const candidates = plan({
        workload: MlWorkload.Enrichment,
        order: {
          order: [MlProcessingSource.Cloud, MlProcessingSource.Local, MlProcessingSource.Desktops],
          overrides: {},
        },
      });
      expect(candidates.map(({ source }) => source)).toEqual([MlProcessingSource.Cloud, MlProcessingSource.Local]);
      expect(firstCandidate(candidates)?.destinationId).toBe(cloud.id);
    });

    it("uses a workload's own list, and an empty one keeps it off", () => {
      const own = (sources: MlProcessingSource[]) =>
        plan({
          workload: MlWorkload.Enrichment,
          order: { order: [...DEFAULT_ML_PROCESSING_ORDER], overrides: { [MlWorkload.Enrichment]: sources } },
        });
      expect(own([MlProcessingSource.Cloud]).map(({ destinationId }) => destinationId)).toEqual([cloud.id]);
      expect(own([])).toEqual([]);
      expect(firstCandidate(own([]))).toBeUndefined();
    });

    it('keeps a workload an administrator pinned (or Buddy recovery restored) in its one place', () => {
      const pinnedTo = (destinationId: string | null) =>
        plan({ workload: MlWorkload.Face, storedRoute: { destinationId, origin: 'pinned' } }).map(
          ({ destinationId }) => destinationId,
        );
      expect(pinnedTo(libraryLan.id)).toEqual([libraryLan.id]);
      expect(pinnedTo(null)).toEqual([]);
      expect(
        followsMainOrder({ order: [...DEFAULT_ML_PROCESSING_ORDER], overrides: {} }, MlWorkload.Face, {
          destinationId: local.id,
          origin: 'pinned',
        }),
      ).toBe(false);
      // a list of its own wins over the pin
      expect(
        plan({
          workload: MlWorkload.Face,
          order: {
            order: [...DEFAULT_ML_PROCESSING_ORDER],
            overrides: { [MlWorkload.Face]: [MlProcessingSource.Local] },
          },
          storedRoute: { destinationId: libraryLan.id, origin: 'pinned' },
        }).map(({ destinationId }) => destinationId),
      ).toEqual([local.id]);
    });

    it('skips a place known to be down, and waits on the first place when none is available', () => {
      const down = { ...local, lastProbeHealth: MlDestinationHealth.Unhealthy };
      const candidates = plan({ destinations: [down, libraryLan], desktopsReady: false });
      expect(firstCandidate(candidates)?.destinationId).toBe(libraryLan.id);

      const nothing = plan({
        destinations: [down, { ...libraryLan, lastProbeHealth: MlDestinationHealth.Unhealthy }],
        desktopsReady: false,
      });
      expect(nothing.every(({ available }) => !available)).toBe(true);
      expect(firstCandidate(nothing)?.destinationId).toBe(down.id);
    });

    it('never lists a place that is turned off or not allowed to do the work', () => {
      const candidates = plan({
        workload: MlWorkload.Ocr,
        destinations: [{ ...local, enabled: false }, libraryLan],
        desktopsReady: false,
      });
      // the helper pool hangs off this server's route, which is off; the computer by address may not read text
      expect(candidates).toEqual([]);
    });

    it('offers the desktop helpers only for search, faces and text, through a route this server made', () => {
      const pool = (input: Partial<MlRoutePlanInput>) => plan(input).filter(({ desktopPool }) => desktopPool);
      expect(pool({ workload: MlWorkload.Ocr })).toHaveLength(1);
      expect(pool({ workload: MlWorkload.Enrichment })).toHaveLength(0);
      expect(pool({ storedRoute: { destinationId: local.id, origin: 'pinned' } })).toHaveLength(0);
      expect(pool({ storedRoute: undefined })).toHaveLength(0);
      expect(pool({ desktopsReady: false })).toEqual([expect.objectContaining({ available: false })]);
    });

    it('lists Frameleaf Cloud only when it may run the work, and uses it only with consent, within budget and turned on', () => {
      const cloudFor = (input: Partial<MlRoutePlanInput>) =>
        plan({ workload: MlWorkload.Enrichment, ...input }).find(({ destinationId }) => destinationId === cloud.id);
      expect(cloudFor({})?.available).toBe(true);
      expect(cloudFor({ workload: MlWorkload.Face })).toBeUndefined();
      expect(cloudFor({ destinations: [{ ...cloud, consentAcknowledgedAt: null }] })?.available).toBe(false);
      expect(cloudFor({ spentUsd: new Map([[cloud.id, 25]]) })?.available).toBe(false);
      expect(cloudFor({ cloudMl: { ...cloudOn, enabled: false } })?.available).toBe(false);
      expect(cloudFor({ cloudMl: defaults.frameleafCloud.cloudMl })?.available).toBe(false);
      // without the settings, admission decides
      expect(cloudFor({ cloudMl: undefined })?.available).toBe(true);
    });

    it('puts the destination this server routed to first among its kind', () => {
      const second = { ...local, id: 'ml-destination-second' };
      const candidates = plan({
        workload: MlWorkload.Enrichment,
        destinations: [local, second],
        storedRoute: { destinationId: second.id, origin: 'pinned' },
      });
      expect(candidates.map(({ destinationId }) => destinationId)).toEqual([second.id, local.id]);
    });
  });

  describe('processingSourceStatuses', () => {
    it('says nothing is set up on a server without helpers or Frameleaf Cloud', () => {
      expect(processingSourceStatuses([local], { approved: 0, ready: 0 }, false)).toEqual([
        { source: MlProcessingSource.Local, state: MlProcessingSourceState.Ready, ready: 1, total: 1 },
        { source: MlProcessingSource.Desktops, state: MlProcessingSourceState.NotSetUp, ready: 0, total: 0 },
        { source: MlProcessingSource.Cloud, state: MlProcessingSourceState.NotSetUp, ready: 0, total: 0 },
      ]);
    });

    it('tells a helper that is not answering from one that is off', () => {
      const [, offline] = processingSourceStatuses([local], { approved: 1, ready: 0 }, false);
      expect(offline.state).toBe(MlProcessingSourceState.NotAnswering);
      const [, off] = processingSourceStatuses(
        [local, { ...libraryLan, enabled: false }],
        { approved: 0, ready: 0 },
        false,
      );
      expect(off.state).toBe(MlProcessingSourceState.TurnedOff);
      const [down] = processingSourceStatuses(
        [{ ...local, lastProbeHealth: MlDestinationHealth.Unhealthy }],
        { approved: 0, ready: 0 },
        false,
      );
      expect(down.state).toBe(MlProcessingSourceState.NotAnswering);
    });

    it('asks for permission before Frameleaf Cloud can take work', () => {
      const state = (rows: MlDestinationRow[], on: boolean) =>
        processingSourceStatuses(rows, { approved: 0, ready: 0 }, on)[2].state;
      expect(state([{ ...cloud, consentAcknowledgedAt: null }], true)).toBe(MlProcessingSourceState.NeedsPermission);
      expect(state([cloud], false)).toBe(MlProcessingSourceState.TurnedOff);
      expect(state([cloud], true)).toBe(MlProcessingSourceState.Ready);
      expect(state([{ ...cloud, lastProbeHealth: MlDestinationHealth.Unhealthy }], true)).toBe(
        MlProcessingSourceState.NotAnswering,
      );
    });
  });
});
