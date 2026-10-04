import {
  BadRequestException,
  ConflictException,
  GoneException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { MediaOperationKind, MediaOperationStatus, StudioPreviewQuality } from 'src/enum.js';
import { MediaOperation, MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { StudioPreviewStreamService } from 'src/services/studio-preview-stream.service.js';
import { StudioProjectService, StudioRevisionListener } from 'src/services/studio-project.service.js';
import { StudioResourceService } from 'src/services/studio-resource.service.js';
import { STREAM_IDLE_MS, STREAM_MAX_PER_ACCOUNT } from 'src/utils/studio-preview-stream.js';
import { getMocks } from 'test/utils.js';

const OWNER = '0195e2a0-0000-7000-8000-00000000000a';
const OTHER = '0195e2a0-0000-7000-8000-00000000000b';
const PROJECT = '0195e2a0-0000-7000-8000-0000000000f1';
const PROJECT_2 = '0195e2a0-0000-7000-8000-0000000000f2';
const PROJECT_3 = '0195e2a0-0000-7000-8000-0000000000f3';

const auth = (userId = OWNER) => ({ user: { id: userId }, session: { id: 'session-1' } }) as unknown as AuthDto;

const OFFER = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'c=IN IP4 0.0.0.0',
  'a=sendonly',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  '',
].join('\r\n');
const ANSWER = OFFER.replace('a=sendonly', 'a=recvonly');

/**
 * The media operation store, as far as streams use it: the guards `mergeStreamSignal` and
 * `requestCancel` apply in SQL are applied here the same way, so races resolve like they would.
 */
class FakeOperations {
  rows = new Map<string, MediaOperation>();
  private next = 1;

  create = vi.fn((values: Record<string, unknown>) => {
    const id = `0195e2a0-0000-7000-8000-${String(this.next++).padStart(12, '0')}`;
    const row = {
      ...values,
      id,
      status: MediaOperationStatus.Queued,
      attempt: 0,
      claimToken: null,
      claimedBy: null,
      claimExpiresAt: null,
      cancelRequestedAt: null,
      errorCode: null,
      createdAt: new Date(),
    } as unknown as MediaOperation;
    this.rows.set(id, row);
    return Promise.resolve(row);
  });

  getForOwner = vi.fn((id: string, ownerId: string) => {
    const row = this.rows.get(id);
    return Promise.resolve(row && row.ownerId === ownerId ? { ...row } : undefined);
  });

  getForWorker = vi.fn((id: string) => Promise.resolve(this.rows.has(id) ? { ...this.rows.get(id)! } : undefined));

  listOpenStreams = vi.fn((ownerId: string) =>
    Promise.resolve(
      this.rows
        .values()
        .filter((row) => row.ownerId === ownerId && this.open(row) && !row.cancelRequestedAt)
        .map(({ id, projectId }) => ({ id, projectId }))
        .toArray(),
    ),
  );

  listUnfinishedForProjects = vi.fn((projectIds: string[], kinds: string[], ownerId?: string) =>
    Promise.resolve(
      this.rows
        .values()
        .filter(
          (row) =>
            projectIds.includes(row.projectId!) &&
            kinds.includes(row.kind) &&
            (ownerId === undefined || row.ownerId === ownerId) &&
            this.open(row, true),
        )
        .map(({ id, ownerId, kind, projectId }) => ({ id, ownerId, kind, projectId }))
        .toArray(),
    ),
  );

  mergeStreamSignal = vi.fn((id: string, patch: Record<string, unknown>, expect: { negotiation?: number } = {}) => {
    const row = this.rows.get(id);
    if (!row || !this.open(row, true)) {
      return Promise.resolve(undefined);
    }
    const result = (row.result ?? {}) as Record<string, unknown>;
    if (expect.negotiation !== undefined && Number(result.negotiation ?? 0) !== expect.negotiation) {
      return Promise.resolve(undefined);
    }
    row.result = { ...result, ...patch };
    return Promise.resolve({ ...row });
  });

  requestCancel = vi.fn((id: string, ownerId: string) => {
    const row = this.rows.get(id);
    if (!row || row.ownerId !== ownerId || !this.open(row, true)) {
      return Promise.resolve(undefined);
    }
    row.cancelRequestedAt = new Date() as never;
    row.status =
      row.status === MediaOperationStatus.Queued ? MediaOperationStatus.Cancelled : MediaOperationStatus.Cancelling;
    return Promise.resolve({ ...row });
  });

  /** What FL-95's claim does to the row. */
  claim(id: string, leaseMs = 90_000) {
    const row = this.rows.get(id)!;
    row.status = MediaOperationStatus.Rendering;
    row.attempt += 1;
    row.claimToken = `claim-${row.attempt}`;
    row.claimedBy = 'worker-1';
    row.claimExpiresAt = new Date(Date.now() + leaseMs) as never;
    return { ...row };
  }

  private open(row: MediaOperation, includeCancelling = false) {
    const statuses: string[] = [
      MediaOperationStatus.Queued,
      MediaOperationStatus.Preparing,
      MediaOperationStatus.Rendering,
      MediaOperationStatus.Validating,
    ];
    if (includeCancelling) {
      statuses.push(MediaOperationStatus.Cancelling);
    }
    return statuses.includes(row.status);
  }
}

describe(StudioPreviewStreamService.name, () => {
  let sut: StudioPreviewStreamService;
  let operations: FakeOperations;
  let head: number;
  let readable: boolean;
  let complete: boolean;
  let listener: StudioRevisionListener;
  let projects: {
    authorizeRevision: ReturnType<typeof vi.fn>;
    getReadableRevision: ReturnType<typeof vi.fn>;
    registerRevisionListener: ReturnType<typeof vi.fn>;
  };

  const openDto = (overrides: Record<string, unknown> = {}) => ({
    projectId: PROJECT,
    revision: 3,
    time: { numerator: '1001', denominator: '30000' },
    quality: StudioPreviewQuality.Standard,
    viewportWidth: 1280,
    viewportHeight: 720,
    ...overrides,
  });

  /** A worker holding the session: claim, then offer on the round the server names. */
  const workerOffers = async (id: string) => {
    const claimed = operations.claim(id);
    const signal = await sut.workerSignal(claimed);
    expect(signal).toMatchObject({ close: false, offerNeeded: true });
    await expect(
      sut.workerOffer(await operations.getForWorker(id).then((row) => row!), {
        claimToken: claimed.claimToken!,
        negotiation: signal.negotiation,
        sdp: OFFER,
      }),
    ).resolves.toEqual({ accepted: true });
    return claimed;
  };

  beforeEach(() => {
    operations = new FakeOperations();
    head = 3;
    readable = true;
    complete = true;
    projects = {
      authorizeRevision: vi.fn(() => {
        if (!readable) {
          return Promise.reject(new NotFoundException('Studio project not found'));
        }
        return Promise.resolve({
          revision: { revision: head },
          manifest: { complete, revision: head, digest: `digest-${head}`, refusedCount: complete ? 0 : 1 },
        });
      }),
      getReadableRevision: vi.fn(() => Promise.resolve(readable ? head : null)),
      registerRevisionListener: vi.fn((next: StudioRevisionListener) => {
        listener = next;
      }),
    };
    sut = new StudioPreviewStreamService(
      getMocks().logger as never,
      operations as unknown as MediaOperationRepository,
      projects as unknown as StudioProjectService,
      { cacheKey: vi.fn().mockReturnValue('cache-key') } as unknown as StudioResourceService,
    );
  });

  describe('open', () => {
    it('opens a queued session bound to the stored head, with bounds by quality and viewport', async () => {
      const stream = await sut.open(auth(), openDto());

      expect(stream).toMatchObject({
        projectId: PROJECT,
        revision: 3,
        state: 'queued',
        negotiation: 0,
        offer: null,
        start: { numerator: '1001', denominator: '30000' },
        bounds: { maxBitrateKbps: 6000, maxWidth: 1280, maxHeight: 720, maxFrameRate: 30 },
      });
      expect(operations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId: OWNER,
          kind: MediaOperationKind.StudioPreviewStream,
          projectId: PROJECT,
          revisionId: 'digest-3',
          maxAttempts: 1,
          // The worker resolves the stored revision itself; no graph travels.
          snapshot: expect.objectContaining({
            projectRevision: 3,
            studio: { stored: true, revision: 3, cloudConsent: false },
          }),
        }),
      );
    });

    it('refuses a superseded revision with the current one', async () => {
      await expect(sut.open(auth(), openDto({ revision: 2 }))).rejects.toMatchObject({
        response: { code: 'studio_preview_stale_revision', currentRevision: 3 },
      });
      expect(operations.create).not.toHaveBeenCalled();
    });

    it('refuses when a source is not available to the caller', async () => {
      complete = false;
      await expect(sut.open(auth(), openDto())).rejects.toMatchObject({
        response: { code: 'studio_preview_sources_refused' },
      });
    });

    it('refuses a project the caller cannot read', async () => {
      readable = false;
      await expect(sut.open(auth(), openDto())).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses a start that is not an exact non-negative time', async () => {
      await expect(sut.open(auth(), openDto({ time: { numerator: '-1', denominator: '30' } }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('supersedes the same project and limits sessions per account', async () => {
      const first = await sut.open(auth(), openDto());
      const second = await sut.open(auth(), openDto());
      expect(await sut.get(auth(), first.id)).toMatchObject({ state: 'closed', closeReason: 'superseded' });
      expect(second.state).toBe('queued');

      await sut.open(auth(), openDto({ projectId: PROJECT_2 }));
      expect(STREAM_MAX_PER_ACCOUNT).toBe(2);
      const refused = sut.open(auth(), openDto({ projectId: PROJECT_3 }));
      await expect(refused).rejects.toBeInstanceOf(HttpException);
      await expect(refused).rejects.toMatchObject({ status: 429 });
    });
  });

  describe('signalling', () => {
    it.each([
      { shape: 'missing', sdp: ANSWER.split('m=application', 1)[0], direction: 'recvonly' },
      { shape: 'missing', sdp: ANSWER.split('m=application', 1)[0], direction: 'inactive' },
      {
        shape: 'duplicate',
        sdp: `${ANSWER}m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`,
        direction: 'recvonly',
      },
      {
        shape: 'duplicate',
        sdp: `${ANSWER}m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`,
        direction: 'inactive',
      },
    ])('refuses $shape control atomically before a valid $direction answer', async (test) => {
      const { id } = await sut.open(auth(), openDto());
      await workerOffers(id);
      const before = structuredClone(operations.rows.get(id)!);
      operations.mergeStreamSignal.mockClear();

      await expect(
        sut.answer(auth(), id, {
          negotiation: 0,
          sdp: test.sdp.replace('a=recvonly', () => `a=${test.direction}`),
        }),
      ).rejects.toMatchObject({ status: 400, response: { code: 'studio_preview_stream_invalid_answer' } });

      expect(operations.mergeStreamSignal).not.toHaveBeenCalled();
      expect(operations.rows.get(id)).toEqual(before);

      const answered = await sut.answer(auth(), id, {
        negotiation: 0,
        sdp: ANSWER.replace('a=recvonly', () => `a=${test.direction}`),
      });
      expect(answered).toMatchObject({ state: 'answered', negotiation: 0, offer: null });
      expect(operations.mergeStreamSignal).toHaveBeenCalledTimes(1);
      const signal = await sut.workerSignal((await operations.getForWorker(id))!);
      expect(signal).toMatchObject({ close: false, offerNeeded: false, negotiation: 0 });
      expect(signal.answer).toContain('b=AS:6000');
      expect(signal.answer).toContain('b=TIAS:6000000');
      expect(signal.answer).toContain(`a=${test.direction}`);
      expect(signal.answer).toContain('m=application 9 UDP/DTLS/SCTP webrtc-datachannel');
    });

    it('relays one offer and one answer per negotiation, with the bitrate bound written in', async () => {
      const { id } = await sut.open(auth(), openDto());
      const claimed = await workerOffers(id);

      const offered = await sut.get(auth(), id);
      expect(offered).toMatchObject({ state: 'offered', negotiation: 0, offer: OFFER });

      const answered = await sut.answer(auth(), id, { negotiation: 0, sdp: ANSWER });
      expect(answered.state).toBe('answered');
      expect(answered.offer).toBeNull();

      const signal = await sut.workerSignal((await operations.getForWorker(id))!);
      expect(signal).toMatchObject({ close: false, offerNeeded: false, negotiation: 0 });
      expect(signal.answer).toContain('b=AS:6000');
      expect(signal.answer).toContain('b=TIAS:6000000');

      // A second offer for the same round from the same claim is not accepted.
      await expect(
        sut.workerOffer((await operations.getForWorker(id))!, {
          claimToken: claimed.claimToken!,
          negotiation: 0,
          sdp: OFFER,
        }),
      ).resolves.toEqual({ accepted: false });
    });

    it('refuses an answer to a round that is not waiting, and descriptions of the wrong shape', async () => {
      const { id } = await sut.open(auth(), openDto());
      await expect(sut.answer(auth(), id, { negotiation: 0, sdp: ANSWER })).rejects.toBeInstanceOf(ConflictException);

      await workerOffers(id);
      await expect(sut.answer(auth(), id, { negotiation: 1, sdp: ANSWER })).rejects.toBeInstanceOf(ConflictException);
      await expect(sut.answer(auth(), id, { negotiation: 0, sdp: OFFER })).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        sut.workerOffer((await operations.getForWorker(id))!, {
          claimToken: 'claim-1',
          negotiation: 0,
          sdp: OFFER.replace('a=sendonly', 'a=sendrecv'),
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("hides another account's session", async () => {
      const { id } = await sut.open(auth(), openDto());
      await expect(sut.get(auth(OTHER), id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(sut.closeOwned(auth(OTHER), id)).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('keepalive and bounds', () => {
    it('closes a session whose browser stopped polling, and tells the worker to stop', async () => {
      const { id } = await sut.open(auth(), openDto());
      await workerOffers(id);
      const row = operations.rows.get(id)!;
      row.result = {
        ...(row.result as object),
        keepaliveAt: new Date(Date.now() - STREAM_IDLE_MS - 1000).toISOString(),
      };

      const signal = await sut.workerSignal((await operations.getForWorker(id))!);
      expect(signal).toMatchObject({ close: true, closeReason: 'expired' });
      expect(operations.rows.get(id)!.status).toBe(MediaOperationStatus.Cancelling);
    });
  });

  describe('revocation', () => {
    it('closes on a lost project read at the next poll, and the worker is told to stop', async () => {
      const { id } = await sut.open(auth(), openDto());
      await workerOffers(id);
      readable = false;

      await expect(sut.get(auth(), id)).rejects.toBeInstanceOf(NotFoundException);
      const signal = await sut.workerSignal((await operations.getForWorker(id))!);
      expect(signal).toMatchObject({ close: true, closeReason: 'revoked', answer: null });
    });

    it('stops every open stream of a revoked project, for the named account only when one is named', async () => {
      const mine = await sut.open(auth(), openDto());
      const theirs = await sut.open(auth(OTHER), openDto());
      await workerOffers(mine.id);

      await expect(sut.revokeForProjects([PROJECT], OTHER)).resolves.toBe(1);
      expect(await sut.get(auth(OTHER), theirs.id)).toMatchObject({ state: 'closed', closeReason: 'revoked' });
      expect((await sut.get(auth(), mine.id)).state).toBe('offered');

      await expect(sut.revokeForProjects([PROJECT])).resolves.toBe(1);
      expect(await sut.get(auth(), mine.id)).toMatchObject({ state: 'closed', closeReason: 'revoked' });
    });

    it('closes streams of earlier revisions when a new one is stored', async () => {
      const { id } = await sut.open(auth(), openDto());
      head = 4;
      await listener({ projectId: PROJECT, revision: 4, ownerId: OWNER, digest: 'd', restoredFromRevision: null });
      expect(await sut.get(auth(), id)).toMatchObject({ state: 'closed', closeReason: 'stale-revision' });
    });

    it('closes as stale when a poll finds a newer head, and reports it', async () => {
      const { id } = await sut.open(auth(), openDto());
      head = 5;
      expect(await sut.get(auth(), id)).toMatchObject({
        state: 'closed',
        closeReason: 'stale-revision',
        currentRevision: 5,
      });
    });
  });

  describe('reconnect', () => {
    it('starts the next negotiation once access, revision, sources and lease check out', async () => {
      const { id } = await sut.open(auth(), openDto());
      await workerOffers(id);
      await sut.answer(auth(), id, { negotiation: 0, sdp: ANSWER });

      const reconnected = await sut.reconnect(auth(), id);
      expect(reconnected).toMatchObject({ state: 'negotiating', negotiation: 1, offer: null });
      // Re-authorised, not remembered.
      expect(projects.authorizeRevision).toHaveBeenCalledTimes(2);

      const signal = await sut.workerSignal((await operations.getForWorker(id))!);
      expect(signal).toMatchObject({ offerNeeded: true, negotiation: 1, answer: null });
    });

    it('closes instead of resuming when a source was revoked meanwhile', async () => {
      const { id } = await sut.open(auth(), openDto());
      await workerOffers(id);
      complete = false;
      await expect(sut.reconnect(auth(), id)).rejects.toMatchObject({
        response: { code: 'studio_preview_sources_refused' },
      });
      expect(await sut.get(auth(), id)).toMatchObject({ state: 'closed', closeReason: 'revoked' });
    });

    it('closes instead of resuming when access or the revision moved', async () => {
      const first = await sut.open(auth(), openDto());
      await workerOffers(first.id);
      head = 4;
      await expect(sut.reconnect(auth(), first.id)).rejects.toMatchObject({
        response: { code: 'studio_preview_stale_revision', currentRevision: 4 },
      });

      const second = await sut.open(auth(), openDto({ revision: 4 }));
      await workerOffers(second.id);
      readable = false;
      await expect(sut.reconnect(auth(), second.id)).rejects.toBeInstanceOf(NotFoundException);
      readable = true;
      expect(await sut.get(auth(), second.id)).toMatchObject({ state: 'closed', closeReason: 'revoked' });
    });

    it('closes as worker-lost when the lease lapsed', async () => {
      const { id } = await sut.open(auth(), openDto());
      await workerOffers(id);
      operations.rows.get(id)!.claimExpiresAt = new Date(Date.now() - 1000) as never;

      await expect(sut.reconnect(auth(), id)).rejects.toMatchObject({
        response: { code: 'studio_preview_stream_worker_lost' },
      });
      expect(await sut.get(auth(), id)).toMatchObject({ state: 'closed', closeReason: 'worker-lost' });
    });

    it('refuses a closed session with gone', async () => {
      const { id } = await sut.open(auth(), openDto());
      await sut.closeOwned(auth(), id);
      await expect(sut.reconnect(auth(), id)).rejects.toBeInstanceOf(GoneException);
    });

    it('makes a worker that took the session over offer afresh', async () => {
      const { id } = await sut.open(auth(), openDto());
      await workerOffers(id);
      // Recovery put it back and a second claim took it (attempt 2).
      operations.claim(id);
      const signal = await sut.workerSignal((await operations.getForWorker(id))!);
      expect(signal).toMatchObject({ offerNeeded: true, negotiation: 1, answer: null });
    });
  });

  describe('close', () => {
    it('ends an unclaimed session at once and a claimed one through its worker', async () => {
      const queued = await sut.open(auth(), openDto());
      expect(await sut.closeOwned(auth(), queued.id)).toMatchObject({ state: 'closed', closeReason: 'closed' });
      expect(operations.rows.get(queued.id)!.status).toBe(MediaOperationStatus.Cancelled);

      const playing = await sut.open(auth(), openDto());
      await workerOffers(playing.id);
      await sut.closeOwned(auth(), playing.id);
      expect(operations.rows.get(playing.id)!.status).toBe(MediaOperationStatus.Cancelling);
      await expect(sut.workerSignal((await operations.getForWorker(playing.id))!)).resolves.toMatchObject({
        close: true,
        closeReason: 'closed',
      });
    });
  });
});
