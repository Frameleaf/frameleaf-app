import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import type { PhotographyWorkflowService } from 'src/services/photography-workflow.service.js';
import { MlProcessingSource, MlWorkload } from 'src/enum.js';
import { rateLimitedException } from 'src/middleware/rate-limit.guard.js';
import { BaseService } from 'src/services/base.service.js';
import { FaceEmbeddingSchema } from 'src/utils/face-result.js';
import { CloudConnectionState, resolveCloudGateway } from 'src/utils/frameleaf-cloud-gateway.js';
import { decodeCloudEmbedding } from 'src/utils/frameleaf-cloud.js';
import { isFacialRecognitionEnabled } from 'src/utils/misc.js';
import { firstCandidate } from 'src/utils/ml-processing-order.js';

export const GALLERY_SELFIE_MAX_BYTES = 10 * 1024 * 1024;

@Injectable()
export class PhotographySelfieService extends BaseService {
  async search(
    workflows: PhotographyWorkflowService,
    rateLimit: RateLimitRepository,
    id: string,
    token: string | undefined,
    image: Buffer | undefined,
  ) {
    const { ownerId, captures } = await workflows.selfieSource(id, token);
    const sessionHash = createHash('sha256').update(token!).digest('hex');
    let hit;
    try {
      hit = await rateLimit.hit(`gallery-selfie:${id}:${sessionHash}`, 3600);
    } catch {
      throw new ServiceUnavailableException({ message: 'Selfie search is unavailable', code: 'selfie_unavailable' });
    }
    if (hit.count > 10) throw rateLimitedException(hit.resetSeconds);
    if (!image?.length || image.length > GALLERY_SELFIE_MAX_BYTES) {
      throw new BadRequestException({ message: 'Choose a selfie image', code: 'selfie_invalid_image' });
    }
    const { machineLearning } = await this.getConfig({ withCache: true });
    if (!isFacialRecognitionEnabled(machineLearning)) {
      throw new ServiceUnavailableException({ message: 'Selfie search is unavailable', code: 'selfie_unavailable' });
    }
    const { maxDistance, modelName, minScore } = machineLearning.facialRecognition;
    const embedding = await this.detectSelfie(ownerId, image, { modelName, minScore });
    const assetIds = await this.searchRepository.findGalleryFaces(
      ownerId,
      [...new Set(captures.map(({ assetId }) => assetId))],
      embedding,
      maxDistance,
    );
    // Publication, locks and recipient permissions can change during inference.
    const current = await workflows.selfieSource(id, token);
    const visible = new Map(current.captures.map(({ assetId, captureId }) => [assetId, captureId]));
    return { captureIds: assetIds.flatMap((assetId) => visible.get(assetId) ?? []) };
  }

  private async detectSelfie(ownerId: string, image: Buffer, options: { modelName: string; minScore: number }) {
    const folder = await mkdtemp(join(tmpdir(), 'frameleaf-guest-selfie-'));
    try {
      const path = join(folder, 'selfie.jpg');
      try {
        const source = sharp(image, { failOn: 'error', limitInputPixels: 40_000_000 });
        const { format } = await source.metadata();
        if (!format || !['jpeg', 'png', 'webp', 'heif'].includes(format)) throw new Error('Unsupported image');
        await source.rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).jpeg().toFile(path);
      } catch {
        throw new BadRequestException({ message: 'Choose a supported selfie image', code: 'selfie_invalid_image' });
      }

      let faces;
      try {
        const route = await this.mlDestinationRepository.resolveRoute(MlWorkload.Face);
        const homeOnly = await this.keepsPhotosHome(ownerId);
        const candidate = firstCandidate(
          route.filter(({ source }) => !homeOnly || source !== MlProcessingSource.Cloud),
        );
        if (!candidate) throw new Error('No place processes faces');
        if (candidate.source === MlProcessingSource.Cloud) faces = await this.cloudSelfie(path, options);
        else {
          const selection = await this.selectMlDestination({
            workload: MlWorkload.Face,
            destinationId: candidate.destinationId,
            ownerId,
            homeOnly,
            desktopPool: candidate.desktopPool ? 'only' : 'skip',
            guestFace: true,
          });
          const result = await this.machineLearningRepository.detectFaces(
            selection,
            path,
            options,
            AbortSignal.timeout(30_000),
          );
          faces = result.faces;
        }
      } catch {
        throw new ServiceUnavailableException({ message: 'Selfie search is unavailable', code: 'selfie_unavailable' });
      }
      if (faces.length !== 1) {
        throw new BadRequestException({
          message: faces.length > 0 ? 'Use a selfie with one face' : 'No face was found in the selfie',
          code: faces.length > 0 ? 'selfie_multiple_faces' : 'selfie_no_face',
        });
      }
      const parsed = FaceEmbeddingSchema.safeParse(faces[0].embedding);
      if (!parsed.success)
        throw new ServiceUnavailableException({ message: 'Selfie search is unavailable', code: 'selfie_unavailable' });
      return parsed.data;
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  }

  /**
   * FL-1058, FC-277: the Face route reaches Frameleaf Cloud, which answers one selfie on CPU in the owner's region
   * while the guest waits (owner decision 2026-11-13). Off until the owner allows Cloud for guest selfies
   * (`FRAMELEAF_GUEST_SELFIE_CLOUD`); the Cloud service runs buffalo_l only, so another face model stays unavailable.
   */
  private async cloudSelfie(path: string, options: { modelName: string; minScore: number }) {
    if (!this.configRepository.getEnv().frameleafCloud.guestSelfies || options.modelName !== 'buffalo_l')
      throw new Error('Frameleaf Cloud does not take guest selfies');
    const resolution = await resolveCloudGateway({
      configRepository: this.configRepository,
      databaseRepository: this.databaseRepository,
      systemMetadataRepository: this.systemMetadataRepository,
      instanceIdentityRepository: this.instanceIdentityRepository,
      frameleafCloudRepository: this.frameleafCloudRepository,
      eventRepository: this.eventRepository,
      logger: this.logger,
    });
    if (resolution.state !== CloudConnectionState.Ready) throw new Error(resolution.detail);
    const answer = await this.frameleafCloudMlRepository.detectSelfieFaces(
      resolution.gateway,
      new Uint8Array(await readFile(path)),
      options.minScore,
    );
    return answer.faces.map(({ embedding }) => ({ embedding: JSON.stringify(decodeCloudEmbedding(embedding)) }));
  }
}
