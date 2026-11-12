import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  DateDoctorFindingsResponseDto,
  DateDoctorFixDto,
  DateDoctorPreviewResponseDto,
  DateFixBatchResponseDto,
} from 'src/dtos/date-doctor.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { DateDoctorService } from 'src/services/date-doctor.service.js';
import { UUIDv7ParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.4.0').alpha('v3.4.0');

/** FL-912: the Date & Time Doctor's findings, and a new scan. FL-930: fixing them, and undoing a fix. */
@ApiTags(ApiTag.MediaHealth)
@Controller('date-doctor')
export class DateDoctorController {
  constructor(private service: DateDoctorService) {}

  @Get('findings')
  @Authenticated({ permission: Permission.AssetRead })
  @Endpoint({
    summary: 'Get the Date & Time Doctor findings',
    description:
      'Your photos whose date or time zone looks wrong, with what the Doctor proposes and why, grouped by camera and day.',
    history: history(),
  })
  getDateDoctorFindings(@Auth() auth: AuthDto): Promise<DateDoctorFindingsResponseDto> {
    return this.service.getFindings(auth);
  }

  @Post('scan')
  @Authenticated({ permission: Permission.AssetRead })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Check dates again',
    description:
      'Look through your photos for wrong dates and time zones now. Nothing changes; the findings update when it ends.',
    history: history(),
  })
  scanDateDoctor(@Auth() auth: AuthDto): Promise<void> {
    return this.service.scan(auth);
  }

  @Post('preview')
  @Authenticated({ permission: Permission.AssetUpdate })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Preview a date fix',
    description:
      'What each photo would be dated after the fix: the Doctor’s proposals, or a time zone and shift for a selection. Nothing changes.',
    history: history(),
  })
  previewDateFix(@Auth() auth: AuthDto, @Body() dto: DateDoctorFixDto): Promise<DateDoctorPreviewResponseDto> {
    return this.service.preview(auth, dto);
  }

  @Post('apply')
  @Authenticated({ permission: Permission.AssetUpdate })
  @Endpoint({
    summary: 'Fix dates',
    description:
      'Give the photos their new dates and time zones, set as if by hand, and rewrite their sidecars. The original files never change. It can be undone for 30 days.',
    history: history(),
  })
  applyDateFix(@Auth() auth: AuthDto, @Body() dto: DateDoctorFixDto): Promise<DateFixBatchResponseDto> {
    return this.service.apply(auth, dto);
  }

  @Post('batches/:id/undo')
  @Authenticated({ permission: Permission.AssetUpdate })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Undo a date fix',
    description:
      'Put back the dates and time zones the photos had before the fix. A photo whose date was changed again since keeps that date.',
    history: history(),
  })
  undoDateFix(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<DateFixBatchResponseDto> {
    return this.service.undo(auth, id);
  }
}
