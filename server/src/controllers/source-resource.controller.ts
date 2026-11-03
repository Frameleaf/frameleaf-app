import { Body, Controller, Header, Post } from '@nestjs/common';
import { ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { SourceGrantDto, SourceGrantRequestDto } from 'src/dtos/source-resource.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { SourceResourceAuthService } from 'src/services/source-resource-auth.service.js';

@ApiTags(ApiTag.Libraries)
@Controller('source-resources')
export class SourceResourceController {
  constructor(private auth: SourceResourceAuthService) {}

  @Post('grants')
  @Header('Cache-Control', 'private, no-store')
  @Authenticated({ permission: Permission.AssetUpload })
  @ApiResponse({ status: 201, type: SourceGrantDto })
  @Endpoint({
    summary: 'Issue a source-only credential for an approved desktop reference source',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  createSourceResourceGrant(@Auth() auth: AuthDto, @Body() dto: SourceGrantRequestDto): Promise<SourceGrantDto> {
    return this.auth.issue(auth, dto);
  }
}
