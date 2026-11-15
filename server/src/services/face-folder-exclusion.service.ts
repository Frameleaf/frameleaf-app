import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  FaceFolderExclusionCreateDto,
  FaceFolderExclusionCreateResponseDto,
  FaceFolderExclusionPreviewQueryDto,
  FaceFolderExclusionPreviewResponseDto,
  FaceFolderExclusionResponseDto,
} from 'src/dtos/face-folder-exclusion.dto.js';
import { JobName } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { PersonService } from 'src/services/person.service.js';
import { asDateTimeString } from 'src/utils/date.js';
import { normaliseFaceFolderPrefix } from 'src/utils/face-folder-exclusion.js';

type ExclusionRow = { id: string; pathPrefix: string; createdAt: Date | string };

const mapExclusion = ({ id, pathPrefix, createdAt }: ExclusionRow): FaceFolderExclusionResponseDto => ({
  id,
  pathPrefix,
  createdAt: asDateTimeString(createdAt),
});

/**
 * FL-934: folders whose photos an owner leaves out of face recognition. Each owner keeps their own list, matched
 * against their own photos only. Leaving a folder out removes the faces no one confirmed from its photos; taking
 * it back in finds faces there again.
 */
@Injectable()
export class FaceFolderExclusionService extends BaseService {
  async getAll(auth: AuthDto): Promise<FaceFolderExclusionResponseDto[]> {
    const rows = await this.personRepository.getFaceFolderExclusions(auth.user.id);
    return rows.map((row) => mapExclusion(row));
  }

  async preview(
    auth: AuthDto,
    dto: FaceFolderExclusionPreviewQueryDto,
  ): Promise<FaceFolderExclusionPreviewResponseDto> {
    const pathPrefix = this.requirePrefix(dto.pathPrefix);
    const counts = await this.personRepository.getFaceFolderPreview(auth.user.id, pathPrefix);
    return { pathPrefix, ...counts };
  }

  async create(auth: AuthDto, dto: FaceFolderExclusionCreateDto): Promise<FaceFolderExclusionCreateResponseDto> {
    const ownerId = auth.user.id;
    const pathPrefix = this.requirePrefix(dto.pathPrefix);
    const exclusion = await this.personRepository.createFaceFolderExclusion(ownerId, pathPrefix);

    const removed = await this.personRepository.withMergeWrite(
      () => this.personRepository.removeUnconfirmedFolderFaces(ownerId, pathPrefix),
      ownerId,
    );
    // the photos' faces are settled, so the overnight check does not queue them
    await this.personRepository.markFaceFolderExcludedDetected(ownerId);

    if (removed.faceCount > 0) {
      this.logger.log(`Removed ${removed.faceCount} unconfirmed faces from ${removed.assetIds.length} assets`);
      if (removed.featured.length > 0) {
        await BaseService.create(PersonService, this).createNewFeaturePhoto(removed.featured);
      }
      await this.emitAssetsChanged(removed.assetIds);
      await this.jobRepository.queueAll([
        ...removed.assetIds.map((id) => ({ name: JobName.SidecarWrite, data: { id, facesOnly: true } }) as const),
        { name: JobName.PersonIdentityRefresh, data: { ownerId, assetIds: removed.assetIds } },
        // people left with no faces go
        { name: JobName.PersonCleanup },
      ]);
    }

    return { ...mapExclusion(exclusion), removedFaceCount: removed.faceCount };
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    const ownerId = auth.user.id;
    const exclusion = await this.personRepository.deleteFaceFolderExclusion(ownerId, id);
    if (!exclusion) {
      throw new NotFoundException('Folder exclusion not found');
    }
    // photos still in another excluded folder of the owner's stay out
    await this.personRepository.resetFaceFolderDetected(ownerId, exclusion.pathPrefix);
    await this.jobRepository.queueSelection(
      JobName.AssetDetectFaces,
      this.assetJobRepository.selectionForFaceFolderDetection(ownerId, exclusion.pathPrefix),
    );
  }

  private requirePrefix(input: string): string {
    const prefix = normaliseFaceFolderPrefix(input);
    if (!prefix) {
      throw new BadRequestException('Choose a folder: an absolute path other than the top-level folder');
    }
    return prefix;
  }
}
