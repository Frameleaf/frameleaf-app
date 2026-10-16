import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import z from 'zod';
import type { Transaction } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { OnEvent } from 'src/decorators.js';
import { MlDestinationKind, MlWorkload } from 'src/enum.js';
import { afterJobCommit, deferJobAdoption, jobSignal, queueExecution } from 'src/queue/context.js';
import { deferJobUntilDependency } from 'src/queue/dependency.js';
import {
  type DesktopClipIndexBinding,
  DesktopClipIndexRepository,
} from 'src/repositories/desktop-clip-index.repository.js';
import { DesktopMlRepository, DesktopMlRequest } from 'src/repositories/desktop-ml.repository.js';
import {
  type DesktopPoolOptions,
  MachineLearningRepository,
  type MlSelection,
  type ModelPayload,
} from 'src/repositories/machine-learning.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { DesktopAssistancePolicyService } from 'src/services/desktop-assistance-policy.service.js';
import { parseBoundClipResult } from 'src/utils/clip-embedding.js';
import { canonicalJson } from 'src/utils/object.js';

@Injectable()
export class DesktopMlService {
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
  }

  @OnEvent({ name: 'AppShutdown' })
  onShutdown() {
    this.machineLearning?.setDesktopPoolSelector(null);
  }

  async selectBackgroundPool(selection: MlSelection, options: DesktopPoolOptions): Promise<MlSelection> {
    const context = queueExecution.getStore();
    if (
      !context ||
      selection.workload !== MlWorkload.Clip ||
      ![MlDestinationKind.Local, MlDestinationKind.Lan].includes(selection.kind) ||
      selection.endpoint.cloud
    )
      return selection;
    if (!this.policies || !this.routes) throw new Error('desktop_pool_authority_unavailable');
    const route = (await this.routes.getRouteStates()).find((route) => route.workload === MlWorkload.Clip);
    if (route?.origin !== 'default' || route.destinationId !== selection.destinationId || !route.revisionId)
      return selection;
    const policy = await this.policies.snapshot();
    const sources = context.sourceAuthorities;
    const source = options.jobId
      ? sources?.get(options.jobId)
      : sources?.size === 1
        ? sources.values().next().value
        : undefined;
    if (!source) {
      if (Object.keys(policy.accounts).length > 0) {
        deferJobUntilDependency('source-unavailable');
        throw new Error('desktop_pool_source_required');
      }
      return selection;
    }
    const ownerId = source.ownerId;
    const account = policy.accounts[ownerId];
    if (!account) return selection;
    const selected = await this.index.selectProfile(options.modelName, 'image');
    if (!selected) {
      deferJobUntilDependency('destination-configuration');
      throw new Error('desktop_pool_index_required');
    }
    const revisionId = route.revisionId;
    const assertAuthority = async (tx?: Transaction<DB>) => {
      await this.policies!.assertCurrent(ownerId, account.revisionId, tx);
      await this.routes!.assertDefaultRoute(selection, revisionId, tx);
      await options.assertConfig(tx);
      await source.assertCurrent(tx);
    };
    await assertAuthority();
    return this.selectClipPool(selection, {
      ownerId,
      authorityKey: `${account.revisionId}:${revisionId}`,
      binding: selected.binding,
      assertAuthority,
    });
  }

  selectClipPool(
    selection: MlSelection,
    options: {
      ownerId: string;
      authorityKey: string;
      binding: DesktopClipIndexBinding;
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
      .update(canonicalJson({ policy, ownerId, destinationId: selection.destinationId, binding, claim }))
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

  async dispatch<T>(options: {
    request: DesktopMlRequest;
    assertAuthority: (tx?: Transaction<DB>) => Promise<void>;
    decodeResult: (value: unknown) => T;
    signal?: AbortSignal;
  }): Promise<T> {
    const remaining = options.request.deadlineAt.getTime() - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0 || remaining > 600_000)
      throw new Error('desktop_deadline_invalid');
    const parent = jobSignal();
    const signal = AbortSignal.any([
      AbortSignal.timeout(remaining),
      ...(parent ? [parent] : []),
      ...(options.signal ? [options.signal] : []),
    ]);
    signal.throwIfAborted();
    await options.assertAuthority();
    signal.throwIfAborted();
    const task = await this.repository.create(options.request);
    let deferred = false;
    try {
      while (true) {
        signal.throwIfAborted();
        const row = await this.repository.result(task.id);
        signal.throwIfAborted();
        if (!row || row.state === 'cancelled') throw new Error('desktop_inference_cancelled');
        if (row.state === 'failed') throw new Error('desktop_inference_failed');
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
          if (deferred) await afterJobCommit(() => this.repository.discard(task.id));
          else await this.repository.assertAdoption(task.id, task);
          signal.throwIfAborted();
          return result;
        }
        await setTimeout(1000, undefined, { signal });
      }
    } finally {
      // No cleanup uses the cancelled parent signal: fencing the worker must still finish.
      if (!deferred) {
        await this.repository.cancel(task.id);
        await this.repository.discard(task.id);
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
