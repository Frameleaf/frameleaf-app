import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  PhotographyBookingDto,
  PhotographyBookingListDto,
  PhotographyBookingRequestDto,
  PhotographyBookingRequestResponseDto,
  PhotographyBookingStatusDto,
  PhotographyBookingTypeDto,
  PhotographyBookingTypeListDto,
  PhotographyBookingTypeSaveDto,
  PhotographyPublicBookingTypeListDto,
} from 'src/dtos/photography-booking.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { RATE_LIMITS, RateLimited } from 'src/middleware/rate-limit.guard.js';
import { PhotographyBookingService } from 'src/services/photography-booking.service.js';

const uuid = new ParseUUIDPipe({ version: '4' });

/** FL-1049: booking types (studio) and booking requests from the studio website. */
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
export class PhotographyBookingController {
  constructor(private service: PhotographyBookingService) {}

  @Get('booking-types')
  @ApiOperation({ operationId: 'photographyBookingTypes' })
  @Authenticated()
  @ApiResponse({ status: 200, type: PhotographyBookingTypeListDto })
  types(@Auth() auth: AuthDto) {
    return this.service.types(auth);
  }

  @Post('booking-types')
  @ApiOperation({ operationId: 'photographyCreateBookingType' })
  @Authenticated()
  @ApiResponse({ status: 201, type: PhotographyBookingTypeDto })
  createType(@Auth() auth: AuthDto, @Body() dto: PhotographyBookingTypeSaveDto) {
    return this.service.createType(auth, dto);
  }

  @Put('booking-types/:id')
  @ApiOperation({ operationId: 'photographyUpdateBookingType' })
  @Authenticated()
  @ApiResponse({ status: 200, type: PhotographyBookingTypeDto })
  updateType(@Auth() auth: AuthDto, @Param('id', uuid) id: string, @Body() dto: PhotographyBookingTypeSaveDto) {
    return this.service.updateType(auth, id, dto);
  }

  @Delete('booking-types/:id')
  @ApiOperation({ operationId: 'photographyDeleteBookingType' })
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteType(@Auth() auth: AuthDto, @Param('id', uuid) id: string) {
    await this.service.deleteType(auth, id);
  }

  @Get('bookings')
  @ApiOperation({ operationId: 'photographyBookings' })
  @Authenticated()
  @ApiResponse({ status: 200, type: PhotographyBookingListDto })
  bookings(@Auth() auth: AuthDto) {
    return this.service.bookings(auth);
  }

  @Patch('bookings/:id')
  @ApiOperation({ operationId: 'photographyUpdateBookingStatus' })
  @Authenticated()
  @ApiResponse({ status: 200, type: PhotographyBookingDto })
  setStatus(@Auth() auth: AuthDto, @Param('id', uuid) id: string, @Body() dto: PhotographyBookingStatusDto) {
    return this.service.setStatus(auth, id, dto);
  }

  @Get('studios/:site/booking-types')
  @ApiOperation({ operationId: 'photographyPublicBookingTypes' })
  @Authenticated({ public: true })
  @RateLimited({ bucket: 'photography-booking-types', limit: 120, windowSeconds: 600 })
  @ApiResponse({ status: 200, type: PhotographyPublicBookingTypeListDto })
  publicTypes(@Param('site') site: string) {
    return this.service.publicTypes(site);
  }

  @Post('studios/:site/bookings')
  @ApiOperation({ operationId: 'photographyRequestBooking' })
  @Authenticated({ public: true })
  @RateLimited(RATE_LIMITS.studioInquiry)
  @HttpCode(HttpStatus.OK)
  @ApiResponse({ status: 200, type: PhotographyBookingRequestResponseDto })
  request(
    @Param('site') site: string,
    @Body() dto: PhotographyBookingRequestDto,
    @Headers('origin') origin: string | undefined,
  ) {
    return this.service.request(site, dto, origin && /^https?:\/\/[^/\s]+$/.test(origin) ? origin : null);
  }
}
