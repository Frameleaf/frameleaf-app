import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  DevelopStyleApplyDto,
  DevelopStyleBatchDto,
  DevelopStyleDto,
  DevelopStyleUndoDto,
} from 'src/dtos/develop-style.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { DevelopStyleService } from 'src/services/develop-style.service.js';
import { UUIDParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.2.0').alpha('v3.2.0');

@ApiTags(ApiTag.StudioProjects)
@Controller('photography/style')
export class DevelopStyleController {
  constructor(private readonly service: DevelopStyleService) {}

  @Get()
  @Authenticated({ permission: Permission.AssetEditGet })
  @Endpoint({ summary: 'Read your photography style status', history: history() })
  getDevelopStyle(@Auth() auth: AuthDto): Promise<DevelopStyleDto> {
    return this.service.get(auth);
  }

  @Post()
  @Authenticated({ permission: Permission.AssetEditCreate })
  @Endpoint({ summary: 'Learn a photography style from your edits', history: history() })
  learnDevelopStyle(@Auth() auth: AuthDto): Promise<DevelopStyleDto> {
    return this.service.learn(auth);
  }

  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.AssetEditDelete })
  @Endpoint({ summary: 'Forget your photography style', history: history() })
  forgetDevelopStyle(@Auth() auth: AuthDto): Promise<void> {
    return this.service.forget(auth);
  }

  @Post('shoots/:id')
  @Authenticated({ permission: Permission.AssetEditCreate })
  @Endpoint({ summary: 'Queue inactive styled versions of shoot photos', history: history() })
  applyDevelopStyle(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: DevelopStyleApplyDto,
  ): Promise<DevelopStyleBatchDto> {
    return this.service.apply(auth, id, dto);
  }

  @Delete('batches/:id')
  @Authenticated({ permission: Permission.AssetEditDelete })
  @Endpoint({ summary: 'Undo an inactive styled batch', history: history() })
  undoDevelopStyle(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<DevelopStyleUndoDto> {
    return this.service.undo(auth, id);
  }
}
