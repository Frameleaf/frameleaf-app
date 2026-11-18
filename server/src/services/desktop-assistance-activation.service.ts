import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { Transaction } from 'kysely';
import type { DesktopWorkerChallengeRepository } from 'src/repositories/desktop-worker-challenge.repository.js';
import type { DB } from 'src/schema/index.js';
import { DesktopClipIndexRepository } from 'src/repositories/desktop-clip-index.repository.js';
import { type DesktopWorkerGrant, DesktopWorkerRepository } from 'src/repositories/desktop-worker.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DesktopAssistancePolicyService } from 'src/services/desktop-assistance-policy.service.js';

type Qualification = NonNullable<Awaited<ReturnType<DesktopWorkerChallengeRepository['readAccepted']>>>;
/** Re-reads the server's settings inside the grant transaction; throws when they no longer ask for this profile. */
type AssertProfile = (tx: Transaction<DB>) => Promise<void>;

/**
 * Grants a qualified model to a desktop worker. What a grant needs: the account's current Desktop AI
 * processing approval and a profile the server's machine-learning settings still ask for. The server's own AI,
 * its destinations and its routes have no part in it.
 */
@Injectable()
export class DesktopAssistanceActivationService {
  constructor(
    private workers: DesktopWorkerRepository,
    private index: DesktopClipIndexRepository,
    private policies: DesktopAssistancePolicyService,
    private metadata: SystemMetadataRepository,
  ) {}

  /** Face and OCR: one model key each. */
  async activateModel(
    grant: DesktopWorkerGrant,
    qualification: Qualification,
    modelKey: string,
    assertProfile: AssertProfile,
  ): Promise<void> {
    if (qualification.modelKey !== modelKey) throw new ConflictException('desktop_pool_model_unavailable');
    return this.grant(grant, qualification, [modelKey], assertProfile);
  }

  /** CLIP: the image and text encoders of one space, admitted to the desktop vector index first. */
  async activate(
    grant: DesktopWorkerGrant,
    qualification: Qualification,
    spaceKey: string,
    assertProfile: AssertProfile,
  ): Promise<void> {
    const space = this.index.space(spaceKey);
    if (!space) throw new ConflictException('desktop_clip_space_unavailable');
    const modelKeys = [space.visualModelKey, ...space.textModelKeys];
    if (!modelKeys.includes(qualification.modelKey)) throw new ConflictException('desktop_pool_model_unavailable');
    return this.grant(grant, qualification, modelKeys, assertProfile, (tx) =>
      this.index.admit(spaceKey, { transaction: tx, assertAuthority: () => assertProfile(tx) }),
    );
  }

  private async grant(
    grant: DesktopWorkerGrant,
    qualification: Qualification,
    modelKeys: string[],
    assertProfile: AssertProfile,
    admit?: (tx: Transaction<DB>) => Promise<unknown>,
  ): Promise<void> {
    const ownerId = await this.workers.owner(grant);
    if (!ownerId) throw new UnauthorizedException('desktop_worker_activation_invalid');
    const account = await this.policies.read(ownerId);
    if (!account) throw new ConflictException('desktop_pool_policy_required');
    try {
      await this.metadata.withConfigTransaction(async (_metadata, tx) => {
        await this.policies.assertCurrent(ownerId, account.revisionId, tx);
        await assertProfile(tx);
        await admit?.(tx);
        if (!(await this.workers.grantQualifiedModel({ grant, ownerId, qualification, modelKeys }, tx)))
          throw new UnauthorizedException('desktop_worker_activation_invalid');
      });
    } catch (error) {
      if (error instanceof ConflictException || error instanceof UnauthorizedException) throw error;
      if (
        error instanceof Error &&
        [
          'desktop_clip_index_incompatible',
          'desktop_clip_index_dimensions',
          'desktop_clip_index_invalid',
          'desktop_clip_index_changed',
          'desktop_clip_space_unavailable',
          'desktop_clip_publication_isolation',
          'desktop_pool_policy_changed',
        ].includes(error.message)
      )
        throw new ConflictException(error.message, { cause: error });
      throw error;
    }
  }
}
