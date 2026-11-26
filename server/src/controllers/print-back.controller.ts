import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { PrintBackResponseDto, PrintBackUpdateDto } from 'src/dtos/print-back.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { PrintBackService } from 'src/services/print-back.service.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.Assets)
@Controller('assets')
export class PrintBackController {
  constructor(private service: PrintBackService) {}

  @Get(':id/print-back')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Read the back of a print',
    description:
      "The text on the back of this photo's print, with the owner's corrections, for anyone who can read the photo's own text. Only the owner is told which asset the back is. Shared links do not reach this.",
    history: new HistoryBuilder().added('v3'),
  })
  getPrintBack(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<PrintBackResponseDto> {
    return this.service.get(auth, id);
  }

  @Put(':id/print-back')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Pair or unpair the back of a print',
    description:
      'With a backAssetId, hides that scan behind this photo and reads its text. With null, removes the back and returns it to where it was (timeline, archive or Locked). Both must be your own photos. A Locked photo pairs only with another Locked photo.',
    history: new HistoryBuilder().added('v3'),
  })
  updatePrintBack(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: PrintBackUpdateDto,
  ): Promise<PrintBackResponseDto> {
    return this.service.update(auth, id, dto);
  }
}
