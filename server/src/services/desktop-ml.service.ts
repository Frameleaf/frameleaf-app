import { Injectable } from '@nestjs/common';
import { type Transaction, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import z from 'zod';
import type { DB } from 'src/schema/index.js';
import type { DesktopModelProfile } from 'src/utils/desktop-model-catalogue.js';
import { OnEvent } from 'src/decorators.js';
import { MlDestinationKind, MlWorkload, QueueName } from 'src/enum.js';
import { afterJobCommit, deferJobAdoption, jobSignal, queueExecution } from 'src/queue/context.js';
import { deferJobUntilDependency } from 'src/queue/dependency.js';
import { setDesktopQueueCapacity } from 'src/queue/store.js';
import { QUEUE_TIMING } from 'src/queue/types.js';
import {
  type DesktopClipIndexBinding,
  DesktopClipIndexRepository,
} from 'src/repositories/desktop-clip-index.repository.js';
import {
  DesktopMlRepository,
  DesktopMlRequest,
  type DesktopWorkerGrant,
} from 'src/repositories/desktop-ml.repository.js';
import {
  type DesktopPoolOptions,
  MachineLearningRepository,
  type MlSelection,
  type ModelPayload,
} from 'src/repositories/machine-learning.repository.js';
import { workerMetrics } from 'src/repositories/metrics.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { DesktopAssistancePolicyService } from 'src/services/desktop-assistance-policy.service.js';
import { assertAssetSource } from 'src/utils/asset-source-authority.js';
import { parseBoundClipResult } from 'src/utils/clip-embedding.js';
import { desktopAuthorityFor, householdDevices } from 'src/utils/desktop-assistance-policy.js';
import { desktopFaceProfile, faceEntries } from 'src/utils/desktop-face.js';
import {
  type DesktopMlDisclosure,
  desktopEndpointDigest,
  desktopMlDisclosureSchema,
} from 'src/utils/desktop-ml-disclosure.js';
import { desktopOcrProfile, ocrEntries } from 'src/utils/desktop-ocr.js';
import { DATABASE_ACQUIRE_TIMEOUT_MS } from 'src/utils/execution-database.js';
import { parseBoundFaceResult } from 'src/utils/face-result.js';
import { isLockedPath, readPlainFile } from 'src/utils/locked-read.js';
import { resolveEndpoint } from 'src/utils/ml-destination.js';
import { canonicalJson } from 'src/utils/object.js';
import { parseBoundOcrResult } from 'src/utils/ocr-result.js';

/** The queues desktops can work, in the order a free desktop is counted for them, and the work each does. */
const QUEUE_WORKLOADS: ReadonlyArray<[string, MlWorkload]> = [
  [QueueName.SmartSearch, MlWorkload.Clip],
  [QueueName.FaceDetection, MlWorkload.Face],
  [QueueName.Ocr, MlWorkload.Ocr],
];
const CAPACITY_FRESH_MS = 2000;

@Injectable()
export class DesktopMlService {
  private capacity?: { at: number; value: Promise<Record<string, number>> };

  constructor(
    private repository: DesktopMlRepository,
    private index: DesktopClipIndexRepository,
    private policies?: DesktopAssistancePolicyService,
    private routes?: MlDestinationRepository,
    private machineLearning?: MachineLearningRepository,
  ) {}

  @OnEvent({ name: 'AppBootstrap' })
  onBootstrap() {
    if (!this.machineLearning) throw new Error('desktop_pool_authority_unavailable');
    this.machineLearning.setDesktopPoolSelector(this.selectBackgroundPool.bind(this));
    setDesktopQueueCapacity(this.queueCapacity.bind(this));
  }

  @OnEvent({ name: 'AppShutdown' })
  onShutdown() {
    this.machineLearning?.setDesktopPoolSelector(null);
    setDesktopQueueCapacity(null);
  }

  /**
   * How many extra jobs `queue` may start for desktops now, on top of the administrator's concurrency.
   * A queue gets none unless its work would go to desktops first (the first place in its processing order
   * that is available now is the desktops), so with this server first and its AI answering, this server's
   * AI never runs more jobs than the administrator set. Read at most every two seconds for all queues.
   */
  async queueCapacity(queue: string): Promise<number> {
    const now = performance.now();
    if (!this.capacity || now - this.capacity.at > CAPACITY_FRESH_MS)
      this.capacity = { at: now, value: this.countCapacity() };
    return (await this.capacity.value)[queue] ?? 0;
  }

  private async countCapacity(): Promise<Record<string, number>> {
    if (!this.routes || !this.machineLearning) return {};
    const plans = await this.routes.resolveRoutes(QUEUE_WORKLOADS.map(([, workload]) => workload));
    const scopes: Record<string, string[]> = {};
    for (const [queue, workload] of QUEUE_WORKLOADS) {
      const first = plans.get(workload)?.find((candidate) => candidate.available);
      scopes[queue] = first?.desktopPool ? await this.machineLearning.desktopModelKeys(workload) : [];
    }
    return this.repository.helperCapacity(scopes);
  }

  async selectBackgroundPool(selection: MlSelection, options: DesktopPoolOptions): Promise<MlSelection> {
    if (options.guestOwnerId !== undefined) return this.selectGuestFacePool(selection, options);
    const context = queueExecution.getStore();
    if (
      !context ||
      ![MlWorkload.Clip, MlWorkload.Ocr, MlWorkload.Face].includes(selection.workload) ||
      ![MlDestinationKind.Local, MlDestinationKind.Lan].includes(selection.kind) ||
      selection.endpoint.cloud
    )
      return selection;
    if (!this.policies || !this.routes) throw new Error('desktop_pool_authority_unavailable');
    // A desktop stands in for any home destination the work was admitted to, whichever route sent it there.
    const policy = await this.policies.snapshot();
    const sources = context.sourceAuthorities;
    const source = options.jobId
      ? sources?.get(options.jobId)
      : sources?.size === 1
        ? sources.values().next().value
        : undefined;
    // Whose photo this is cannot be told (no source was recorded for the job, or several were and the job did
    // not say which): no desktop may be chosen for it, so the destination itself does the work. It must not
    // wait: nothing that would settle the owner is coming.
    if (!source) return selection;
    const ownerId = source.ownerId;
    // FL-1484: the owner's own desktop assistance, else a computer that works on everyone's photos at home
    const account = desktopAuthorityFor(policy, ownerId);
    if (!account) return selection;
    // A household computer never takes another account's Locked photo, so such a photo is not offered to one:
    // without the owner's own desktop assistance it stays on this server, and readiness counts only their computers.
    const locked = householdDevices(policy).size > 0 && (await this.repository.isLockedAsset(source.snapshot.assetId));
    if (locked && !policy.accounts[ownerId]) return selection;
    const ready = (modelKey: string) =>
      !options.requireReady || this.repository.hasReadyWorker(ownerId, modelKey, { household: !locked });
    const assertAuthority = async (tx?: Transaction<DB>) => {
      await this.policies!.assertCurrent(ownerId, account.revisionId, tx);
      await this.routes!.assertDesktopDestination(selection, tx, selection.workload);
      await options.assertConfig(tx);
      await source.assertCurrent(tx);
    };
    await assertAuthority();
    if (selection.workload === MlWorkload.Face) {
      if (!options.face) throw new Error('desktop_pool_model_unavailable');
      let profile: DesktopModelProfile;
      try {
        profile = desktopFaceProfile(options.face);
      } catch {
        // These settings have no desktop profile (a slider moved off its default): no desktop can run the job,
        // so the destination itself does. It must not wait for settings no desktop will ever be offered.
        return selection;
      }
      if (!(await ready(profile.modelKey))) return selection;
      return this.selectImagePool(selection, {
        ownerId,
        profile,
        assertAuthority,
        disclosure: {
          version: 3,
          workload: 'face',
          source: source.snapshot,
          policyRevision: account.revisionId,
          destinationId: selection.destinationId,
          kind: selection.kind as MlDestinationKind.Local | MlDestinationKind.Lan,
          endpointSha256: desktopEndpointDigest(selection.endpoint),
          modelName: options.modelName,
          modelKey: profile.modelKey,
          face: structuredClone(options.face),
          job: { id: context.claim.id, token: context.claim.token },
        },
      });
    }
    if (selection.workload === MlWorkload.Ocr) {
      if (!options.ocr) throw new Error('desktop_pool_model_unavailable');
      let profile: DesktopModelProfile;
      try {
        profile = desktopOcrProfile(options.ocr);
      } catch {
        // These settings have no desktop profile (a slider moved off its default): no desktop can run the job,
        // so the destination itself does. It must not wait for settings no desktop will ever be offered.
        return selection;
      }
      if (!(await ready(profile.modelKey))) return selection;
      return this.selectOcrPool(selection, {
        ownerId,
        profile,
        assertAuthority,
        disclosure: {
          version: 2,
          workload: 'ocr',
          source: source.snapshot,
          policyRevision: account.revisionId,
          destinationId: selection.destinationId,
          kind: selection.kind as MlDestinationKind.Local | MlDestinationKind.Lan,
          endpointSha256: desktopEndpointDigest(selection.endpoint),
          modelName: options.modelName,
          modelKey: profile.modelKey,
          ocr: structuredClone(options.ocr),
          job: { id: context.claim.id, token: context.claim.token },
        },
      });
    }
    const selected = await this.index.selectProfile(options.modelName, 'image');
    // No desktop has been granted smart search yet, so none can take this job: the destination itself does.
    if (!selected) return selection;
    if (!(await ready(selected.binding.space.visualModelKey))) return selection;
    return this.selectClipPool(selection, {
      ownerId,
      authorityKey: account.revisionId,
      binding: selected.binding,
      disclosure: {
        version: 1,
        source: source.snapshot,
        policyRevision: account.revisionId,
        destinationId: selection.destinationId,
        kind: selection.kind as MlDestinationKind.Local | MlDestinationKind.Lan,
        endpointSha256: desktopEndpointDigest(selection.endpoint),
        modelName: options.modelName,
        indexRevision: selected.binding.revisionId,
        spaceKey: selected.binding.space.spaceKey,
        job: { id: context.claim.id, token: context.claim.token },
      },
      assertAuthority,
    });
  }

  /**
   * FL-1058: a gallery guest's selfie goes to the photographer's own Frameleaf Desktop helpers (never a
   * household computer) when the Face route sends work there. The waiting request owns the task: it is
   * discarded with the result, and no queued job or library photo stands behind it.
   */
  private async selectGuestFacePool(selection: MlSelection, options: DesktopPoolOptions): Promise<MlSelection> {
    if (
      selection.workload !== MlWorkload.Face ||
      ![MlDestinationKind.Local, MlDestinationKind.Lan].includes(selection.kind) ||
      selection.endpoint.cloud ||
      !options.face
    )
      return selection;
    if (!this.policies || !this.routes) throw new Error('desktop_pool_authority_unavailable');
    const ownerId = z.uuid().parse(options.guestOwnerId);
    const account = (await this.policies.snapshot()).accounts[ownerId];
    if (!account) return selection;
    let profile: DesktopModelProfile;
    try {
      profile = desktopFaceProfile(options.face);
    } catch {
      return selection;
    }
    if (
      options.requireReady &&
      !(await this.repository.hasReadyWorker(ownerId, profile.modelKey, { household: false }))
    )
      return selection;
    const endpoint = Object.freeze({ ...selection.endpoint });
    const disclosure: DesktopMlDisclosure = {
      version: 4,
      workload: 'guest-face',
      policyRevision: account.revisionId,
      destinationId: selection.destinationId,
      kind: selection.kind as MlDestinationKind.Local | MlDestinationKind.Lan,
      endpointSha256: desktopEndpointDigest(endpoint),
      modelName: options.modelName,
      modelKey: profile.modelKey,
      face: structuredClone(options.face),
    };
    const assertAuthority = async (tx?: Transaction<DB>) => {
      await this.policies!.assertCurrent(ownerId, account.revisionId, tx);
      await this.routes!.assertDesktopDestination(selection, tx, MlWorkload.Face);
      await options.assertConfig(tx);
      await endpoint.assertAuthority?.();
    };
    await assertAuthority();
    return Object.freeze({
      ...selection,
      endpoint,
      desktopFace: async (payload: ModelPayload, entries: unknown) => {
        if (!('imagePath' in payload) || canonicalJson(entries) !== canonicalJson(profile.spec.entries))
          throw new Error('desktop_pool_profile_changed');
        await assertAuthority();
        return this.dispatch({
          request: {
            ownerId,
            // Unique per search: a guest task never matches another search's result.
            authorityKey: randomUUID(),
            disclosure,
            modelKey: profile.modelKey,
            config: profile.spec.entries,
            input: await readClipInput(payload),
            inputKind: 'image',
            deadlineAt: new Date(Date.now() + 25_000),
          },
          assertAuthority,
          decodeResult: parseBoundFaceResult,
          forget: true,
        });
      },
    });
  }

  selectClipPool(
    selection: MlSelection,
    options: {
      ownerId: string;
      authorityKey: string;
      binding: DesktopClipIndexBinding;
      disclosure?: DesktopMlDisclosure;
      assertAuthority: (tx?: Transaction<DB>) => Promise<void>;
    },
  ): MlSelection {
    const context = queueExecution.getStore();
    if (!context) throw new Error('desktop_pool_queue_required');
    if (
      selection.workload !== MlWorkload.Clip ||
      ![MlDestinationKind.Local, MlDestinationKind.Lan].includes(selection.kind) ||
      selection.endpoint.cloud ||
      selection.desktopClip ||
      typeof selection.endpoint.assertAuthority !== 'function'
    )
      throw new Error('desktop_pool_selection_invalid');
    const ownerId = z.uuid().parse(options.ownerId);
    const policy = z.string().min(1).max(256).parse(options.authorityKey);
    const binding = structuredClone(options.binding);
    const disclosure = options.disclosure ? structuredClone(options.disclosure) : undefined;
    const authorize = options.assertAuthority;
    const endpoint = Object.freeze({ ...selection.endpoint });
    const claim = {
      id: context.claim.id,
      token: context.claim.token,
      deadlineAt: context.claim.startedAt.getTime() + context.claim.deadlineMs,
    };
    const assertClaim = () => {
      context.signal.throwIfAborted();
      if (context.claim.id !== claim.id || context.claim.token !== claim.token)
        throw new Error('desktop_pool_queue_changed');
    };
    const authorityKey = createHash('sha256')
      .update(
        canonicalJson({
          policy,
          ownerId,
          destinationId: selection.destinationId,
          binding,
          claim,
          disclosure: disclosure ?? null,
        }),
      )
      .digest('hex');
    const assertAuthority = async (tx?: Transaction<DB>) => {
      assertClaim();
      await authorize(tx);
      await this.index.assertCurrent(binding, tx);
      await endpoint.assertAuthority!();
      assertClaim();
    };
    return Object.freeze({
      ...selection,
      endpoint,
      desktopClip: async (payload, profile) => {
        if (queueExecution.getStore() !== context) throw new Error('desktop_pool_queue_changed');
        if (![binding.space.visualModelKey, ...binding.space.textModelKeys].includes(profile.modelKey))
          throw new Error('desktop_pool_profile_changed');
        await assertAuthority();
        const input = await readClipInput(payload);
        return this.dispatch({
          request: {
            ownerId,
            authorityKey,
            disclosure,
            modelKey: profile.modelKey,
            config: profile.spec.entries,
            input,
            inputKind: profile.spec.fixtureKind,
            deadlineAt: new Date(
              Math.min(claim.deadlineAt, Date.now() + Math.min(600, profile.spec.deadlineSeconds) * 1000),
            ),
          },
          assertAuthority,
          decodeResult: (value) => {
            parseBoundClipResult(value, profile);
            return structuredClone(value);
          },
          signal: context.signal,
        });
      },
    });
  }

  private selectOcrPool(
    selection: MlSelection,
    options: {
      ownerId: string;
      profile: DesktopModelProfile;
      disclosure: DesktopMlDisclosure;
      assertAuthority: (tx?: Transaction<DB>) => Promise<void>;
    },
  ): MlSelection {
    return this.selectImagePool(selection, options);
  }

  private selectImagePool(
    selection: MlSelection,
    options: {
      ownerId: string;
      profile: DesktopModelProfile;
      disclosure: DesktopMlDisclosure;
      assertAuthority: (tx?: Transaction<DB>) => Promise<void>;
    },
  ): MlSelection {
    const context = queueExecution.getStore();
    if (
      !context ||
      selection.desktopFace ||
      selection.desktopOcr ||
      selection.desktopClip ||
      typeof selection.endpoint.assertAuthority !== 'function'
    )
      throw new Error('desktop_pool_selection_invalid');
    const ownerId = z.uuid().parse(options.ownerId);
    const profile = structuredClone(options.profile);
    const disclosure = structuredClone(options.disclosure);
    const endpoint = Object.freeze({ ...selection.endpoint });
    const claim = {
      id: context.claim.id,
      token: context.claim.token,
      deadlineAt: context.claim.startedAt.getTime() + context.claim.deadlineMs,
    };
    const authorityKey = createHash('sha256')
      .update(canonicalJson({ ownerId, profile: profile.modelKey, disclosure, claim }))
      .digest('hex');
    const assertAuthority = async (tx?: Transaction<DB>) => {
      context.signal.throwIfAborted();
      if (context.claim.id !== claim.id || context.claim.token !== claim.token)
        throw new Error('desktop_pool_queue_changed');
      await options.assertAuthority(tx);
      await endpoint.assertAuthority!();
      context.signal.throwIfAborted();
    };
    return Object.freeze({
      ...selection,
      endpoint,
      [profile.workload === 'face' ? 'desktopFace' : 'desktopOcr']: async (payload: ModelPayload, entries: unknown) => {
        if (
          queueExecution.getStore() !== context ||
          !('imagePath' in payload) ||
          canonicalJson(entries) !== canonicalJson(profile.spec.entries)
        )
          throw new Error('desktop_pool_profile_changed');
        await assertAuthority();
        const input = await readClipInput(payload);
        return this.dispatch({
          request: {
            ownerId,
            authorityKey,
            disclosure,
            modelKey: profile.modelKey,
            config: profile.spec.entries,
            input,
            inputKind: 'image',
            deadlineAt: new Date(
              Math.min(claim.deadlineAt, Date.now() + Math.min(600, profile.spec.deadlineSeconds) * 1000),
            ),
          },
          assertAuthority,
          decodeResult: (value) =>
            profile.workload === 'face' ? parseBoundFaceResult(value) : parseBoundOcrResult(value),
          signal: context.signal,
        });
      },
    });
  }

  input(grant: DesktopWorkerGrant, attemptId: string): Promise<Buffer | undefined> {
    return this.repository.input(grant, attemptId, async (task, tx) => {
      const parsed = desktopMlDisclosureSchema.safeParse(task.disclosure);
      if (!parsed.success) throw new Error('desktop_input_authority_invalid');
      const authority = parsed.data;
      if (authority.version !== 4 && task.ownerId !== authority.source.ownerId)
        throw new Error('desktop_input_owner_changed');
      if (!this.policies || !this.machineLearning) throw new Error('desktop_input_authority_unavailable');
      await this.policies.assertCurrent(task.ownerId, authority.policyRevision, tx);
      const routes = new MlDestinationRepository(tx);
      const destination = await routes.getById(authority.destinationId);
      const endpoint = destination && resolveEndpoint(destination);
      if (
        !destination ||
        destination.kind !== authority.kind ||
        !endpoint ||
        desktopEndpointDigest(endpoint) !== authority.endpointSha256
      )
        throw new Error('desktop_pool_destination_changed');
      const selection = { destinationId: destination.id, kind: destination.kind, endpoint };
      await routes.assertRecoveryAuthority(destination);
      if (authority.version === 4 || authority.version === 3) {
        await routes.assertDesktopDestination(selection, tx, MlWorkload.Face);
        const profile = desktopFaceProfile(authority.face, authority.modelKey);
        if (
          task.modelKey !== authority.modelKey ||
          profile.modelKey !== task.modelKey ||
          authority.modelName !== authority.face.modelName ||
          canonicalJson(task.config) !== canonicalJson(faceEntries(authority.face))
        )
          throw new Error('desktop_pool_profile_changed');
        await this.machineLearning.assertDesktopFaceConfig(selection, profile.spec.entries, tx, authority.face);
        // FL-1058: a guest selfie has no library photo or queued job; its request discards the task when done.
        if (authority.version === 4) return;
      } else if (authority.version === 2) {
        await routes.assertDesktopDestination(selection, tx, MlWorkload.Ocr);
        const profile = desktopOcrProfile(authority.ocr, authority.modelKey);
        if (
          task.modelKey !== authority.modelKey ||
          profile.modelKey !== task.modelKey ||
          authority.modelName !== authority.ocr.modelName ||
          canonicalJson(task.config) !== canonicalJson(ocrEntries(authority.ocr))
        )
          throw new Error('desktop_pool_profile_changed');
        await this.machineLearning.assertDesktopOcrConfig(selection, profile.spec.entries, tx, authority.ocr);
      } else {
        await routes.assertDesktopDestination(selection, tx);
        await this.machineLearning.assertDesktopPoolConfig(selection, authority.modelName, tx);
        const binding = await this.index.getActive(tx);
        if (
          !binding ||
          binding.revisionId !== authority.indexRevision ||
          binding.space.spaceKey !== authority.spaceKey ||
          ![binding.space.visualModelKey, ...binding.space.textModelKeys].includes(task.modelKey)
        )
          throw new Error('desktop_clip_index_changed');
      }
      await assertAssetSource(tx, authority.source);
      const { rows } = await sql`SELECT id FROM job WHERE id=${authority.job.id}::uuid
        AND token=${authority.job.token}::uuid AND state='active' AND "cancelRequestedAt" IS NULL
        AND "leaseExpiresAt">clock_timestamp()`.execute(tx);
      if (rows.length !== 1) throw new Error('desktop_pool_queue_changed');
    });
  }

  async dispatch<T>(options: {
    request: DesktopMlRequest;
    assertAuthority: (tx?: Transaction<DB>) => Promise<void>;
    decodeResult: (value: unknown) => T;
    signal?: AbortSignal;
    /** Delete the task outright when done, keeping no consumed row. */
    forget?: boolean;
  }): Promise<T> {
    const remaining = options.request.deadlineAt.getTime() - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 600_000)
      throw new Error('desktop_deadline_invalid');
    const context = queueExecution.getStore();
    const canDefer = !!context && !context.claim.data.operationId;
    // Leave the live NAS claim time to cancel private work, discard it and persist its dependency wait.
    const cleanupReserve = 3 * DATABASE_ACQUIRE_TIMEOUT_MS;
    if (canDefer && remaining <= cleanupReserve) {
      deferJobUntilDependency('destination-unavailable');
      throw new Error('desktop_helper_unavailable');
    }
    // How long a task may sit with no desktop holding it before the job stops waiting on desktops.
    const unclaimedWindow = Math.max(0, Math.min(QUEUE_TIMING.scan, remaining - cleanupReserve));
    let unclaimed = { generation: 0, since: performance.now() };
    const parent = jobSignal();
    const signal = AbortSignal.any([
      AbortSignal.timeout(remaining),
      ...(parent ? [parent] : []),
      ...(options.signal ? [options.signal] : []),
    ]);
    signal.throwIfAborted();
    await options.assertAuthority();
    signal.throwIfAborted();
    let task: Awaited<ReturnType<DesktopMlRepository['create']>>;
    try {
      task = await this.repository.create(options.request);
    } catch (error) {
      if (canDefer && error instanceof Error && error.message === 'desktop_broker_busy')
        deferJobUntilDependency('destination-unavailable');
      throw error;
    }
    let deferred = false;
    try {
      while (true) {
        signal.throwIfAborted();
        const row = await this.repository.result(task.id);
        signal.throwIfAborted();
        if (!row || row.state === 'cancelled') throw new Error('desktop_inference_cancelled');
        if (row.state === 'failed') throw new Error('desktop_inference_failed');
        if (canDefer && row.state === 'running') {
          const live = await this.repository.hasLiveAttempt(task.id);
          signal.throwIfAborted();
          if (!live) {
            deferJobUntilDependency('destination-unavailable');
            throw new Error('desktop_helper_unavailable');
          }
        }
        // Nobody took it, or the desktop that had it handed it back (paused, stopped) or failed it, and
        // nobody has taken it since: the job goes back to its processing order instead of waiting here.
        if (canDefer && row.state === 'pending') {
          if (row.generation !== unclaimed.generation)
            unclaimed = { generation: row.generation, since: performance.now() };
          if (performance.now() - unclaimed.since >= unclaimedWindow) {
            deferJobUntilDependency('destination-unavailable');
            throw new Error('desktop_helper_unavailable');
          }
        }
        if (row.state === 'completed') {
          if (row.authorityKey !== options.request.authorityKey || row.modelKey !== options.request.modelKey)
            throw new Error('desktop_result_identity_changed');
          const result = options.decodeResult(row.result);
          await options.assertAuthority();
          signal.throwIfAborted();
          deferred = deferJobAdoption(async (tx) => {
            signal.throwIfAborted();
            await options.assertAuthority(tx);
            signal.throwIfAborted();
            await this.repository.assertAdoption(task.id, task, tx);
          });
          if (deferred) {
            await afterJobCommit(() => {
              workerMetrics?.observeDesktopResultAdoption();
              return this.repository.discard(task.id);
            });
          } else {
            await this.repository.assertAdoption(task.id, task);
          }
          signal.throwIfAborted();
          return result;
        }
        await setTimeout(1000, undefined, { signal });
      }
    } finally {
      // No cleanup uses the cancelled parent signal: fencing the worker must still finish.
      if (!deferred) {
        await this.repository.cancel(task.id);
        await (options.forget ? this.repository.discard(task.id, true) : this.repository.discard(task.id));
      }
    }
  }
}

async function readClipInput(payload: ModelPayload): Promise<Buffer> {
  const limit = 16 * 1024 * 1024;
  if ('text' in payload) {
    const size = Buffer.byteLength(payload.text);
    if (!size || size > limit) throw new Error('desktop_input_size_invalid');
    return Buffer.from(payload.text);
  }
  // FL-721 (spec §8.2): a sealed image is decrypted in memory (its size is the decrypted size)
  if (await isLockedPath(payload.imagePath)) {
    const buffer = await readPlainFile(payload.imagePath, { maxBytes: limit });
    if (buffer.length === 0) throw new Error('desktop_input_size_invalid');
    return buffer;
  }
  const file = await open(payload.imagePath, 'r');
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size === 0 || before.size > limit) throw new Error('desktop_input_size_invalid');
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    const after = await file.stat();
    if (
      offset !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    )
      throw new Error('desktop_input_changed');
    return buffer.subarray(0, offset);
  } finally {
    await file.close();
  }
}
