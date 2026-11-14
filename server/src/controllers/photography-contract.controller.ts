import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  PhotographyContractCreateDto,
  PhotographyContractDto,
  PhotographyContractListDto,
  PhotographyContractSignDto,
  PhotographyContractTemplateDto,
  PhotographyContractTemplateListDto,
  PhotographyContractTemplateSaveDto,
  PhotographyPublicContractDto,
} from 'src/dtos/photography-contract.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { type FrameleafRequest, requestSecurityAddress } from 'src/middleware/frameleaf-via.middleware.js';
import { RateLimited } from 'src/middleware/rate-limit.guard.js';
import { PhotographyContractService } from 'src/services/photography-contract.service.js';
import { UUIDParamDto } from 'src/validation.js';

const signing = { bucket: 'photography-contract-sign', limit: 60, windowSeconds: 60 };
const requestInfo = (request: Request) => ({
  ip: requestSecurityAddress(request as FrameleafRequest) ?? null,
  userAgent: request.get('user-agent')?.slice(0, 500) ?? null,
});
const attachment = (name: string) => `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
const noStore = (res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
};

@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
export class PhotographyContractController {
  constructor(private readonly service: PhotographyContractService) {}

  @Get('contract-templates')
  @Authenticated()
  @ApiOperation({ operationId: 'photographyContractTemplates' })
  @ApiResponse({ status: 200, type: PhotographyContractTemplateListDto })
  templates(@Auth() auth: AuthDto): Promise<PhotographyContractTemplateListDto> {
    return this.service.templates(auth);
  }
  @Post('contract-templates')
  @Authenticated()
  @ApiOperation({ operationId: 'photographyCreateContractTemplate' })
  @ApiResponse({ status: 201, type: PhotographyContractTemplateDto })
  createTemplate(
    @Auth() auth: AuthDto,
    @Body() dto: PhotographyContractTemplateSaveDto,
  ): Promise<PhotographyContractTemplateDto> {
    return this.service.createTemplate(auth, dto);
  }
  @Put('contract-templates/:id')
  @Authenticated()
  @ApiOperation({ operationId: 'photographyUpdateContractTemplate' })
  @ApiResponse({ status: 200, type: PhotographyContractTemplateDto })
  updateTemplate(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: PhotographyContractTemplateSaveDto,
  ): Promise<PhotographyContractTemplateDto> {
    return this.service.updateTemplate(auth, id, dto);
  }
  @Delete('contract-templates/:id')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ operationId: 'photographyDeleteContractTemplate' })
  deleteTemplate(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.deleteTemplate(auth, id);
  }

  @Get('contracts')
  @Authenticated()
  @ApiOperation({ operationId: 'photographyContracts' })
  @ApiResponse({ status: 200, type: PhotographyContractListDto })
  list(@Auth() auth: AuthDto): Promise<PhotographyContractListDto> {
    return this.service.list(auth);
  }
  @Post('contracts')
  @Authenticated()
  @ApiOperation({ operationId: 'photographyCreateContract', description: 'Fills a template; the text is then frozen.' })
  @ApiResponse({ status: 201, type: PhotographyContractDto })
  create(@Auth() auth: AuthDto, @Body() dto: PhotographyContractCreateDto): Promise<PhotographyContractDto> {
    return this.service.create(auth, dto);
  }
  @Get('contracts/:id')
  @Authenticated()
  @ApiOperation({ operationId: 'photographyContract' })
  @ApiResponse({ status: 200, type: PhotographyContractDto })
  get(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<PhotographyContractDto> {
    return this.service.get(auth, id);
  }
  @Delete('contracts/:id')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ operationId: 'photographyDeleteContract' })
  delete(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.delete(auth, id);
  }
  @Post('contracts/:id/send')
  @Authenticated()
  @ApiOperation({
    operationId: 'photographySendContract',
    description: 'Emails a signing link that works for 30 days. Sending again replaces the earlier link.',
  })
  @ApiResponse({ status: 201, type: PhotographyContractDto })
  send(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<PhotographyContractDto> {
    return this.service.send(auth, id);
  }
  @Post('contracts/:id/void')
  @Authenticated()
  @ApiOperation({ operationId: 'photographyVoidContract' })
  @ApiResponse({ status: 201, type: PhotographyContractDto })
  void(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<PhotographyContractDto> {
    return this.service.void(auth, id);
  }
  @Get('contracts/:id/pdf')
  @Authenticated()
  @FileResponse('application/pdf')
  @ApiOperation({ operationId: 'photographyContractPdf' })
  async pdf(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<StreamableFile> {
    const { name, buffer } = await this.service.pdf(auth, id);
    return new StreamableFile(buffer, { type: 'application/pdf', disposition: attachment(name) });
  }
  @Get('contracts/:id/export')
  @Authenticated()
  @FileResponse('application/zip')
  @ApiOperation({
    operationId: 'photographyContractExport',
    description: 'The signed PDF, audit.json and SHA256SUMS in one archive.',
  })
  async export(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<StreamableFile> {
    const { name, stream } = await this.service.export(auth, id);
    return new StreamableFile(stream, { type: 'application/zip', disposition: attachment(name) });
  }

  @Get('sign/:token')
  @Authenticated({ public: true })
  @RateLimited(signing)
  @ApiOperation({ operationId: 'photographyPublicContract' })
  @ApiResponse({ status: 200, type: PhotographyPublicContractDto })
  publicView(
    @Param('token') token: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PhotographyPublicContractDto> {
    noStore(res);
    return this.service.publicView(token, requestInfo(req));
  }
  @Post('sign/:token')
  @Authenticated({ public: true })
  @RateLimited(signing)
  @ApiOperation({ operationId: 'photographySignContract' })
  @ApiResponse({ status: 201, type: PhotographyPublicContractDto })
  sign(
    @Param('token') token: string,
    @Body() dto: PhotographyContractSignDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PhotographyPublicContractDto> {
    noStore(res);
    return this.service.sign(token, dto, requestInfo(req));
  }
  @Get('sign/:token/pdf')
  @Authenticated({ public: true })
  @RateLimited(signing)
  @FileResponse('application/pdf')
  @ApiOperation({ operationId: 'photographyPublicContractPdf' })
  async publicPdf(@Param('token') token: string, @Res({ passthrough: true }) res: Response): Promise<StreamableFile> {
    noStore(res);
    const { name, buffer } = await this.service.publicPdf(token);
    return new StreamableFile(buffer, { type: 'application/pdf', disposition: attachment(name) });
  }
}
