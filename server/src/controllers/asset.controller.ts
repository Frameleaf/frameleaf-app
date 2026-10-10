import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import { AssetResponseDto } from 'src/dtos/asset-response.dto.js';
import {
  AssetBulkDeleteDto,
  AssetBulkUpdateDto,
  AssetCopyDto,
  AssetImageEnrichmentActionRequestDto,
  AssetImageEnrichmentResponseDto,
  AssetJobsDto,
  AssetMetadataBulkDeleteDto,
  AssetMetadataBulkResponseDto,
  AssetMetadataBulkUpsertDto,
  AssetMetadataResponseDto,
  AssetMetadataRouteParams,
  AssetMetadataUpsertDto,
  AssetStatsDto,
  AssetStatsResponseDto,
  UpdateAssetDto,
} from 'src/dtos/asset.dto.js';
import {
  AssetEditKeyframesResponseDto,
  AssetEditsCreateDto,
  AssetEditsResponseDto,
  VideoEditExportDto,
  VideoEditVersionParamsDto,
  VideoEditVersionResponseDto,
} from 'src/dtos/editing.dto.js';
import { AssetOcrResponseDto } from 'src/dtos/ocr.dto.js';
import { ApiTag, Permission, RouteKey } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { AssetService } from 'src/services/asset.service.js';
import { ImageEnrichmentService } from 'src/services/image-enrichment.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
export class AssetController {
  constructor(
    private service: AssetService,
    private imageEnrichmentService: ImageEnrichmentService,
  ) {}

  @Get('statistics')
  @Authenticated({ permission: Permission.AssetStatistics })
  @Endpoint({
    summary: 'Get asset statistics',
    description: 'Retrieve various statistics about the assets owned by the authenticated user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getAssetStatistics(@Auth() auth: AuthDto, @Query() dto: AssetStatsDto): Promise<AssetStatsResponseDto> {
    return this.service.getStatistics(auth, dto);
  }

  @Post('jobs')
  @Authenticated({ permission: Permission.JobCreate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Run an asset job',
    description: 'Run a specific job on a set of assets.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  runAssetJobs(@Auth() auth: AuthDto, @Body() dto: AssetJobsDto): Promise<void> {
    return this.service.run(auth, dto);
  }

  @Put()
  @Authenticated({ permission: Permission.AssetUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Update assets',
    description: 'Updates multiple assets at the same time.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3', { replacementId: 'updateAssets' }),
  })
  updateAssets(@Auth() auth: AuthDto, @Body() dto: AssetBulkUpdateDto): Promise<void> {
    return this.service.updateAll(auth, dto);
  }

  @Patch()
  @ApiExcludeEndpoint()
  @Authenticated({ permission: Permission.AssetUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  updateAssetsV3(@Auth() auth: AuthDto, @Body() dto: AssetBulkUpdateDto): Promise<void> {
    return this.service.updateAll(auth, dto);
  }

  @Delete()
  @Authenticated({ permission: Permission.AssetDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete assets',
    description: 'Deletes multiple assets at the same time.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  deleteAssets(@Auth() auth: AuthDto, @Body() dto: AssetBulkDeleteDto): Promise<void> {
    return this.service.deleteAll(auth, dto);
  }

  @Post('lock')
  @Authenticated({ permission: Permission.AssetUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Lock assets',
    description:
      'Locks assets: they keep their albums and organization, are hidden from every view except the Locked view of their owner in a PIN-unlocked session, and stacks and live photos lock as a whole.',
    history: new HistoryBuilder().added('v3'),
  })
  lockAssets(@Auth() auth: AuthDto, @Body() dto: BulkIdsDto): Promise<void> {
    return this.service.lock(auth, dto);
  }

  @Post('unlock')
  @Authenticated({ permission: Permission.AssetUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Unlock assets',
    description:
      'Unlocks assets the caller owns, whatever locked them, returning each exactly where it was. Requires a PIN-unlocked session.',
    history: new HistoryBuilder().added('v3'),
  })
  unlockAssets(@Auth() auth: AuthDto, @Body() dto: BulkIdsDto): Promise<void> {
    return this.imageEnrichmentService.unlockAssets(auth, dto);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.AssetRead, sharedLink: true })
  @Endpoint({
    summary: 'Retrieve an asset',
    description: 'Retrieve detailed information about a specific asset.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getAssetInfo(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<AssetResponseDto> {
    return this.service.get(auth, id) as Promise<AssetResponseDto>;
  }

  @Get(':id/image-enrichment')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Get image enrichment metadata',
    description: 'Retrieve private image description, tag, and NSFW detection metadata for a specific asset.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  getAssetImageEnrichment(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
  ): Promise<AssetImageEnrichmentResponseDto> {
    return this.imageEnrichmentService.getAssetEnrichment(auth, id);
  }

  @Put(':id/image-enrichment')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Update image enrichment metadata',
    description: 'Run repair actions for generated image descriptions, tags, and NSFW detection metadata.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
  updateAssetImageEnrichment(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AssetImageEnrichmentActionRequestDto,
  ): Promise<AssetImageEnrichmentResponseDto> {
    return this.imageEnrichmentService.updateAssetEnrichment(auth, id, dto);
  }

  @Put('copy')
  @Authenticated({ permission: Permission.AssetCopy })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Copy asset',
    description: 'Copy asset information like albums, tags, etc. from one asset to another.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  copyAsset(@Auth() auth: AuthDto, @Body() dto: AssetCopyDto): Promise<void> {
    return this.service.copy(auth, dto);
  }

  @Put('metadata')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Upsert asset metadata',
    description: 'Upsert metadata key-value pairs for multiple assets.',
    history: new HistoryBuilder().added('v1').beta('v2.5.0'),
  })
  updateBulkAssetMetadata(
    @Auth() auth: AuthDto,
    @Body() dto: AssetMetadataBulkUpsertDto,
  ): Promise<AssetMetadataBulkResponseDto[]> {
    return this.service.upsertBulkMetadata(auth, dto);
  }

  @Delete('metadata')
  @Authenticated({ permission: Permission.AssetUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete asset metadata',
    description: 'Delete metadata key-value pairs for multiple assets.',
    history: new HistoryBuilder().added('v1').beta('v2.5.0'),
  })
  deleteBulkAssetMetadata(@Auth() auth: AuthDto, @Body() dto: AssetMetadataBulkDeleteDto): Promise<void> {
    return this.service.deleteBulkMetadata(auth, dto);
  }

  @Put(':id')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Update an asset',
    description: 'Update information of a specific asset.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3', { replacementId: 'updateAsset' }),
  })
  updateAsset(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: UpdateAssetDto,
  ): Promise<AssetResponseDto> {
    return this.service.update(auth, id, dto);
  }

  @Patch(':id')
  @ApiExcludeEndpoint()
  @Authenticated({ permission: Permission.AssetUpdate })
  updateAssetV3(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: UpdateAssetDto,
  ): Promise<AssetResponseDto> {
    return this.service.update(auth, id, dto);
  }

  @Get(':id/metadata')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Get asset metadata',
    description: 'Retrieve all metadata key-value pairs associated with the specified asset.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getAssetMetadata(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<AssetMetadataResponseDto[]> {
    return this.service.getMetadata(auth, id);
  }

  @Get(':id/ocr')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Retrieve asset OCR data',
    description: 'Retrieve all OCR (Optical Character Recognition) data associated with the specified asset.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getAssetOcr(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<AssetOcrResponseDto[]> {
    return this.service.getOcr(auth, id);
  }

  @Put(':id/metadata')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Update asset metadata',
    description: 'Update or add metadata key-value pairs for the specified asset.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  updateAssetMetadata(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AssetMetadataUpsertDto,
  ): Promise<AssetMetadataResponseDto[]> {
    return this.service.upsertMetadata(auth, id, dto);
  }

  @Get(':id/metadata/:key')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Retrieve asset metadata by key',
    description: 'Retrieve the value of a specific metadata key associated with the specified asset.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getAssetMetadataByKey(
    @Auth() auth: AuthDto,
    @Param() { id, key }: AssetMetadataRouteParams,
  ): Promise<AssetMetadataResponseDto> {
    return this.service.getMetadataByKey(auth, id, key);
  }

  @Delete(':id/metadata/:key')
  @Authenticated({ permission: Permission.AssetUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete asset metadata by key',
    description: 'Delete a specific metadata key-value pair associated with the specified asset.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  deleteAssetMetadata(@Auth() auth: AuthDto, @Param() { id, key }: AssetMetadataRouteParams): Promise<void> {
    return this.service.deleteMetadataByKey(auth, id, key);
  }

  @Get(':id/edits')
  @Authenticated({ permission: Permission.AssetEditGet })
  @Endpoint({
    summary: 'Retrieve edits for an existing asset',
    description: 'Retrieve a series of edit actions (crop, rotate, mirror) associated with the specified asset.',
    history: new HistoryBuilder().added('v2.5.0').beta('v2.5.0'),
  })
  getAssetEdits(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<AssetEditsResponseDto> {
    return this.service.getAssetEdits(auth, id);
  }

  @Get(':id/edits/keyframes')
  @Authenticated({ permission: Permission.AssetEditGet })
  @Endpoint({
    summary: "List the original video's keyframes",
    description:
      "The keyframe times of the original video, so an editor can show where a fast (keyframe) trim actually cuts. Owner's edit permission only; never the edited version.",
    history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0'),
  })
  getAssetEditKeyframes(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<AssetEditKeyframesResponseDto> {
    return this.service.getAssetEditKeyframes(auth, id);
  }

  @Put(':id/edits')
  @Authenticated({ permission: Permission.AssetEditCreate })
  @Endpoint({
    summary: 'Apply edits to an existing asset',
    description: 'Apply a series of edit actions (crop, rotate, mirror) to the specified asset.',
    history: new HistoryBuilder().added('v2.5.0').beta('v2.5.0'),
  })
  editAsset(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AssetEditsCreateDto,
  ): Promise<AssetEditsResponseDto> {
    return this.service.editAsset(auth, id, dto);
  }

  @Get(':id/edit-versions')
  @Authenticated({ permission: Permission.AssetEditGet })
  @Endpoint({ summary: 'List saved video versions', history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0') })
  getVideoEditVersions(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<VideoEditVersionResponseDto[]> {
    return this.service.getVideoEditVersions(auth, id);
  }

  @Post(':id/edit-versions/export')
  @Authenticated({ permission: Permission.AssetEditCreate })
  @Endpoint({
    summary: 'Export the current video version',
    history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0'),
  })
  exportVideoEditVersion(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() _dto: VideoEditExportDto,
  ): Promise<VideoEditVersionResponseDto> {
    return this.service.exportVideoEditVersion(auth, id);
  }

  @Post(':id/edit-versions/:versionId/restore')
  @Authenticated({ permission: Permission.AssetEditCreate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({ summary: 'Restore a saved video version', history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0') })
  restoreVideoEditVersion(@Auth() auth: AuthDto, @Param() { id, versionId }: VideoEditVersionParamsDto): Promise<void> {
    return this.service.restoreVideoEditVersion(auth, id, versionId);
  }

  @Delete(':id/edit-versions/:versionId')
  @Authenticated({ permission: Permission.AssetEditDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Prune an unselected video version',
    history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0'),
  })
  pruneVideoEditVersion(@Auth() auth: AuthDto, @Param() { id, versionId }: VideoEditVersionParamsDto): Promise<void> {
    return this.service.pruneVideoEditVersion(auth, id, versionId);
  }

  @Delete(':id/edits')
  @Authenticated({ permission: Permission.AssetEditDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Remove edits from an existing asset',
    description: 'Removes all edit actions (crop, rotate, mirror) associated with the specified asset.',
    history: new HistoryBuilder().added('v2.5.0').beta('v2.5.0'),
  })
  removeAssetEdits(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.removeAssetEdits(auth, id);
  }
}
