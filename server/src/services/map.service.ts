import { Injectable } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  MapMarkerDto,
  MapMarkerResponseDto,
  MapReverseGeocodeDto,
  MapStatisticsResponseDto,
} from 'src/dtos/map.dto.js';
import { BaseService } from 'src/services/base.service.js';
import { getMyPartnerIds } from 'src/utils/asset.util.js';
import { getHiddenContentQueryOptions } from 'src/utils/hidden-content.js';
import { getLocationHiddenPartnerIds } from 'src/utils/partner-location.js';

@Injectable()
export class MapService extends BaseService {
  async getMapMarkers(auth: AuthDto, options: MapMarkerDto): Promise<MapMarkerResponseDto[]> {
    const userIds = [auth.user.id];
    if (options.withPartners) {
      // markers are pure location data, so partners who hide their locations contribute none
      const partnerIds = await getMyPartnerIds({
        userId: auth.user.id,
        repository: this.partnerRepository,
        locationSharedOnly: true,
      });
      userIds.push(...partnerIds);
    }

    const albumIds = options.withSharedAlbums ? await this.albumRepository.getAllIds(auth.user.id) : [];
    // FL-54: a shared album can hold items of an owner who hides their locations from this viewer
    const locationHiddenOwnerIds =
      albumIds.length > 0
        ? [...(await getLocationHiddenPartnerIds({ userId: auth.user.id, repository: this.partnerRepository }))]
        : [];

    return this.mapRepository.getMapMarkers(auth.user.id, userIds, albumIds, {
      ...options,
      ...getHiddenContentQueryOptions(auth),
      ...(locationHiddenOwnerIds.length > 0 && { locationHiddenOwnerIds }),
    });
  }

  /**
   * FL-51: the settings sheet's counts. Archived and unlocated items are the viewer's own; partner
   * items come only from partners who share their timeline and their locations with the viewer, as
   * the markers do. Hidden and Locked content follows the session, as for the markers.
   */
  async getMapStatistics(auth: AuthDto, options: MapMarkerDto): Promise<MapStatisticsResponseDto> {
    const partnerIds = await getMyPartnerIds({
      userId: auth.user.id,
      repository: this.partnerRepository,
      locationSharedOnly: true,
    });
    return this.mapRepository.getMapStatistics(auth.user.id, partnerIds, {
      isFavorite: options.isFavorite,
      fileCreatedAfter: options.fileCreatedAfter,
      fileCreatedBefore: options.fileCreatedBefore,
      ...getHiddenContentQueryOptions(auth),
    });
  }

  async reverseGeocode(dto: MapReverseGeocodeDto) {
    const { lat: latitude, lon: longitude } = dto;
    // eventually this should probably return an array of results
    const result = await this.mapRepository.reverseGeocode({ latitude, longitude });
    return result ? [result] : [];
  }
}
