import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { DesktopWorkerChallengeRepository } from 'src/repositories/desktop-worker-challenge.repository.js';
import { DesktopClipIndexRepository } from 'src/repositories/desktop-clip-index.repository.js';
import { type DesktopWorkerGrant, DesktopWorkerRepository } from 'src/repositories/desktop-worker.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DesktopAssistancePolicyService } from 'src/services/desktop-assistance-policy.service.js';
import { DesktopNasProducerService } from 'src/services/desktop-nas-producer.service.js';

type Qualification = NonNullable<Awaited<ReturnType<DesktopWorkerChallengeRepository['readAccepted']>>>;

@Injectable()
export class DesktopAssistanceActivationService {
  constructor(
    private workers: DesktopWorkerRepository,
    private index: DesktopClipIndexRepository,
    private nas: DesktopNasProducerService,
    private policies: DesktopAssistancePolicyService,
    private metadata: SystemMetadataRepository,
    private destinations: MlDestinationRepository,
  ) {}

  async activate(grant: DesktopWorkerGrant, qualification: Qualification, spaceKey: string): Promise<void> {
    const ownerId = await this.workers.owner(grant);
    if (!ownerId) throw new UnauthorizedException('desktop_worker_activation_invalid');
    const account = await this.policies.read(ownerId);
    if (!account) throw new ConflictException('desktop_pool_policy_required');
    const proof = await this.nas.verify(spaceKey).catch((error: unknown) => {
      if (error instanceof ConflictException) throw error;
      throw new ConflictException('desktop_nas_producer_unavailable', { cause: error });
    });
    if (proof.spaceKey !== spaceKey || !proof.modelKeys.includes(qualification.modelKey))
      throw new ConflictException('desktop_pool_model_unavailable');
    try {
      await this.metadata.withConfigTransaction(async (_metadata, tx) => {
        await this.policies.assertCurrent(ownerId, account.revisionId, tx);
        await this.destinations.assertDefaultRoute(proof.selection, proof.routeRevisionId, tx);
        await this.index.admit(spaceKey, { transaction: tx, assertAuthority: () => proof.assertCurrent(tx) });
        if (
          !(await this.workers.grantQualifiedModel({ grant, ownerId, qualification, modelKeys: proof.modelKeys }, tx))
        )
          throw new UnauthorizedException('desktop_worker_activation_invalid');
      });
    } catch (error) {
      if (
        error instanceof Error &&
        [
          'desktop_clip_index_incompatible',
          'desktop_clip_index_dimensions',
          'desktop_clip_index_invalid',
          'desktop_clip_index_changed',
          'desktop_clip_space_unavailable',
          'desktop_clip_publication_isolation',
          'desktop_pool_route_changed',
          'desktop_pool_destination_changed',
        ].includes(error.message)
      )
        throw new ConflictException(error.message, { cause: error });
      throw error;
    }
  }
}
