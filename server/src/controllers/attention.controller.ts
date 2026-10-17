import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { AttentionResponseDto } from 'src/dtos/attention.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Authenticated } from 'src/middleware/auth.guard.js';
import { AttentionService } from 'src/services/attention.service.js';

@ApiTags(ApiTag.Attention)
@Controller('admin/attention')
export class AttentionController {
  constructor(private service: AttentionService) {}

  // FL-421: the Notifications page "What needs your attention", and the Overview's list (FL-363).
  @Get()
  @Authenticated({ permission: Permission.ServerStatistics, admin: true })
  @Endpoint({
    summary: 'Get what needs attention',
    description:
      'What needs an administrator on this server now: the drive the library is on filling up, a missed backup, background work that stopped, or a new version. Worked out from the server’s own records on every read.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
  getAttention(): Promise<AttentionResponseDto> {
    return this.service.getAttention();
  }
}
