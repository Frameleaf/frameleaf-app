import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  ScanSplitDetectResponseDto,
  ScanSplitDto,
  ScanSplitInfoResponseDto,
  ScanSplitOfferResponseDto,
} from 'src/dtos/scan-split.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { ScanSplitService } from 'src/services/scan-split.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Assets)
@Controller('assets')
export class ScanSplitController {
  constructor(private service: ScanSplitService) {}

  @Get(':id/scan-split')
  @Authenticated({ permission: Permission.AssetEditGet })
  @Endpoint({
    summary: 'Read how a photo relates to a split scan',
    description:
      'For a scan, the photos cut from it and which of them a new split would keep. For a photo cut from a scan, that scan. Owner only.',
    history: new HistoryBuilder().added('v3'),
  })
  getScanSplit(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<ScanSplitInfoResponseDto> {
    return this.service.getInfo(auth, id);
  }

  @Post(':id/scan-split/offer')
  @HttpCode(200)
  @Authenticated({ permission: Permission.AssetEditGet })
  @Endpoint({
    summary: 'Check an upload to an album that holds scans',
    description:
      'Counts the prints on a photo that is in an album marked as holding scans and has not been split. Any other photo answers 0 without being looked at. Nothing is split or saved.',
    history: new HistoryBuilder().added('v3'),
  })
  offerScanSplit(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<ScanSplitOfferResponseDto> {
    return this.service.offer(auth, id);
  }

  @Post(':id/scan-split/detect')
  @HttpCode(200)
  @Authenticated({ permission: Permission.AssetEditGet })
  @Endpoint({
    summary: 'Find the separate prints on a flatbed scan',
    description:
      'Looks for the prints lying on a scan and answers their corners in the pixels of the scan as it is displayed. Nothing is saved; the owner reviews the corners and sends them to the split endpoint.',
    history: new HistoryBuilder().added('v3'),
  })
  detectScanPrints(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<ScanSplitDetectResponseDto> {
    return this.service.detect(auth, id);
  }

  @Post(':id/scan-split')
  @HttpCode(204)
  @Authenticated({ permission: Permission.AssetEditCreate })
  @Endpoint({
    summary: 'Split a flatbed scan into separate photos',
    description:
      'Queues the work that cuts each confirmed print out of the scan at full resolution, straightened and turned, as a new photo of the scan owner. The scan is kept and moved to the archive. Splitting a scan again replaces the photos of an earlier split that were not edited since (they go to the trash) and keeps the edited ones.',
    history: new HistoryBuilder().added('v3'),
  })
  splitScan(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Body() dto: ScanSplitDto): Promise<void> {
    return this.service.split(auth, id, dto);
  }
}
