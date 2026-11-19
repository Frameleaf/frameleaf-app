import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import z from 'zod';
import type { Transaction } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { DesktopModelInventoryDto, DesktopModelInventoryRequestSchema } from 'src/dtos/desktop-model-inventory.dto.js';
import {
  DesktopAcceptedQualificationDto,
  DesktopQualificationChallengeDto,
  DesktopQualificationReportSchema,
  DesktopQualificationRequestSchema,
} from 'src/dtos/desktop-qualification.dto.js';
import { DesktopWorkerAckDto } from 'src/dtos/desktop-worker-job.dto.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DesktopWorkerChallengeRepository } from 'src/repositories/desktop-worker-challenge.repository.js';
import { DesktopWorkerRepository } from 'src/repositories/desktop-worker.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DesktopAssistanceActivationService } from 'src/services/desktop-assistance-activation.service.js';
import { DesktopAssistancePolicyService } from 'src/services/desktop-assistance-policy.service.js';
import { DesktopWorkerAuthService } from 'src/services/desktop-worker-auth.service.js';
import { getConfig } from 'src/utils/config.js';
import { findDesktopClipSpace, parseDesktopClipSpaces } from 'src/utils/desktop-clip-space.js';
import {
  type DesktopModelProfile,
  createDesktopModelChallenge,
  parseDesktopModelCatalogue,
} from 'src/utils/desktop-model-catalogue.js';
import { selectDesktopModelInventory } from 'src/utils/desktop-model-inventory.js';
import { DesktopQualificationReceipt } from 'src/utils/desktop-qualification.js';
import { logDesktopNotAccepted, logDesktopRefusals } from 'src/utils/desktop-refusal-log.js';
import { desktopRuntimeMinimumEpoch, verifyDesktopRuntimeAttestation } from 'src/utils/desktop-runtime-attestation.js';
import { canonicalJson } from 'src/utils/object.js';

type Challenge = NonNullable<Awaited<ReturnType<DesktopWorkerChallengeRepository['read']>>>;
type AcceptedQualification = NonNullable<Awaited<ReturnType<DesktopWorkerChallengeRepository['readAccepted']>>>;
const parse = <T>(schema: z.ZodType<T>, payload: string): T => {
  try {
    if (Buffer.byteLength(payload) > 4 * 1024 * 1024) throw new Error('payload_too_large');
    return schema.parse(JSON.parse(payload));
  } catch {
    throw new BadRequestException('desktop_qualification_payload_invalid');
  }
};
@Injectable()
export class DesktopQualificationService {
  private logger = LoggingRepository.create(DesktopQualificationService.name);
  private catalogueJson: { profiles: Record<string, unknown>[] } = JSON.parse(
    readFileSync(join(import.meta.dirname, '../../resources/desktop/model-catalogue.json'), 'utf8'),
  );
  private catalogue = parseDesktopModelCatalogue(this.catalogueJson);
  private spaces = parseDesktopClipSpaces(
    JSON.parse(readFileSync(join(import.meta.dirname, '../../resources/desktop/model-spaces.json'), 'utf8')),
    this.catalogue,
  );
  constructor(
    private auth: DesktopWorkerAuthService,
    private challenges: DesktopWorkerChallengeRepository,
    private configRepository: ConfigRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private activation: DesktopAssistanceActivationService,
    private workers: DesktopWorkerRepository,
    private policies: DesktopAssistancePolicyService,
  ) {}

  /** Every refusal a desktop sees is also in the server log, with the code it was given. */
  private logged<T>(step: string, subject: () => string, work: () => Promise<T>): Promise<T> {
    return logDesktopRefusals(this.logger, step, subject, work);
  }

  inventory(authorization: string | undefined, proof: string | undefined, payload: string) {
    let subject = 'unauthenticated';
    return this.logged(
      'inventory',
      () => subject,
      async (): Promise<DesktopModelInventoryDto> => {
        const grant = await this.auth.authenticate(authorization, proof, 'models', payload);
        subject = `device ${grant.deviceId}`;
        const request = parse(DesktopModelInventoryRequestSchema, payload);
        const ownerId = await this.workers.owner(grant);
        if (!ownerId) throw new UnauthorizedException('desktop_worker_credential_invalid');
        if (!(await this.policies.read(ownerId))) throw new ForbiddenException('desktop_pool_policy_required');
        const config = await this.config();
        const { provider, runtimeSourceRevision } = request;
        const workloads = selectDesktopModelInventory({
          config: config.machineLearning,
          catalogue: this.catalogue,
          spaces: this.spaces,
          provider,
          runtimeSourceRevision,
        });
        if (request.protocolVersion !== 2) return { protocolVersion: 1, provider, runtimeSourceRevision, workloads };
        // The desktop runs exactly these profiles: the server's catalogue is the only one.
        const served = (modelKey: string) =>
          this.catalogueJson.profiles.find(
            (profile) =>
              profile.modelKey === modelKey &&
              (profile.spec as { provider?: string }).provider === provider &&
              profile.runtimeSourceRevision === runtimeSourceRevision,
          )!;
        return {
          protocolVersion: 2,
          provider,
          runtimeSourceRevision,
          workloads: workloads.map((item) =>
            item.state === 'eligible' ? { ...item, profiles: item.modelKeys.map((key) => served(key)) } : item,
          ),
        };
      },
    );
  }

  issue(
    authorization: string | undefined,
    proof: string | undefined,
    payload: string,
  ): Promise<DesktopQualificationChallengeDto> {
    let subject = 'unauthenticated';
    return this.logged(
      'challenge',
      () => subject,
      async () => {
        const grant = await this.auth.authenticate(authorization, proof, 'challenge', payload);
        subject = `device ${grant.deviceId}`;
        const request = parse(DesktopQualificationRequestSchema, payload);
        subject += `, ${request.modelKey} on ${request.provider}`;
        const profile = await this.selected(request.modelKey, request.provider, request.runtimeSourceRevision);
        let runtime;
        try {
          runtime = verifyDesktopRuntimeAttestation(request.runtime, profile);
        } catch {
          throw new BadRequestException('desktop_runtime_attestation_invalid');
        }
        let row;
        try {
          row = await this.challenges.issue(grant, request.requestId, profile, runtime);
        } catch (error) {
          if (
            error instanceof Error &&
            [
              'desktop_challenge_conflict',
              'desktop_challenge_capacity',
              'desktop_challenge_runtime_invalid',
              'desktop_challenge_too_large',
            ].includes(error.message)
          )
            throw new ConflictException(error.message);
          throw error;
        }
        if (!row) throw new UnauthorizedException('desktop_challenge_invalid');
        return this.response(row, profile);
      },
    );
  }

  read(
    authorization: string | undefined,
    proof: string | undefined,
    id: string,
  ): Promise<DesktopQualificationChallengeDto> {
    let subject = `challenge ${id}`;
    return this.logged(
      'challenge read',
      () => subject,
      async () => {
        const grant = await this.auth.authenticate(authorization, proof, `challenge:${id}`, '');
        subject += `, device ${grant.deviceId}`;
        const row = await this.challenges.read(grant, id);
        if (!row) throw new UnauthorizedException('desktop_challenge_invalid');
        subject += `, ${row.modelKey}`;
        const profile = await this.selected(row.modelKey, row.runtime.provider, row.runtime.sourceRevision);
        return this.response(row, profile);
      },
    );
  }

  record(
    authorization: string | undefined,
    proof: string | undefined,
    id: string,
    payload: string,
  ): Promise<DesktopWorkerAckDto> {
    let subject = `challenge ${id}`;
    return this.logged(
      'report',
      () => subject,
      async () => {
        const grant = await this.auth.authenticate(authorization, proof, `qualification:${id}`, payload);
        subject += `, device ${grant.deviceId}`;
        const request = parse(DesktopQualificationReportSchema, payload);
        const row = await this.challenges.read(grant, id);
        if (!row) throw new UnauthorizedException('desktop_challenge_invalid');
        subject += `, ${row.modelKey}`;
        const profile = await this.selected(row.modelKey, row.runtime.provider, row.runtime.sourceRevision);
        const challenge = this.response(row, profile);
        let receipt;
        try {
          receipt = DesktopQualificationReceipt.validate(
            request.report,
            profile,
            {
              specJson: challenge.specJson,
              bindingSha256: challenge.bindingSha256,
              fixtureBase64: challenge.fixtureBase64,
            },
            row.runtime,
          );
        } catch {
          throw new BadRequestException('desktop_qualification_report_invalid');
        }
        let recorded: boolean;
        try {
          recorded = await this.challenges.record(grant, id, receipt);
        } catch (error) {
          // The desktop already holds its limit of qualifications; it can report again once one runs out.
          if (error instanceof Error && error.message === 'desktop_qualification_capacity')
            throw new ConflictException(error.message);
          throw error;
        }
        if (!recorded) {
          logDesktopNotAccepted(this.logger, 'report', subject);
          return { accepted: false };
        }
        const qualification = await this.challenges.readAccepted(grant, id);
        if (!qualification) throw new UnauthorizedException('desktop_qualification_invalid');
        this.assertAccepted(qualification, profile);
        // The configured model must still be this profile when the grant is written.
        const current = (tx: Transaction<DB>) => this.assertProfileCurrent(profile, tx);
        if (profile.workload === 'clip')
          await this.activation.activate(
            grant,
            qualification,
            findDesktopClipSpace(this.spaces, profile.modelKey)!.spaceKey,
            current,
          );
        else await this.activation.activateModel(grant, qualification, profile.modelKey, current);
        return { accepted: true };
      },
    );
  }

  accepted(
    authorization: string | undefined,
    proof: string | undefined,
    id: string,
  ): Promise<DesktopAcceptedQualificationDto> {
    let subject = `qualification ${id}`;
    return this.logged(
      'qualification read',
      () => subject,
      async () => {
        const grant = await this.auth.authenticate(authorization, proof, `accepted-qualification:${id}`, '');
        subject += `, device ${grant.deviceId}`;
        const row = await this.challenges.readAccepted(grant, id);
        if (!row) throw new UnauthorizedException('desktop_qualification_invalid');
        subject += `, ${row.modelKey}`;
        const profile = await this.selected(row.modelKey, row.runtime.provider, row.runtime.sourceRevision);
        this.assertAccepted(row, profile);
        return {
          id: row.id,
          deviceId: row.deviceId,
          sessionId: row.sessionId,
          authorizationEpoch: row.authorizationEpoch,
          modelKey: row.modelKey,
          configSha256: row.configSha256,
          inputKind: row.inputKind,
          bindingSha256: createDesktopModelChallenge(profile, row.id).bindingSha256,
          manifestSha256: row.runtime.manifestSha256,
          runtimeFingerprint: row.runtimeFingerprint,
          reportSha256: row.reportSha256,
          qualifiedAt: new Date(row.createdAt).toISOString(),
          expiresAt: new Date(row.expiresAt).toISOString(),
        };
      },
    );
  }

  private assertAccepted(row: AcceptedQualification, profile: DesktopModelProfile) {
    const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
    if (
      row.profileSha256 !== digest(profile) ||
      row.configSha256 !== digest(profile.spec.entries) ||
      row.inputKind !== profile.spec.fixtureKind ||
      row.runtime.epoch < desktopRuntimeMinimumEpoch()
    )
      throw new ConflictException('desktop_model_profile_changed');
  }

  private config(tx?: Transaction<DB>) {
    return getConfig(
      {
        configRepo: this.configRepository,
        metadataRepo: tx ? new SystemMetadataRepository(tx) : this.systemMetadataRepository,
        logger: this.logger,
      },
      { withCache: false },
    );
  }

  /**
   * Whether the server's machine-learning settings still ask for this profile: exactly the keys the inventory
   * lists for the profile's runtime, so a key no task will use can never be challenged or granted.
   */
  private configures(config: Awaited<ReturnType<typeof getConfig>>, profile: DesktopModelProfile) {
    return selectDesktopModelInventory({
      config: config.machineLearning,
      catalogue: this.catalogue,
      spaces: this.spaces,
      provider: profile.spec.provider,
      runtimeSourceRevision: profile.runtimeSourceRevision,
    }).some((item) => item.state === 'eligible' && item.modelKeys.includes(profile.modelKey));
  }

  private async assertProfileCurrent(profile: DesktopModelProfile, tx: Transaction<DB>) {
    if (!this.configures(await this.config(tx), profile)) throw new ConflictException('desktop_model_profile_changed');
  }

  private async selected(modelKey: string, provider: string, source: string): Promise<DesktopModelProfile> {
    const config = await this.config();
    const profile = this.catalogue.profiles.find(
      (item) => item.modelKey === modelKey && item.spec.provider === provider && item.runtimeSourceRevision === source,
    );
    if (
      !profile ||
      !this.configures(config, profile) ||
      Buffer.from(profile.fixtureBase64, 'base64').length > 2 * 1024 * 1024
    )
      throw new ConflictException('desktop_model_profile_unavailable');
    return profile;
  }

  private response(row: Challenge, profile: DesktopModelProfile): DesktopQualificationChallengeDto {
    const challenge = createDesktopModelChallenge(profile, row.id);
    if (challenge.specJson !== row.specJson || challenge.bindingSha256 !== row.bindingSha256)
      throw new ConflictException('desktop_model_profile_changed');
    return {
      id: row.id,
      modelKey: row.modelKey,
      specJson: row.specJson,
      bindingSha256: row.bindingSha256,
      fixtureBase64: profile.fixtureBase64,
      manifestSha256: row.runtime.manifestSha256,
      expiresAt: new Date(row.expiresAt).toISOString(),
      reportSha256: row.reportSha256,
    };
  }
}
