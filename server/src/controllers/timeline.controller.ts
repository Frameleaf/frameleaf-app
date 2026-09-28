import { Controller, Get, Header, Query } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  TimeBucketAssetDto,
  TimeBucketAssetResponseDto,
  TimeBucketDto,
  TimelineHighlightResponseDto,
  TimelineHighlightsDto,
  TimelineOrderedDto,
} from 'src/dtos/time-bucket.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { TimelineService } from 'src/services/timeline.service.js';

@ApiTags(ApiTag.Timeline)
@Controller('timeline')
export class TimelineController {
  constructor(private service: TimelineService) {}

  @Get('buckets')
  @Authenticated({ permission: Permission.AssetRead, sharedLink: true })
  @Endpoint({
    summary: 'Get time buckets',
    description: 'Retrieve a list of all minimal time buckets.',
    history: new HistoryBuilder().added('v1').internal('v1'),
  })
  getTimeBuckets(@Auth() auth: AuthDto, @Query() dto: TimeBucketDto) {
    return this.service.getTimeBuckets(auth, dto);
  }

  @Get('bucket')
  @Authenticated({ permission: Permission.AssetRead, sharedLink: true })
  @ApiOkResponse({ type: TimeBucketAssetResponseDto })
  @Header('Content-Type', 'application/json')
  @Endpoint({
    summary: 'Get time bucket',
    description: 'Retrieve a string of all asset ids in a given time bucket.',
    history: new HistoryBuilder().added('v1').internal('v1'),
  })
  getTimeBucket(@Auth() auth: AuthDto, @Query() dto: TimeBucketAssetDto) {
    return this.service.getTimeBucket(auth, dto);
  }

  // Public (shared link) pages never sort, and an order by file name or rating could reveal metadata
  // a link that hides EXIF withholds, so shared links may not call this route.
  @Get('ordered')
  @Authenticated({ permission: Permission.AssetRead })
  @ApiOkResponse({ type: TimeBucketAssetResponseDto })
  @Header('Content-Type', 'application/json')
  @Endpoint({
    summary: 'Get the timeline in a flat order',
    description:
      'One page of the assets the time buckets would show for the same filters, ordered by file name or by rating instead of by date, in the time bucket response shape.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getTimelineOrdered(@Auth() auth: AuthDto, @Query() dto: TimelineOrderedDto) {
    return this.service.getTimelineOrdered(auth, dto);
  }

  @Get('highlights')
  @Authenticated({ permission: Permission.AssetRead, sharedLink: true })
  @ApiOkResponse({ type: TimelineHighlightResponseDto, isArray: true })
  @Endpoint({
    summary: 'Get timeline highlights',
    description:
      'Curated Years and Months cards for the same filters as the time buckets: per year or month the count, a key photo (highest Best Photos score, then rating, then most recent), highlights for months and the top three places.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
  getTimelineHighlights(
    @Auth() auth: AuthDto,
    @Query() dto: TimelineHighlightsDto,
  ): Promise<TimelineHighlightResponseDto[]> {
    return this.service.getTimelineHighlights(auth, dto);
  }
}
