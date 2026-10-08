import { Body, Controller, Get, Header, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  ICloudAttachDto,
  ICloudAttachResponseDto,
  ICloudClaimDto,
  ICloudClaimReleaseDto,
  ICloudClaimReleaseResponseDto,
  ICloudClaimRenewDto,
  ICloudClaimRenewResponseDto,
  ICloudClaimResponseDto,
  ICloudCoverageDto,
  ICloudCoverageResponseDto,
  ICloudEditBaselineDto,
  ICloudEditDecisionResponseDto,
  ICloudEditEvidenceQueryDto,
  ICloudEditEvidenceResponseDto,
  ICloudEditSuccessorDto,
  ICloudLookupDto,
  ICloudLookupResponseDto,
  ICloudVerifyDto,
  ICloudVerifyResponseDto,
} from 'src/dtos/icloud-identity.dto.js';
import { Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { ICloudAuditService } from 'src/services/icloud-audit.service.js';
import { ICloudIdentityService } from 'src/services/icloud-identity.service.js';

/** FL-296 (NAPI-014): iCloud source identity, shared by iCloud Photos Sync and the native app. */
@ApiTags('ICloud Sync')
@Controller('icloud-sync')
export class ICloudIdentityController {
  constructor(
    private service: ICloudIdentityService,
    private audits: ICloudAuditService,
  ) {}

  @Get('edits/evidence')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetRead, refreshElevation: false })
  @Endpoint({
    summary: 'Discover owned edit evidence and administrative authority',
    description:
      'Complete bounded owner-session snapshot. Receipts are current owned bytes; administrative authority is not provider chronology. Incoming eligibility is a snapshot, never admission permission. Oversized or inaccessible evidence requires review.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  discoverICloudEditEvidence(
    @Auth() auth: AuthDto,
    @Query() dto: ICloudEditEvidenceQueryDto,
  ): Promise<ICloudEditEvidenceResponseDto> {
    return this.service.discoverEditEvidence(auth, dto.assetId);
  }

  @Post('edits/baseline')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Accept an administrative edit-owner baseline',
    description:
      'Owner session only. Explicitly accepts a stored owned digest receipt as a handover watermark. This is an administrative decision, not Apple revision ordering or byte-equivalence proof. Healthy sync authority and live competing item claims remain protected; takeOver only bypasses the wait for an unhealthy source. Locked and hidden evidence requires current access. Optional original-revert intent explicitly changes local primary against the current immutable publication with the selected retention policy; without intent this remains administrative and cannot reinterpret an existing publication.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  acceptICloudEditBaseline(
    @Auth() auth: AuthDto,
    @Body() dto: ICloudEditBaselineDto,
  ): Promise<ICloudEditDecisionResponseDto> {
    return this.service.acceptEditBaseline(auth, dto);
  }

  @Post('edits/successor')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Accept verified bytes as an administrative edit successor',
    description:
      'Owner session only. Accepts one existing verified device or sync resource at the current owner generation and canonical version. No timestamp/hash ordering is inferred. First publication rechecks the decision, digest, live holder claim, item capacity and access; an already committed result remains eligible for settlement after takeover. Keep is the default. Supersede explicitly binds the current local publication, verified eligible render set, effective config and owner-local policy sequence; first publication refuses changed policy, privacy or authority. Accepted decisions, committed bytes, queued effects and delivered effects are distinct.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  acceptICloudEditSuccessor(
    @Auth() auth: AuthDto,
    @Body() dto: ICloudEditSuccessorDto,
  ): Promise<ICloudEditDecisionResponseDto> {
    return this.service.acceptEditSuccessor(auth, dto);
  }

  @Post('identities/verify')
  @HttpCode(HttpStatus.ACCEPTED)
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Download and verify named iCloud originals',
    description:
      'Owner sessions only. Queues fresh source-byte SHA-256 verification of current in-scope identities. Queued is not verified; results appear in identity lookup. Mismatches preserve the original and import a separate managed copy for review. Request keys replay the original complete batch outcomes.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  verifyICloudIdentities(@Auth() auth: AuthDto, @Body() dto: ICloudVerifyDto): Promise<ICloudVerifyResponseDto> {
    return this.audits.submit(auth, dto);
  }

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

  @Post('identities/attach')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Attach iCloud identities to originals already uploaded by this device',
    description:
      "Up to 500 resources from one of the caller's registered backup devices. Each attachment requires the device SHA-256 to equal the current original of an active asset the caller owns, with the safety lookup's Locked and hidden rules. Unknown, inaccessible and mismatched assets all answer unavailable. Identifiers remain hints until corroborated; attachment never marks an audit verified or changes media.",
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  attachICloudIdentities(@Auth() auth: AuthDto, @Body() dto: ICloudAttachDto): Promise<ICloudAttachResponseDto> {
    return this.service.attach(auth, dto);
  }

  @Post('claims')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ permission: Permission.AssetUpload })
  @Endpoint({
    summary: 'Claim iCloud items for this device to fetch and upload',
    description:
      "Up to 500 items. A claim covers the whole item (still, Live Photo motion, RAW and the current edit) for 10 minutes, renewable to 4 hours. An item a healthy sync connection covers is the sync's to fetch; one an unhealthy connection covers is the device's after 72 hours, or at once with takeOver. An upload naming an item someone else claimed is refused with 409 icloud_claimed. Send each item's filename and capture date: without them the server cannot confirm a sync covers it. The claim stays until it is released or runs out, so all of an item's roles come from one path. The device key must be one of the caller's backup devices.",
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
