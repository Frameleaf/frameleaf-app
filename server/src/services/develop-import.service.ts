import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { ArgOf } from 'src/repositories/event.repository.js';
import type { JobOf } from 'src/types.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { AssetType, AssetVisibility, JobName, JobStatus, QueueName } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { AssetDevelopService } from 'src/services/asset-develop.service.js';
import { getAssetFiles } from 'src/utils/asset.util.js';
import { developEnvelope } from 'src/utils/develop-envelope.js';
import { importDarktable } from 'src/utils/develop-import/darktable.js';
import { importLightroom } from 'src/utils/develop-import/lightroom.js';
import { readDevelopXmp } from 'src/utils/develop-import/xmp.js';
import { withPlainCopy } from 'src/utils/locked-read.js';
import { canonicalJson } from 'src/utils/object.js';
import { getPreferences } from 'src/utils/preferences.js';
import { MAX_XMP_BYTES } from 'src/utils/xmp-sidecar.js';

@Injectable()
export class DevelopImportService {
  constructor(
    private readonly develop: AssetDevelopService,
    private readonly assetRepository: AssetRepository,
    private readonly userRepository: UserRepository,
    private readonly storageRepository: StorageRepository,
    private readonly jobRepository: JobRepository,
  ) {}

  @OnEvent({ name: 'AssetMetadataExtracted' })
  async queueImport({ assetId }: ArgOf<'AssetMetadataExtracted'>) {
    await this.jobRepository.queue({ name: JobName.DevelopImport, data: { id: assetId } });
  }

  @OnJob({ name: JobName.DevelopImport, queue: QueueName.Editor })
  async handleImport({ id }: JobOf<JobName.DevelopImport>): Promise<JobStatus> {
    const asset = await this.assetRepository.getById(id, { files: true });
    if (
      !asset ||
      asset.type !== AssetType.Image ||
      asset.deletedAt ||
      asset.isOffline ||
      asset.visibility === AssetVisibility.Hidden
    )
      return JobStatus.Skipped;
    const preferences = getPreferences(await this.userRepository.getMetadata(asset.ownerId));
    if (preferences.develop?.importXmpEdits === false) return JobStatus.Skipped;
    const { sidecarFile } = getAssetFiles(asset.files ?? []);
    if (!sidecarFile) return JobStatus.Skipped;
    const data = await withPlainCopy(sidecarFile.path, async (path) => {
      const stats = await this.storageRepository.stat(path);
      if (stats.size > MAX_XMP_BYTES) return;
      return this.storageRepository.readFile(path);
    });
    if (!data) return JobStatus.Skipped;
    const nodes = readDevelopXmp(data);
    const darktable = importDarktable(nodes);
    const lightroom = importLightroom(nodes);
    const recipe = darktable ?? lightroom;
    if (darktable && lightroom && recipe?.imported) recipe.imported.lightroom = lightroom.imported?.lightroom;
    if (!recipe) return JobStatus.Skipped;
    const checksum = createHash('sha256').update(asset.checksum).update(canonicalJson(recipe.imported)).digest('hex');
    const envelope = developEnvelope({ ...recipe, imported: { ...recipe.imported, checksum } });
    await this.develop.createImportedVersion(id, envelope, checksum, darktable ? 'darktable' : 'Lightroom');
    return JobStatus.Success;
  }
}
