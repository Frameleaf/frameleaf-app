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
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  PhotographyPayCheckoutDto,
  PhotographyPayCheckoutResponseDto,
  PhotographyPayStatusDto,
  PhotographyPaymentLinkCreateDto,
  PhotographyPaymentLinkDto,
  PhotographyPaymentLinkListDto,
  PhotographyPaymentLinkUpdateDto,
  PhotographyPaymentListDto,
  PhotographyPublicPaymentLinkDto,
} from 'src/dtos/photography-payment.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { RateLimited } from 'src/middleware/rate-limit.guard.js';
import { ClientsPaymentsService } from 'src/services/clients-payments.service.js';
import { PhotographyPaymentService } from 'src/services/photography-payment.service.js';

const uuid = new ParseUUIDPipe({ version: '4' });

/** FL-1041: payment links (studio) and the public pay page. */
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
export class PhotographyPaymentController {
  constructor(
    private service: PhotographyPaymentService,
    private payments: ClientsPaymentsService,
  ) {}

  @Get('payment-links')
  @ApiOperation({ operationId: 'photographyPaymentLinks' })
  @Authenticated()
  @ApiResponse({ status: 200, type: PhotographyPaymentLinkListDto })
  links(@Auth() auth: AuthDto) {
    return this.service.links(auth);
  }

  @Post('payment-links')
  @ApiOperation({ operationId: 'photographyCreatePaymentLink' })
  @Authenticated()
  @ApiResponse({ status: 201, type: PhotographyPaymentLinkDto })
  create(@Auth() auth: AuthDto, @Body() dto: PhotographyPaymentLinkCreateDto) {
    return this.service.create(auth, dto);
  }

  @Patch('payment-links/:id')
  @ApiOperation({ operationId: 'photographyUpdatePaymentLink' })
  @Authenticated()
  @ApiResponse({ status: 200, type: PhotographyPaymentLinkDto })
  update(@Auth() auth: AuthDto, @Param('id', uuid) id: string, @Body() dto: PhotographyPaymentLinkUpdateDto) {
    return this.service.update(auth, id, dto);
  }

  @Delete('payment-links/:id')
  @ApiOperation({ operationId: 'photographyDeletePaymentLink' })
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@Auth() auth: AuthDto, @Param('id', uuid) id: string) {
    await this.service.remove(auth, id);
  }

  @Get('payments')
  @ApiOperation({ operationId: 'photographyPayments' })
  @Authenticated()
  @ApiResponse({ status: 200, type: PhotographyPaymentListDto })
  paymentList(@Auth() auth: AuthDto) {
    return this.service.paymentList(auth);
  }

  @Get('pay/:slug')
  @ApiOperation({ operationId: 'photographyPublicPaymentLink' })
  @Authenticated({ public: true })
  @RateLimited({ bucket: 'photography-pay-page', limit: 120, windowSeconds: 600 })
  @ApiResponse({ status: 200, type: PhotographyPublicPaymentLinkDto })
  publicLink(@Param('slug') slug: string) {
    return this.service.publicLink(slug);
  }

  @Post('pay/:slug/checkout')
  @ApiOperation({ operationId: 'photographyPayCheckout' })
  @Authenticated({ public: true })
  @RateLimited({ bucket: 'photography-pay-checkout', limit: 20, windowSeconds: 600 })
  @HttpCode(HttpStatus.OK)
  @ApiResponse({ status: 200, type: PhotographyPayCheckoutResponseDto })
  async checkout(
    @Param('slug') slug: string,
    @Body() dto: PhotographyPayCheckoutDto,
    @Headers('origin') origin: string | undefined,
  ) {
    // Stripe returns the payer to the address they came from, else this server's public address.
    const from = origin && /^https?:\/\/[^/\s]+$/.test(origin) ? origin : await this.payments.publicUrl();
    if (!from) throw new ServiceUnavailableException('Set this server’s public address to take payments');
    return this.service.checkout(slug, dto, from);
  }

  @Get('pay/:slug/payments/:paymentId')
  @ApiOperation({ operationId: 'photographyPayStatus' })
  @Authenticated({ public: true })
  @RateLimited({ bucket: 'photography-pay-page', limit: 120, windowSeconds: 600 })
  @ApiResponse({ status: 200, type: PhotographyPayStatusDto })
  status(@Param('slug') slug: string, @Param('paymentId', uuid) paymentId: string) {
    return this.service.paymentStatus(slug, paymentId);
  }
}
