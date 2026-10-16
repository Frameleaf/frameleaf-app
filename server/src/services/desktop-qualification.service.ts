import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import z from 'zod';
import {
  DesktopAcceptedQualificationDto,
  DesktopQualificationChallengeDto,
  DesktopQualificationReportSchema,
  DesktopQualificationRequestSchema,
} from 'src/dtos/desktop-qualification.dto.js';
import { DesktopWorkerAckDto } from 'src/dtos/desktop-worker-job.dto.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DesktopWorkerChallengeRepository } from 'src/repositories/desktop-worker-challenge.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DesktopNasProducerService } from 'src/services/desktop-nas-producer.service.js';
import { DesktopWorkerAuthService } from 'src/services/desktop-worker-auth.service.js';
import { getConfig } from 'src/utils/config.js';
import { findDesktopClipSpace, parseDesktopClipSpaces } from 'src/utils/desktop-clip-space.js';
import {
  type DesktopModelProfile,
  createDesktopModelChallenge,
  parseDesktopModelCatalogue,
} from 'src/utils/desktop-model-catalogue.js';
import { DesktopQualificationReceipt } from 'src/utils/desktop-qualification.js';
import { desktopRuntimeMinimumEpoch, verifyDesktopRuntimeAttestation } from 'src/utils/desktop-runtime-attestation.js';
import { canonicalJson } from 'src/utils/object.js';

type Challenge = NonNullable<Awaited<ReturnType<DesktopWorkerChallengeRepository['read']>>>;
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
  ) {}

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
    try {
      const space = findDesktopClipSpace(this.spaces, profile.modelKey)!;
      const producer = await this.nasProducer.verify(space.spaceKey);
      await producer.assertCurrent();
    } catch (error) {
      if (error instanceof ConflictException) throw error;
      throw new ConflictException('desktop_nas_producer_unavailable', { cause: error });
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
    return { accepted: await this.challenges.record(grant, id, receipt) };
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
    const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
    if (
      row.profileSha256 !== digest(profile) ||
      row.configSha256 !== digest(profile.spec.entries) ||
      row.inputKind !== profile.spec.fixtureKind ||
      row.runtime.epoch < desktopRuntimeMinimumEpoch()
    )
      throw new ConflictException('desktop_model_profile_changed');
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
      !config.machineLearning.clip.enabled ||
      !profile ||
      !findDesktopClipSpace(this.spaces, profile.modelKey) ||
      config.machineLearning.clip.modelName !== profile.modelName ||
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
