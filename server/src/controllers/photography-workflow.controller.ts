import {
  Body,
  Controller,
  Get,
  Headers,
  Next,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiBody, ApiHeader, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  PhotographyApprovalDto,
  PhotographyAssemblyDto,
  PhotographyCallbackDto,
  PhotographyCheckoutDto,
  PhotographyChoicesDto,
  PhotographyGalleryDto,
  PhotographyGallerySessionDto,
  PhotographyGallerySessionResponseDto,
  PhotographyGuestApprovalDto,
  PhotographyIntakeDto,
  PhotographyInvitationDto,
  PhotographyOrderAcceptDto,
  PhotographyOrderCreateDto,
  PhotographyPaymentDto,
  PhotographyPresetSaveDto,
  PhotographyPublicSiteDto,
  PhotographyPublicationDto,
  PhotographyRecipientCreateDto,
  PhotographyRecipientUpdateDto,
  PhotographySiteDto,
  PhotographySiteSaveDto,
  PhotographyStudioPresetApplyDto,
  PhotographyStudioPresetsDto,
  PhotographyWorkflowConfigDto,
  PhotographyWorkflowDto,
  PhotographyWorkflowListDto,
  PhotographyWorkflowMutationDto,
  PhotographyZipDto,
  PhotographyZipResponseDto,
} from 'src/dtos/photography-workflow.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { RateLimited, RemoteMediaCeiling } from 'src/middleware/rate-limit.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotographyWorkflowService } from 'src/services/photography-workflow.service.js';
import { asStreamableFile, sendFile } from 'src/utils/file.js';

const uuid = new ParseUUIDPipe({ version: '4' });
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
export class PhotographyWorkflowController {
  constructor(
    private service: PhotographyWorkflowService,
    private logger: LoggingRepository,
  ) {}
  @Get('presets')
  @ApiOperation({ operationId: 'photographyStudioPresets' })
  @Authenticated()
  @ApiResponse({ status: 200, type: PhotographyStudioPresetsDto })
  studioPresets(@Auth() auth: AuthDto) {
    return this.service.studioPresets(auth);
  }
  @Post('presets')
  @ApiOperation({ operationId: 'photographySaveStudioPreset' })
  @Authenticated()
  @ApiResponse({ status: 201, type: PhotographyStudioPresetsDto })
  saveStudioPreset(@Auth() auth: AuthDto, @Body() dto: PhotographyPresetSaveDto) {
    return this.service.saveStudioPreset(auth, dto);
  }
  @Post('workflows/:id/studio-presets/:presetId/apply')
  @ApiOperation({ operationId: 'photographyApplyStudioPreset' })
  @Authenticated()
  @ApiResponse({ status: 201, type: PhotographyWorkflowDto })
  applyStudioPreset(
    @Auth() auth: AuthDto,
    @Param('id', uuid) id: string,
    @Param('presetId', uuid) presetId: string,
    @Body() dto: PhotographyStudioPresetApplyDto,
  ) {
    return this.service.applyStudioPreset(auth, id, presetId, dto);
  }
  @Get('site')
  @ApiOperation({ operationId: 'photographySite' })
  @Authenticated()
  @ApiResponse({ status: 200, type: PhotographySiteDto })
  site(@Auth() auth: AuthDto) {
    return this.service.site(auth);
  }
  @Put('site')
  @ApiOperation({ operationId: 'photographySaveSite' })
  @Authenticated()
  @ApiResponse({ status: 200, type: PhotographySiteDto })
  saveSite(@Auth() auth: AuthDto, @Body() dto: PhotographySiteSaveDto) {
    return this.service.saveSite(auth, dto);
  }
  @Get('studios/:ownerId')
  @ApiOperation({ operationId: 'photographyPublicSite' })
  @Authenticated({ public: true })
  @ApiResponse({ status: 200, type: PhotographyPublicSiteDto })
  publicSite(@Param('ownerId', uuid) ownerId: string, @Res({ passthrough: true }) res: Response) {
    res.header('Cache-Control', 'no-store');
    return this.service.publicSite(ownerId);
  }
  @RemoteMediaCeiling()
  @Get('studios/:ownerId/logo')
  @ApiOperation({ operationId: 'photographyPublicLogo' })
  @Authenticated({ public: true })
  @FileResponse()
  async publicLogo(@Param('ownerId', uuid) ownerId: string, @Res({ passthrough: true }) res: Response) {
    res.header('Cache-Control', 'no-store');
    return new StreamableFile(await this.service.publicLogo(ownerId), { type: 'image/png' });
  }
  @RemoteMediaCeiling()
  @Get('studios/:ownerId/photos/:shootId/:captureId')
  @ApiOperation({ operationId: 'photographyPublicPhoto' })
  @Authenticated({ public: true })
  @FileResponse()
  async publicPhoto(
    @Param('ownerId', uuid) ownerId: string,
    @Param('shootId', uuid) shootId: string,
    @Param('captureId', uuid) captureId: string,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    res.header('Cache-Control', 'no-store');
    await sendFile(res, next, () => this.service.publicPhoto(ownerId, shootId, captureId), this.logger);
  }
  @RemoteMediaCeiling()
  @Get('galleries/:id/logo')
  @ApiOperation({ operationId: 'photographyLogo' })
  @Authenticated({ public: true })
  @FileResponse()
  @ApiHeader({ name: 'X-Photography-Session', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } })
  async logo(
    @Param('id', uuid) id: string,
    @Headers('x-photography-session') session: string | undefined,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    res.header('Cache-Control', 'private, no-store');
    await sendFile(res, next, () => this.service.galleryLogo(id, session), this.logger);
  }
  @Get('workflows')
  @ApiOperation({ operationId: 'photographyList' })
  @Authenticated()
  @ApiResponse({ status: 200, type: PhotographyWorkflowListDto })
  list(@Auth() auth: AuthDto) {
    return this.service.list(auth);
  }
  @Get('workflows/:id')
  @ApiOperation({ operationId: 'photographyGet' })
  @Authenticated()
  @ApiResponse({ status: 200, type: PhotographyWorkflowDto })
  get(@Auth() auth: AuthDto, @Param('id', uuid) id: string) {
    return this.service.get(auth, id);
  }
  @Put('workflows/:id/config')
  @ApiOperation({ operationId: 'photographyConfig' })
  @Authenticated()
  @ApiResponse({ status: 200, type: PhotographyWorkflowDto })
  config(@Auth() auth: AuthDto, @Param('id', uuid) id: string, @Body() dto: PhotographyWorkflowConfigDto) {
    return this.service.config(auth, id, dto);
  }
  @Post('workflows/:id/presets')
  @ApiOperation({ operationId: 'photographySavePreset' })
  @Authenticated()
  @ApiResponse({ status: 201, type: PhotographyWorkflowDto })
  savePreset(@Auth() auth: AuthDto, @Param('id', uuid) id: string, @Body() dto: PhotographyPresetSaveDto) {
    return this.service.savePreset(auth, id, dto);
  }
  @Post('workflows/:id/presets/:presetId/apply')
  @ApiOperation({ operationId: 'photographyApplyPreset' })
  @Authenticated()
  @ApiResponse({ status: 201, type: PhotographyWorkflowDto })
  applyPreset(
    @Auth() auth: AuthDto,
    @Param('id', uuid) id: string,
    @Param('presetId', uuid) presetId: string,
    @Body() dto: PhotographyWorkflowMutationDto,
  ) {
    return this.service.applyPreset(auth, id, presetId, dto);
  }
  @Post('workflows/:id/intake')
  @ApiOperation({ operationId: 'photographyIntake' })
  @Authenticated()
  @ApiResponse({ status: 201, type: PhotographyWorkflowDto })
  intake(@Auth() auth: AuthDto, @Param('id', uuid) id: string, @Body() dto: PhotographyIntakeDto) {
    return this.service.intake(auth, id, dto);
  }
  @Post('workflows/:id/captures/:captureId/retry-processing')
  @ApiOperation({ operationId: 'photographyRetryCapture' })
  @Authenticated()
  @ApiResponse({ status: 201, type: PhotographyWorkflowDto })
  retryCapture(
    @Auth() auth: AuthDto,
    @Param('id', uuid) id: string,
    @Param('captureId', uuid) captureId: string,
    @Body() dto: PhotographyWorkflowMutationDto,
  ) {
    return this.service.retryCapture(auth, id, captureId, dto);
  }
  @Put('workflows/:id/assembly')
  @ApiOperation({ operationId: 'photographyAssembly' })
  @Authenticated()
  @ApiResponse({ status: 200, type: PhotographyWorkflowDto })
  assembly(@Auth() auth: AuthDto, @Param('id', uuid) id: string, @Body() dto: PhotographyAssemblyDto) {
    return this.service.assembly(auth, id, dto);
  }
  @Post('workflows/:id/recipients')
  @ApiOperation({ operationId: 'photographyInvite' })
  @Authenticated()
  @ApiResponse({ status: 201, type: PhotographyInvitationDto })
  invite(@Auth() auth: AuthDto, @Param('id', uuid) id: string, @Body() dto: PhotographyRecipientCreateDto) {
    return this.service.createRecipient(auth, id, dto);
  }
  @Patch('workflows/:id/recipients/:recipientId')
  @ApiOperation({ operationId: 'photographyRecipient' })
  @Authenticated()
  @ApiResponse({ status: 200, type: PhotographyWorkflowDto })
  recipient(
    @Auth() auth: AuthDto,
    @Param('id', uuid) id: string,
    @Param('recipientId', uuid) recipientId: string,
    @Body() dto: PhotographyRecipientUpdateDto,
  ) {
    return this.service.updateRecipient(auth, id, recipientId, dto);
  }
  @Post('workflows/:id/orders')
  @ApiOperation({ operationId: 'photographyOrder' })
  @Authenticated()
  @ApiResponse({ status: 201, type: PhotographyWorkflowDto })
  order(@Auth() auth: AuthDto, @Param('id', uuid) id: string, @Body() dto: PhotographyOrderCreateDto) {
    return this.service.order(auth, id, dto);
  }
  @Post('workflows/:id/orders/:orderId/payment')
  @ApiOperation({ operationId: 'photographyPayment' })
  @Authenticated()
  @ApiResponse({ status: 201, type: PhotographyWorkflowDto })
  payment(
    @Auth() auth: AuthDto,
    @Param('id', uuid) id: string,
    @Param('orderId', uuid) orderId: string,
    @Body() dto: PhotographyPaymentDto,
  ) {
    return this.service.payment(auth, id, orderId, dto);
  }
  @Post('workflows/:id/approvals')
  @ApiOperation({ operationId: 'photographyApproval' })
  @Authenticated()
  @ApiResponse({ status: 201, type: PhotographyWorkflowDto })
  approval(@Auth() auth: AuthDto, @Param('id', uuid) id: string, @Body() dto: PhotographyApprovalDto) {
    return this.service.approval(auth, id, dto);
  }
  @Post('workflows/:id/publish')
  @ApiOperation({ operationId: 'photographyPublish' })
  @Authenticated()
  @ApiResponse({ status: 201, type: PhotographyWorkflowDto })
  publish(@Auth() auth: AuthDto, @Param('id', uuid) id: string, @Body() dto: PhotographyPublicationDto) {
    return this.service.publish(auth, id, dto);
  }
  @Post('workflows/:id/retry')
  @ApiOperation({ operationId: 'photographyRetry' })
  @Authenticated()
  @ApiResponse({ status: 201, type: PhotographyWorkflowDto })
  retry(@Auth() auth: AuthDto, @Param('id', uuid) id: string, @Body() dto: PhotographyWorkflowMutationDto) {
    return this.service.retry(auth, id, dto);
  }
  @Post('galleries/:id/session')
  @ApiOperation({ operationId: 'photographySession' })
  @RateLimited({ bucket: 'photography-gallery-session', limit: 30, windowSeconds: 600 })
  @Authenticated({ public: true })
  @ApiResponse({ status: 201, type: PhotographyGallerySessionResponseDto })
  session(@Param('id', uuid) id: string, @Body() dto: PhotographyGallerySessionDto) {
    return this.service.session(id, dto);
  }
  @Get('galleries/:id')
  @ApiOperation({ operationId: 'photographyGallery' })
  @Authenticated({ public: true })
  @ApiResponse({ status: 200, type: PhotographyGalleryDto })
  @ApiHeader({ name: 'X-Photography-Session', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } })
  gallery(
    @Param('id', uuid) id: string,
    @Headers('x-photography-session') session: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    res.header('Cache-Control', 'private, no-store');
    return this.service.gallery(id, session);
  }
  @Put('galleries/:id/choices')
  @ApiOperation({ operationId: 'photographyChoices' })
  @Authenticated({ public: true })
  @ApiResponse({ status: 200, type: PhotographyGalleryDto })
  @ApiHeader({ name: 'X-Photography-Session', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } })
  choices(
    @Param('id', uuid) id: string,
    @Headers('x-photography-session') session: string | undefined,
    @Body() dto: PhotographyChoicesDto,
  ) {
    return this.service.choices(id, session, dto);
  }
  @Post('galleries/:id/submit')
  @ApiOperation({ operationId: 'photographySubmit' })
  @Authenticated({ public: true })
  @ApiResponse({ status: 201, type: PhotographyGalleryDto })
  @ApiHeader({ name: 'X-Photography-Session', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } })
  submit(
    @Param('id', uuid) id: string,
    @Headers('x-photography-session') session: string | undefined,
    @Body() dto: PhotographyWorkflowMutationDto,
  ) {
    return this.service.submit(id, session, dto);
  }
  @Post('galleries/:id/approve')
  @ApiOperation({ operationId: 'photographyApprove' })
  @Authenticated({ public: true })
  @ApiResponse({ status: 201, type: PhotographyGalleryDto })
  @ApiHeader({ name: 'X-Photography-Session', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } })
  approve(
    @Param('id', uuid) id: string,
    @Headers('x-photography-session') session: string | undefined,
    @Body() dto: PhotographyGuestApprovalDto,
  ) {
    return this.service.guestApproval(id, session, dto);
  }
  @Post('galleries/:id/orders/:orderId/accept')
  @ApiOperation({ operationId: 'photographyAccept' })
  @Authenticated({ public: true })
  @ApiResponse({ status: 201, type: PhotographyGalleryDto })
  @ApiHeader({ name: 'X-Photography-Session', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } })
  accept(
    @Param('id', uuid) id: string,
    @Param('orderId', uuid) orderId: string,
    @Headers('x-photography-session') session: string | undefined,
    @Body() dto: PhotographyOrderAcceptDto,
  ) {
    return this.service.accept(id, session, orderId, dto);
  }
  @Post('galleries/:id/orders/:orderId/checkout')
  @ApiOperation({ operationId: 'photographyCheckout' })
  @Authenticated({ public: true })
  @ApiResponse({ status: 201, type: PhotographyCheckoutDto })
  @ApiHeader({ name: 'X-Photography-Session', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } })
  checkout(
    @Param('id', uuid) id: string,
    @Param('orderId', uuid) orderId: string,
    @Headers('x-photography-session') session: string | undefined,
  ) {
    return this.service.checkout(id, session, orderId);
  }
  @Post('galleries/:id/zip')
  @ApiOperation({ operationId: 'photographyZip' })
  @Authenticated({ public: true })
  @ApiResponse({ status: 201, type: PhotographyZipResponseDto })
  @ApiHeader({ name: 'X-Photography-Session', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } })
  zip(
    @Param('id', uuid) id: string,
    @Headers('x-photography-session') session: string | undefined,
    @Body() dto: PhotographyZipDto,
  ) {
    return this.service.zip(id, session, dto);
  }
  @Get('galleries/:id/zip/:zipId')
  @ApiOperation({ operationId: 'photographyArchive' })
  @Authenticated({ public: true })
  @FileResponse()
  @ApiHeader({ name: 'X-Photography-Session', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } })
  async archive(
    @Param('id', uuid) id: string,
    @Param('zipId', uuid) zipId: string,
    @Headers('x-photography-session') session: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    res.header('Cache-Control', 'private, no-store');
    const archive = await this.service.archive(id, session, zipId);
    res.once('finish', () => {
      if (res.statusCode === 200)
        void this.service
          .recordDelivery(id, session, undefined, zipId)
          .catch(() => this.logger.warn('Could not record completed photography delivery'));
    });
    res.once('close', () => {
      if (!archive.stream.readableEnded) archive.stream.destroy();
    });
    if (res.destroyed || res.writableEnded) archive.stream.destroy();
    return asStreamableFile(archive);
  }
  @RemoteMediaCeiling()
  @Get('galleries/:id/photos/:captureId/outputs/:outputId/preview')
  @ApiOperation({ operationId: 'photographyOutputPreview' })
  @Authenticated({ public: true })
  @FileResponse()
  @ApiHeader({ name: 'X-Photography-Session', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } })
  async outputPreview(
    @Param('id', uuid) id: string,
    @Param('captureId', uuid) captureId: string,
    @Param('outputId', uuid) outputId: string,
    @Headers('x-photography-session') session: string | undefined,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    res.header('Cache-Control', 'private, no-store');
    await sendFile(res, next, () => this.service.outputPreview(id, session, captureId, outputId), this.logger);
  }
  @RemoteMediaCeiling()
  @Get('galleries/:id/photos/:captureId/outputs/:outputId')
  @ApiOperation({ operationId: 'photographyOutput' })
  @Authenticated({ public: true })
  @FileResponse()
  @ApiHeader({ name: 'X-Photography-Session', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } })
  async output(
    @Param('id', uuid) id: string,
    @Param('captureId', uuid) captureId: string,
    @Param('outputId', uuid) outputId: string,
    @Headers('x-photography-session') session: string | undefined,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    res.header('Cache-Control', 'private, no-store');
    res.once('finish', () => {
      if (res.statusCode === 200)
        void this.service
          .recordDelivery(id, session, captureId, undefined, outputId)
          .catch(() => this.logger.warn('Could not record completed photography delivery'));
    });
    await sendFile(res, next, () => this.service.outputFile(id, session, captureId, outputId), this.logger);
  }
  @RemoteMediaCeiling()
  @Get('galleries/:id/photos/:captureId/:kind')
  @ApiOperation({ operationId: 'photographyFile' })
  @Authenticated({ public: true })
  @FileResponse()
  @ApiHeader({ name: 'X-Photography-Session', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } })
  async file(
    @Param('id', uuid) id: string,
    @Param('captureId', uuid) captureId: string,
    @Param('kind') kind: string,
    @Headers('x-photography-session') session: string | undefined,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    res.header('Cache-Control', 'private, no-store');
    if (kind === 'download')
      res.once('finish', () => {
        if (res.statusCode === 200)
          void this.service
            .recordDelivery(id, session, captureId)
            .catch(() => this.logger.warn('Could not record completed photography delivery'));
      });
    await sendFile(res, next, () => this.service.file(id, session, captureId, kind), this.logger);
  }
  @Post('payments/stripe')
  @ApiOperation({ operationId: 'photographyCallback' })
  @Authenticated({ public: true })
  @ApiResponse({ status: 201, type: PhotographyCallbackDto })
  @ApiHeader({ name: 'Stripe-Signature', required: true })
  @ApiBody({
    schema: {
      type: 'object',
      additionalProperties: true,
      description: 'Signed Stripe event JSON. Signature verification requires its unchanged raw bytes.',
    },
  })
  callback(@Req() req: Request & { rawBody?: Buffer }, @Headers('stripe-signature') signature: string | undefined) {
    return this.service.callback(req.rawBody ?? Buffer.alloc(0), signature);
  }
}
