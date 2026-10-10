import { Body, Controller, Get, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { StudioWorkspaceDto, StudioWorkspaceSaveDto } from 'src/dtos/studio-project.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { StudioWorkspaceService } from 'src/services/studio-workspace.service.js';

/**
 * The signed-in account's Studio workspace layout (FL-91, `STU-204`): stored on the server so it
 * works in every browser without File System Access, and follows the person between devices.
 */
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/workspace')
export class StudioWorkspaceController {
  constructor(private service: StudioWorkspaceService) {}

  @Get()
  @Authenticated()
  @Endpoint({
    summary: 'Get your Studio workspace layout',
    description: 'The editor layout you last saved, or nulls when you have none. Only ever your own.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getStudioWorkspace(@Auth() auth: AuthDto): Promise<StudioWorkspaceDto> {
    return this.service.get(auth);
  }

  @Put()
  @Authenticated()
  @Endpoint({
    summary: 'Save your Studio workspace layout',
    description:
      'Replaces your stored editor layout. The layout is stored as JSON and returned as the same value (key order and spacing are not kept), up to 256 KiB.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  saveStudioWorkspace(@Auth() auth: AuthDto, @Body() dto: StudioWorkspaceSaveDto): Promise<StudioWorkspaceDto> {
    return this.service.save(auth, dto);
  }
}
