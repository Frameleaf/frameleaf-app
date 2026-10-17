import { Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetResponseDto, mapAsset } from 'src/dtos/asset-response.dto.js';
import { FolderSummaryResponseDto } from 'src/dtos/view.dto.js';
import { BaseService } from 'src/services/base.service.js';
import { asDateTimeString } from 'src/utils/date.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';

@Injectable()
export class ViewService extends BaseService {
  getUniqueOriginalPaths(auth: AuthDto): Promise<string[]> {
    return this.viewRepository.getUniqueOriginalPaths(auth.user.id, getHiddenContentQueryOptions(auth));
  }

  async getAssetsByOriginalPath(auth: AuthDto, path: string): Promise<AssetResponseDto[]> {
    const assets = await this.viewRepository.getAssetsByOriginalPath(
      auth.user.id,
      path,
      getHiddenContentQueryOptions(auth),
    );
    return assets.map((asset) => mapAsset(asset, { auth }));
  }

  /**
   * FL-46: each folder's direct file count and bytes, with a cover and the dates of those files, in the
   * scope the two folder views list.
   */
  async getFolderSummary(auth: AuthDto): Promise<FolderSummaryResponseDto[]> {
    const rows = await this.viewRepository.getFolderSummary(auth.user.id, getHiddenContentQueryOptions(auth));
    return rows.map(({ startDate, endDate, ...row }) => ({
      ...row,
      startDate: asDateTimeString(startDate),
      endDate: asDateTimeString(endDate),
    }));
  }
}
