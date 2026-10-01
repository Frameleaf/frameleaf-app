import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  ICloudClaimDto,
  ICloudClaimReleaseDto,
  ICloudClaimReleaseResponseDto,
  ICloudClaimRenewDto,
  ICloudClaimRenewResponseDto,
  ICloudClaimResponseDto,
  ICloudCoverageDto,
  ICloudCoverageResponseDto,
  ICloudLookupDto,
  ICloudLookupResponseDto,
} from 'src/dtos/icloud-identity.dto.js';
import { Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { ICloudIdentityService } from 'src/services/icloud-identity.service.js';

/** FL-296 (NAPI-014): iCloud source identity, shared by iCloud Photos Sync and the native app. */
@ApiTags('ICloud Sync')
@Controller('icloud-sync')
export class ICloudIdentityController {
  constructor(private service: ICloudIdentityService) {}

  @Post('coverage')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Does a sync connection cover this device library?',
    description:
      "Up to 200 sampled items from the device. For each of the caller's own connections: its state, scope and how many of the samples that existed before its last complete inventory it holds. A connection covers the library with at least 20 such samples and 95 % matched (corroborated or better). PhotoKit cannot tell which Apple Account is signed in, so overlap is the only proof.",
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  probeICloudCoverage(@Auth() auth: AuthDto, @Body() dto: ICloudCoverageDto): Promise<ICloudCoverageResponseDto> {
    return this.service.coverage(auth, dto);
  }

  @Post('identities/lookup')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Is this iCloud item on the server, or coming from the sync?',
    description:
      "Up to 1000 items. For each item and role: on-server (with who delivered it and how it was verified), sync-pending, out-of-scope, unknown or review; and who delivers its edit renders. Only the caller's own assets and connections, with the safety lookup's Locked and hidden rules. A hint is reported but never counts as on-server.",
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  lookupICloudIdentities(@Auth() auth: AuthDto, @Body() dto: ICloudLookupDto): Promise<ICloudLookupResponseDto> {
    return this.service.lookup(auth, dto);
  }

  @Post('claims')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Claim iCloud items for this device to fetch and upload',
    description:
      "Up to 500 items. A claim covers the whole item (still, Live Photo motion, RAW and the current edit) for 10 minutes, renewable to 4 hours. An item a healthy sync connection covers is the sync's to fetch; one an unhealthy connection covers is the device's after 72 hours, or at once with takeOver. An upload naming an item someone else claimed is refused with 409 icloud_claimed. The device key must be one of the caller's backup devices.",
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  claimICloudItems(@Auth() auth: AuthDto, @Body() dto: ICloudClaimDto): Promise<ICloudClaimResponseDto> {
    return this.service.claim(auth, dto);
  }

  @Post('claims/renew')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Renew iCloud claims this device holds',
    description:
      'Extends live claims, never past 4 hours from when each was taken; a claim missing from the answer is lost.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  renewICloudClaims(@Auth() auth: AuthDto, @Body() dto: ICloudClaimRenewDto): Promise<ICloudClaimRenewResponseDto> {
    return this.service.renewClaims(auth, dto);
  }

  @Post('claims/release')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Release iCloud claims this device holds',
    description: 'Gives the items back, for example when the device stops before uploading them.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  releaseICloudClaims(
    @Auth() auth: AuthDto,
    @Body() dto: ICloudClaimReleaseDto,
  ): Promise<ICloudClaimReleaseResponseDto> {
    return this.service.releaseClaims(auth, dto);
  }
}
