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
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DesktopAssistanceActivationService } from 'src/services/desktop-assistance-activation.service.js';
import { DesktopAssistancePolicyService } from 'src/services/desktop-assistance-policy.service.js';
import { DesktopNasProducerService } from 'src/services/desktop-nas-producer.service.js';
import { DesktopWorkerAuthService } from 'src/services/desktop-worker-auth.service.js';
import { getConfig } from 'src/utils/config.js';
import { findDesktopClipSpace, parseDesktopClipSpaces } from 'src/utils/desktop-clip-space.js';
import { faceEntries } from 'src/utils/desktop-face.js';
import {
  type DesktopModelProfile,
  createDesktopModelChallenge,
  parseDesktopModelCatalogue,
} from 'src/utils/desktop-model-catalogue.js';
import { selectDesktopModelInventory } from 'src/utils/desktop-model-inventory.js';
import { ocrEntries } from 'src/utils/desktop-ocr.js';
import { DesktopQualificationReceipt } from 'src/utils/desktop-qualification.js';
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
  private catalogue = parseDesktopModelCatalogue(
    JSON.parse(readFileSync(join(import.meta.dirname, '../../resources/desktop/model-catalogue.json'), 'utf8')),
  );
  private spaces = parseDesktopClipSpaces(
    JSON.parse(readFileSync(join(import.meta.dirname, '../../resources/desktop/model-spaces.json'), 'utf8')),
    this.catalogue,
  );
  constructor(
    private auth: DesktopWorkerAuthService,
    private challenges: DesktopWorkerChallengeRepository,
    private configRepository: ConfigRepository,
    private systemMetadataRepository: SystemMetadataRepository,
    private nasProducer: DesktopNasProducerService,
    private activation: DesktopAssistanceActivationService,
    private workers: DesktopWorkerRepository,
    private destinations: MlDestinationRepository,
    private policies: DesktopAssistancePolicyService,
  ) {}

  async inventory(
    authorization: string | undefined,
    proof: string | undefined,
    payload: string,
  ): Promise<DesktopModelInventoryDto> {
    const grant = await this.auth.authenticate(authorization, proof, 'models', payload);
    const request = parse(DesktopModelInventoryRequestSchema, payload);
    const ownerId = await this.workers.owner(grant);
    if (!ownerId) throw new UnauthorizedException('desktop_worker_credential_invalid');
    if (!(await this.policies.read(ownerId))) throw new ForbiddenException('desktop_pool_policy_required');
    const config = await getConfig(
      { configRepo: this.configRepository, metadataRepo: this.systemMetadataRepository, logger: this.logger },
      { withCache: false },
    );
    const routes = await this.destinations.getRouteStates();
    const destinations = [];
    for (const destination of await this.destinations.getAll()) {
      if (routes.every((route) => !(route.origin === 'default' && route.destinationId === destination.id))) continue;
      try {
        await this.destinations.assertRecoveryAuthority(destination);
        destinations.push(destination);
      } catch (error) {
        if (!(error instanceof ConflictException) || error.message !== 'replacement_ml_authority_unavailable')
          throw error;
      }
    }
    return {
      protocolVersion: 1,
      ...request,
      workloads: selectDesktopModelInventory({
        config: config.machineLearning,
        catalogue: this.catalogue,
        spaces: this.spaces,
        routes,
        destinations,
        ...request,
      }),
    };
  }

  async issue(
    authorization: string | undefined,
    proof: string | undefined,
    payload: string,
  ): Promise<DesktopQualificationChallengeDto> {
    const grant = await this.auth.authenticate(authorization, proof, 'challenge', payload);
    const request = parse(DesktopQualificationRequestSchema, payload);
    const profile = await this.selected(request.modelKey, request.provider, request.runtimeSourceRevision);
    let runtime;
    try {
      runtime = verifyDesktopRuntimeAttestation(request.runtime, profile);
    } catch {
      throw new BadRequestException('desktop_runtime_attestation_invalid');
    }
    if (profile.workload === 'clip') {
      try {
        const space = findDesktopClipSpace(this.spaces, profile.modelKey)!;
        const producer = await this.nasProducer.verify(space.spaceKey);
        await producer.assertCurrent();
      } catch (error) {
        if (error instanceof ConflictException) throw error;
        throw new ConflictException('desktop_nas_producer_unavailable', { cause: error });
      }
    } else if (profile.workload === 'face') {
      try {
        const proof = await this.nasProducer.verifyFace(profile.modelKey);
        await proof.assertCurrent();
      } catch (error) {
        if (error instanceof ConflictException) throw error;
        throw new ConflictException('desktop_nas_face_producer_unavailable', { cause: error });
      }
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
  }

  async read(
    authorization: string | undefined,
    proof: string | undefined,
    id: string,
  ): Promise<DesktopQualificationChallengeDto> {
    const grant = await this.auth.authenticate(authorization, proof, `challenge:${id}`, '');
    const row = await this.challenges.read(grant, id);
    if (!row) throw new UnauthorizedException('desktop_challenge_invalid');
    const profile = await this.selected(row.modelKey, row.runtime.provider, row.runtime.sourceRevision);
    return this.response(row, profile);
  }

  async record(
    authorization: string | undefined,
    proof: string | undefined,
    id: string,
    payload: string,
  ): Promise<DesktopWorkerAckDto> {
    const grant = await this.auth.authenticate(authorization, proof, `qualification:${id}`, payload);
    const request = parse(DesktopQualificationReportSchema, payload);
    const row = await this.challenges.read(grant, id);
    if (!row) throw new UnauthorizedException('desktop_challenge_invalid');
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
    if (!(await this.challenges.record(grant, id, receipt))) return { accepted: false };
    const qualification = await this.challenges.readAccepted(grant, id);
    if (!qualification) throw new UnauthorizedException('desktop_qualification_invalid');
    this.assertAccepted(qualification, profile);
    if (profile.workload === 'face') await this.activation.activateFace(grant, qualification, profile.modelKey);
    else if (profile.workload === 'ocr') await this.activation.activateOcr(grant, qualification, profile);
    else
      await this.activation.activate(
        grant,
        qualification,
        findDesktopClipSpace(this.spaces, profile.modelKey)!.spaceKey,
      );
    return { accepted: true };
  }

  async accepted(
    authorization: string | undefined,
    proof: string | undefined,
    id: string,
  ): Promise<DesktopAcceptedQualificationDto> {
    const grant = await this.auth.authenticate(authorization, proof, `accepted-qualification:${id}`, '');
    const row = await this.challenges.readAccepted(grant, id);
    if (!row) throw new UnauthorizedException('desktop_qualification_invalid');
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

  private async selected(modelKey: string, provider: string, source: string): Promise<DesktopModelProfile> {
    const config = await getConfig(
      {
        configRepo: this.configRepository,
        metadataRepo: this.systemMetadataRepository,
        logger: this.logger,
      },
      { withCache: false },
    );
    const profile = this.catalogue.profiles.find(
      (item) => item.modelKey === modelKey && item.spec.provider === provider && item.runtimeSourceRevision === source,
    );
    if (
      !config.machineLearning.enabled ||
      !profile ||
      (profile.workload === 'clip'
        ? !config.machineLearning.clip.enabled ||
          !findDesktopClipSpace(this.spaces, profile.modelKey) ||
          config.machineLearning.clip.modelName !== profile.modelName
        : profile.workload === 'face'
          ? !config.machineLearning.facialRecognition.enabled ||
            canonicalJson(faceEntries(config.machineLearning.facialRecognition)) !== canonicalJson(profile.spec.entries)
          : !config.machineLearning.ocr.enabled ||
            canonicalJson(ocrEntries(config.machineLearning.ocr)) !== canonicalJson(profile.spec.entries)) ||
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
