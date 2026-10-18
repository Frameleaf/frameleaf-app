import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  LibraryMovePauseDto,
  LibraryMovePauseStatusDto,
  LibraryMoveResumeDto,
} from 'src/dtos/frameleaf-library-move.dto.js';
import { ApiTag } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { MANAGER_TOKEN_HEADER } from 'src/middleware/frameleaf-via.middleware.js';
import { FrameleafLibraryMoveService } from 'src/services/frameleaf-library-move.service.js';
import { FrameleafLibrarySetupService } from 'src/services/frameleaf-library-setup.service.js';

const history = new HistoryBuilder().added('v3.2.0').alpha('v3.2.0');

/** FL-360: the Frameleaf Manager's machine-authenticated pause for a library move. */
@ApiTags(ApiTag.Server)
@Controller('server/library-move/manager')
export class FrameleafLibraryMoveController {
  constructor(
    private move: FrameleafLibraryMoveService,
    private setup: FrameleafLibrarySetupService,
  ) {}

  @Get()
  @Authenticated({ public: true })
  @Endpoint({
    operationId: 'getManagerLibraryMovePause',
    summary: 'Manager machine-authenticated library move pause status (renews the named operation)',
    history,
  })
  async status(
    @Headers(MANAGER_TOKEN_HEADER) token?: string,
    @Query('operationId') operationId?: string,
  ): Promise<LibraryMovePauseStatusDto> {
    await this.setup.authorizeManager(token);
    return this.move.status(typeof operationId === 'string' && operationId ? operationId : undefined);
  }

  @Post('pause')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ public: true })
  @Endpoint({
    operationId: 'pauseManagerLibraryMove',
    summary: 'Manager machine-authenticated pause of uploads, changes and job queues for a library move',
    history,
  })
  async pause(
    @Headers(MANAGER_TOKEN_HEADER) token: string | undefined,
    @Body() dto: LibraryMovePauseDto,
  ): Promise<LibraryMovePauseStatusDto> {
    await this.setup.authorizeManager(token);
    return this.move.pause(dto.operationId);
  }

  @Post('resume')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ public: true })
  @Endpoint({
    operationId: 'resumeManagerLibraryMove',
    summary: 'Manager machine-authenticated resume after a library move',
    history,
  })
  async resume(
    @Headers(MANAGER_TOKEN_HEADER) token: string | undefined,
    @Body() dto: LibraryMoveResumeDto,
  ): Promise<LibraryMovePauseStatusDto> {
    await this.setup.authorizeManager(token);
    return this.move.resume(dto.operationId);
  }
}

/** FL-360: an administrator can see a library move pause and lift one the Manager left behind. */
@ApiTags(ApiTag.Server)
@Controller('admin/library-move')
export class FrameleafLibraryMoveAdminController {
  constructor(private move: FrameleafLibraryMoveService) {}

  @Get()
  @Authenticated({ admin: true })
  @Endpoint({ operationId: 'getLibraryMovePause', summary: 'Library move pause status', history })
  status(): Promise<LibraryMovePauseStatusDto> {
    return this.move.status();
  }

  @Post('resume')
  @HttpCode(HttpStatus.OK)
  @Authenticated({ admin: true })
  @Endpoint({
    operationId: 'resumeLibraryMovePause',
    summary: 'Lift a library move pause (uploads, changes and job queues resume)',
    history,
  })
  resume(): Promise<LibraryMovePauseStatusDto> {
    return this.move.resume();
  }
}
