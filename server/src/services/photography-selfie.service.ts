import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { MlProcessingSource, MlWorkload } from 'src/enum.js';
import { rateLimitedException } from 'src/middleware/rate-limit.guard.js';
import type { RateLimitRepository } from 'src/repositories/rate-limit.repository.js';
import { BaseService } from 'src/services/base.service.js';
import type { PhotographyWorkflowService } from 'src/services/photography-workflow.service.js';
import { FaceEmbeddingSchema } from 'src/utils/face-result.js';
import { firstCandidate } from 'src/utils/ml-processing-order.js';
import { isFacialRecognitionEnabled } from 'src/utils/misc.js';

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
        // The queued Desktop pool and Cloud library batch protocols cannot carry ephemeral guest data.
        if (!candidate || candidate.desktopPool || candidate.source === MlProcessingSource.Cloud)
          throw new Error('Ephemeral face inference is unavailable for this destination');
        const selection = await this.selectMlDestination({
          workload: MlWorkload.Face,
          destinationId: candidate.destinationId,
          ownerId,
          homeOnly,
          desktopPool: 'skip',
        });
        const result = await this.machineLearningRepository.detectFaces(
          selection,
          path,
          options,
          AbortSignal.timeout(30_000),
        );
        faces = result.faces;
      } catch {
        throw new ServiceUnavailableException({ message: 'Selfie search is unavailable', code: 'selfie_unavailable' });
      }
      if (faces.length !== 1) {
        throw new BadRequestException({
          message: faces.length ? 'Use a selfie with one face' : 'No face was found in the selfie',
          code: faces.length ? 'selfie_multiple_faces' : 'selfie_no_face',
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
}
