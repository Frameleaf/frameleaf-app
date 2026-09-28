import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { DuplicateDecisionHistoryDto, DuplicateReviewGroupDto } from 'src/dtos/duplicate-review.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { DuplicateDecisionService } from 'src/services/duplicate-decision.service.js';

/**
 * The fast duplicate review (FL-61).
 *
 * Reads only. Decisions are made through durable bulk jobs (`POST /media-operations/bulk` with the
 * `resolve-duplicates` and `undo-duplicates` actions), so a review of thousands of groups survives
 * closing the browser and every decision is applied, retried and reported like any other bulk change.
 * Both reads are the signed-in account's own and nobody else's.
 */
@ApiTags(ApiTag.Duplicates)
@Controller('duplicates')
export class DuplicateReviewController {
  constructor(private service: DuplicateDecisionService) {}

  @Get('review')
  @Authenticated({ permission: Permission.DuplicateRead })
  @Endpoint({
    summary: 'Retrieve the duplicate review',
    description:
      'Your duplicate groups, each read as a whole: whether it holds copies of one photo or frames of a burst, the evidence behind the suggested keeper, and whether this session may decide it. A group with photos this session does not see, or with another account’s photo, is listed but cannot be decided.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getDuplicateReview(@Auth() auth: AuthDto): Promise<DuplicateReviewGroupDto[]> {
    return this.service.getReview(auth);
  }

  @Get('decisions')
  @Authenticated({ permission: Permission.DuplicateRead })
  @Endpoint({
    summary: 'Retrieve recent duplicate decisions',
    description:
      'Your most recent duplicate decision jobs, which can be undone while nothing has changed since, and the decision jobs still running.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getDuplicateDecisions(@Auth() auth: AuthDto): Promise<DuplicateDecisionHistoryDto> {
    return this.service.getHistory(auth);
  }
}
