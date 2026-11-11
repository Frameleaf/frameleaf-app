import { Controller, Get, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { DateDoctorFindingsResponseDto } from 'src/dtos/date-doctor.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { DateDoctorService } from 'src/services/date-doctor.service.js';

const history = () => new HistoryBuilder().added('v3.4.0').alpha('v3.4.0');

/** FL-912: the Date & Time Doctor's findings, and a new scan. Fixing them is FL-930. */
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
}
