import { Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { UtilitiesSummaryResponseDto } from 'src/dtos/utilities.dto.js';
import { BaseService } from 'src/services/base.service.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { mimeTypes } from 'src/utils/mime-types.js';

@Injectable()
export class UtilitiesService extends BaseService {
  /**
   * FL-519: each tool's count for the Utilities directory. The server-wide checks (missing and damaged
   * files) are only counted for an administrator, as only they can open those tools. FL-416: Unused files
   * is the server owner's alone (the first administrator), so its count is null for everyone else; the
   * web reads that as "do not show Unused files".
   */
  async getSummary(auth: AuthDto): Promise<UtilitiesSummaryResponseDto> {
    const ownerId = auth.user.id;
    const [duplicateGroups, withoutPlace] = await Promise.all([
      this.duplicateRepository.countGroupsForOwner(ownerId),
      this.mapRepository
        .getMapStatistics(ownerId, [], getHiddenContentQueryOptions(auth))
        .then(({ unlocated }) => unlocated),
    ]);
    if (!auth.user.isAdmin) {
      return {
        duplicateGroups,
        withoutPlace,
        missingFiles: null,
        damagedFiles: null,
        unusedFiles: null,
        unusedBytes: null,
      };
    }
    const [findings, unused] = await Promise.all([
      this.integrityRepository.getFindingsOverview(Object.keys(mimeTypes.raw)),
      this.isServerOwner(auth).then((owner) =>
        owner ? this.physicalFileTrashRepository.list({ skip: 0, take: 0, lockedOwnerId: ownerId }) : null,
      ),
    ]);
    return {
      duplicateGroups,
      withoutPlace,
      missingFiles: findings.missing,
      damagedFiles: findings.damaged,
      unusedFiles: unused ? unused.total : null,
      unusedBytes: unused ? Math.round(unused.totalBytes) : null,
    };
  }
}
