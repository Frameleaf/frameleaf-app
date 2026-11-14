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
  Post,
  Put,
  Res,
  ServiceUnavailableException,
  StreamableFile,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  PhotographyInvoiceCheckoutDto,
  PhotographyInvoiceDto,
  PhotographyInvoiceListDto,
  PhotographyInvoicePaidDto,
  PhotographyInvoicePaymentStatusDto,
  PhotographyInvoiceSaveDto,
  PhotographyPublicInvoiceDto,
} from 'src/dtos/photography-invoice.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { RateLimited } from 'src/middleware/rate-limit.guard.js';
import { ClientsPaymentsService } from 'src/services/clients-payments.service.js';
import { PhotographyInvoiceService } from 'src/services/photography-invoice.service.js';
import { UUIDParamDto } from 'src/validation.js';

const page = { bucket: 'photography-invoice-page', limit: 120, windowSeconds: 600 };
const pay = { bucket: 'photography-invoice-checkout', limit: 20, windowSeconds: 600 };
const attachment = (name: string) => `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
const noStore = (res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
};

@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
export class PhotographyInvoiceController {
  constructor(
    private readonly service: PhotographyInvoiceService,
    private readonly payments: ClientsPaymentsService,
  ) {}

  @Get('invoices')
  @Authenticated()
  @ApiOperation({ operationId: 'photographyInvoices' })
  @ApiResponse({ status: 200, type: PhotographyInvoiceListDto })
  list(@Auth() auth: AuthDto): Promise<PhotographyInvoiceListDto> {
    return this.service.list(auth);
  }
  @Post('invoices')
  @Authenticated()
  @ApiOperation({ operationId: 'photographyCreateInvoice', description: 'Totals and tax are computed on the server.' })
  @ApiResponse({ status: 201, type: PhotographyInvoiceDto })
  create(@Auth() auth: AuthDto, @Body() dto: PhotographyInvoiceSaveDto): Promise<PhotographyInvoiceDto> {
    return this.service.create(auth, dto);
  }
  @Get('invoices/:id')
  @Authenticated()
  @ApiOperation({ operationId: 'photographyInvoice' })
  @ApiResponse({ status: 200, type: PhotographyInvoiceDto })
  get(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<PhotographyInvoiceDto> {
    return this.service.get(auth, id);
  }
  @Put('invoices/:id')
  @Authenticated()
  @ApiOperation({ operationId: 'photographyUpdateInvoice', description: 'Allowed until a payment is recorded.' })
  @ApiResponse({ status: 200, type: PhotographyInvoiceDto })
  update(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: PhotographyInvoiceSaveDto,
  ): Promise<PhotographyInvoiceDto> {
    return this.service.update(auth, id, dto);
  }
  @Delete('invoices/:id')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ operationId: 'photographyDeleteInvoice', description: 'Drafts only; void a sent invoice.' })
  delete(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.delete(auth, id);
  }
  @Post('invoices/:id/send')
  @Authenticated()
  @ApiOperation({ operationId: 'photographySendInvoice' })
  @ApiResponse({ status: 201, type: PhotographyInvoiceDto })
  send(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<PhotographyInvoiceDto> {
    return this.service.send(auth, id);
  }
  @Post('invoices/:id/void')
  @Authenticated()
  @ApiOperation({ operationId: 'photographyVoidInvoice' })
  @ApiResponse({ status: 201, type: PhotographyInvoiceDto })
  void(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<PhotographyInvoiceDto> {
    return this.service.void(auth, id);
  }
  @Post('invoices/:id/paid')
  @Authenticated()
  @ApiOperation({
    operationId: 'photographyMarkInvoicePaid',
    description: 'Records a payment received outside Frameleaf.',
  })
  @ApiResponse({ status: 201, type: PhotographyInvoiceDto })
  markPaid(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: PhotographyInvoicePaidDto,
  ): Promise<PhotographyInvoiceDto> {
    return this.service.markPaid(auth, id, dto.amount);
  }
  @Get('invoices/:id/pdf')
  @Authenticated()
  @FileResponse('application/pdf')
  @ApiOperation({ operationId: 'photographyInvoicePdf' })
  async pdf(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<StreamableFile> {
    const { name, buffer } = await this.service.pdf(auth, id);
    return new StreamableFile(buffer, { type: 'application/pdf', disposition: attachment(name) });
  }

  @Get('invoices/view/:token')
  @Authenticated({ public: true })
  @RateLimited(page)
  @ApiOperation({ operationId: 'photographyPublicInvoice' })
  @ApiResponse({ status: 200, type: PhotographyPublicInvoiceDto })
  publicView(
    @Param('token') token: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PhotographyPublicInvoiceDto> {
    noStore(res);
    return this.service.publicView(token);
  }
  @Get('invoices/view/:token/pdf')
  @Authenticated({ public: true })
  @RateLimited(page)
  @FileResponse('application/pdf')
  @ApiOperation({ operationId: 'photographyPublicInvoicePdf' })
  async publicPdf(@Param('token') token: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    noStore(res);
    const { name, buffer } = await this.service.publicPdf(token);
    return new StreamableFile(buffer, { type: 'application/pdf', disposition: attachment(name) });
  }
  @Post('invoices/view/:token/checkout')
  @Authenticated({ public: true })
  @RateLimited(pay)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: 'photographyInvoiceCheckout', description: 'Checkout for the amount due now.' })
  @ApiResponse({ status: 200, type: PhotographyInvoiceCheckoutDto })
  async checkout(
    @Param('token') token: string,
    @Headers('origin') origin: string | undefined,
  ): Promise<PhotographyInvoiceCheckoutDto> {
    // Stripe returns the client to the address they came from, else this server's public address.
    const from = origin && /^https?:\/\/[^/\s]+$/.test(origin) ? origin : await this.payments.publicUrl();
    if (!from) throw new ServiceUnavailableException('Set this server’s public address to take payments');
    return this.service.checkout(token, from);
  }
  @Get('invoices/view/:token/payments/:paymentId')
  @Authenticated({ public: true })
  @RateLimited(page)
  @ApiOperation({ operationId: 'photographyInvoicePaymentStatus' })
  @ApiResponse({ status: 200, type: PhotographyInvoicePaymentStatusDto })
  paymentStatus(
    @Param('token') token: string,
    @Param('paymentId', new ParseUUIDPipe({ version: '4' })) paymentId: string,
  ): Promise<PhotographyInvoicePaymentStatusDto> {
    return this.service.paymentStatus(token, paymentId);
  }
}
