import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { AssetResponseDto } from 'src/dtos/asset-response.dto.js';
import { FolderAssetsDto, FolderSummaryResponseDto } from 'src/dtos/view.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { ViewService } from 'src/services/view.service.js';

@ApiTags(ApiTag.Views)
@Controller('view')
export class ViewController {
  constructor(private service: ViewService) {}

  @Get('folder/unique-paths')
  @Authenticated({ permission: Permission.FolderRead })
  @Endpoint({
    summary: 'Retrieve unique paths',
    description: 'Retrieve a list of unique folder paths from asset original paths.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getUniqueOriginalPaths(@Auth() auth: AuthDto): Promise<string[]> {
    return this.service.getUniqueOriginalPaths(auth);
  }

  @Get('folder/summary')
  @Authenticated({ permission: Permission.FolderRead })
  @Endpoint({
    summary: 'Retrieve folder summaries',
    description:
      'Retrieve, for each folder, how many originals it holds directly and their size in bytes, counting only the Timeline items the folder views list.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getFolderSummary(@Auth() auth: AuthDto): Promise<FolderSummaryResponseDto[]> {
    return this.service.getFolderSummary(auth);
  }

  @Get('folder')
  @Authenticated({ permission: Permission.FolderRead })
  @Endpoint({
    summary: 'Retrieve assets by original path',
    description:
      'Retrieve assets that are children of a specific folder. Pass take (and after, from the second page on) to read a large folder a page at a time.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .updated('v3.5.0', 'Added take and after, to read a folder a page at a time'),
  })
  getAssetsByOriginalPath(@Auth() auth: AuthDto, @Query() dto: FolderAssetsDto): Promise<AssetResponseDto[]> {
    return this.service.getAssetsByOriginalPath(auth, dto.path, dto);
  }
}
