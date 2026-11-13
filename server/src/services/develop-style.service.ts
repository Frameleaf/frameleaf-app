import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { DateTime } from 'luxon';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { OnEvent } from 'src/decorators.js';
import type { DevelopStyleApplyDto, DevelopStyleBatchDto } from 'src/dtos/develop-style.dto.js';
import { FrameleafWorker } from 'src/enum.js';
import { DesktopClipIndexRepository } from 'src/repositories/desktop-clip-index.repository.js';
import { DevelopStyleRepository } from 'src/repositories/develop-style.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { AssetDevelopService } from 'src/services/asset-develop.service.js';
import { PhotographyWorkspaceService } from 'src/services/photography-workspace.service.js';
import { renderDevelopProjection } from 'src/utils/develop-envelope.js';
import { defaultDevelopRecipe, normalizeDevelopRecipe } from 'src/utils/develop-recipe.js';
import {
  extractStyleFeatures,
  fitDevelopStyle,
  MIN_STYLE_EDITS,
  predictDevelopStyle,
  validateDevelopStyle,
  type StyleSample,
} from 'src/utils/develop-style.js';
import { parseEmbedding } from 'src/utils/embedding.js';
import { isLockedPath } from 'src/utils/locked-read.js';

@Injectable()
export class DevelopStyleService {
  constructor(
    private readonly styles: DevelopStyleRepository,
    private readonly media: MediaRepository,
    private readonly search: SearchRepository,
    private readonly clipIndex: DesktopClipIndexRepository,
    private readonly develop: AssetDevelopService,
    private readonly photography: PhotographyWorkspaceService,
    private readonly logger: LoggingRepository,
  ) {
    this.logger.setContext(DevelopStyleService.name);
  }

  private owner(auth: AuthDto) {
    if (!auth.session || auth.apiKey || auth.sharedLink)
      throw new ForbiddenException('My style requires a user session');
    return auth.user.id;
  }

  async get(auth: AuthDto) {
    const userId = this.owner(auth);
    const [profile, samples] = await Promise.all([this.styles.getProfile(userId), this.styles.trainingPhotos(userId)]);
    return {
      availableEdits: samples.length,
      learnedEdits: profile?.sampleCount ?? null,
      trainedAt: profile?.trainedAt.toISOString() ?? null,
    };
  }

  async learn(auth: AuthDto) {
    const userId = this.owner(auth);
    const profile = await this.styles.getProfile(userId);
    await this.train(userId, profile?.trainedAt ?? null);
    return this.get(auth);
  }

  async forget(auth: AuthDto) {
    await this.styles.forget(this.owner(auth));
  }

  @OnEvent({ name: 'NightlyDatabaseCleanup', workers: [FrameleafWorker.Microservices] })
  async refreshStyles() {
    const weekAgo = DateTime.utc().minus({ days: 7 }).toJSDate();
    for await (const profile of this.styles.profilesDue(weekAgo)) {
      const newEdits = await this.styles.trainingPhotos(profile.userId, profile.trainedAt);
      if (newEdits.length < 20) continue;
      try {
        await this.train(profile.userId, profile.trainedAt);
      } catch (error) {
        this.logger.warn(
          `Could not refresh My style for ${profile.userId}: ${error instanceof Error ? error.message : error}`,
        );
      }
    }
  }

  private async features(photo: { id: string; path: string }, producerModelKey: string | null) {
    if (await isLockedPath(photo.path)) throw new ForbiddenException('Photo is unavailable');
    const [pixels, embedding] = await Promise.all([
      this.media.decodeImage(photo.path, { size: 96, colorspace: 'srgb', processInvalidImages: false }),
      producerModelKey ? this.search.getEmbedding(photo.id) : undefined,
    ]);
    return {
      image: extractStyleFeatures(pixels.data, pixels.info.channels),
      embedding: embedding?.producerModelKey === producerModelKey ? parseEmbedding(embedding.embedding) : undefined,
    };
  }

  private async train(userId: string, expectedTrainedAt: Date | null) {
    const [photos, index] = await Promise.all([this.styles.trainingPhotos(userId), this.clipIndex.getActive()]);
    const producerModelKey = index?.space.visualModelKey ?? null;
    const samples: StyleSample[] = [];
    for (const photo of photos) {
      try {
        const features = await this.features(photo, producerModelKey);
        samples.push({ ...features, sliders: renderDevelopProjection(photo.recipe) });
      } catch {
        // A preview may disappear or become Locked between listing and decoding.
      }
    }
    if (samples.length < MIN_STYLE_EDITS) throw new BadRequestException('My style needs at least 50 edited photos');
    if (!validateDevelopStyle(samples))
      throw new BadRequestException('My style could not improve on Auto for these edits');
    const modelJson = { ...fitDevelopStyle(samples), producerModelKey };
    if (
      !(await this.styles.saveProfile(
        { userId, version: 1, sampleCount: samples.length, modelJson, trainedAt: new Date() },
        expectedTrainedAt,
      ))
    ) {
      throw new ConflictException('My style changed while learning');
    }
  }

  async apply(auth: AuthDto, shootId: string, dto: DevelopStyleApplyDto): Promise<DevelopStyleBatchDto> {
    const userId = this.owner(auth);
    const safeAuth = { ...auth, session: { ...auth.session!, hasElevatedPermission: false } };
    const [profile, albumId] = await Promise.all([
      this.styles.getProfile(userId),
      this.photography.styleAlbumId(safeAuth, shootId),
    ]);
    if (!profile) throw new BadRequestException('Learn My style before applying it');
    const requested = dto.assetIds ? [...new Set(dto.assetIds)] : undefined;
    const photos = await this.styles.shootPhotos(userId, albumId, requested);
    if (!photos.length || photos.length > 500 || (requested && requested.length !== photos.length)) {
      throw new BadRequestException('Choose up to 500 available photos from this shoot');
    }
    const versions: DevelopStyleBatchDto['versions'] = [];
    let failed = 0;
    for (const photo of photos) {
      try {
        const { image, embedding } = await this.features(photo, profile.modelJson.producerModelKey);
        const sliders = predictDevelopStyle(profile.modelJson, image, embedding);
        const recipe = normalizeDevelopRecipe({ ...defaultDevelopRecipe(), ...sliders });
        versions.push(await this.develop.createStyleVersion(safeAuth, photo.id, dto.batchId, recipe));
      } catch {
        failed++;
      }
    }
    return { batchId: dto.batchId, versions, failed };
  }

  undo(auth: AuthDto, batchId: string) {
    this.owner(auth);
    return this.develop.undoStyleBatch(auth, batchId);
  }
}
