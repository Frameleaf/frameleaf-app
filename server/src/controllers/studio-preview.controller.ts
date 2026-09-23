import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Next, Param, Post, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { StudioPreviewDto, StudioPreviewRequestDto, StudioPreviewResponseDto } from 'src/dtos/studio-preview.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StudioPreviewService } from 'src/services/studio-preview.service.js';
import { sendFile } from 'src/utils/file.js';
import { UUIDv7ParamDto } from 'src/validation.js';

/**
 * Revision-bound remote preview (FL-96, `STU-402`).
 *
 * Every route is scoped to the account that asked, and the frame route is the one that matters:
 * it returns bytes only while that account may still read the project and the stored revision
 * the frame was rendered for is still the project's head (FL-89). When it is not, the answer is
 * `409` with the current revision — never the old picture, and never a `304` that leaves the
 * old picture on screen.
 *
 * The React editor never reaches these routes. It asks for a preview through the host bridge as
 * a command; the Svelte host is the only thing here holding credentials.
 */
@ApiTags(ApiTag.StudioPreviews)
@Controller('studio/previews')
export class StudioPreviewController {
  constructor(
    private service: StudioPreviewService,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(StudioPreviewController.name);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @Authenticated()
  @Endpoint({
    summary: 'Request a Studio preview frame',
    description:
      "Asks for one frame of a project's current stored revision at an exact rational time, quality and viewport. The server reads the graph from project storage and resolves its sources for the caller; a request naming a superseded revision is refused with the current one. An identical request shares the render rather than starting a second one, and previews of superseded revisions are cancelled.",
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  requestStudioPreview(@Auth() auth: AuthDto, @Body() dto: StudioPreviewRequestDto): Promise<StudioPreviewResponseDto> {
    return this.service.request(auth, dto);
  }

  @Get(':id')
  @Authenticated()
  @Endpoint({
    summary: 'Get a Studio preview',
    description: 'The state of one requested frame, including its revision-bound entity tag.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getStudioPreview(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<StudioPreviewDto> {
    return this.service.get(auth, id);
  }

  @Get(':id/frame')
  @FileResponse()
  @Authenticated()
  @Endpoint({
    summary: 'View a Studio preview frame',
    description:
      'Returns the rendered frame. The entity tag contains the project revision, so a frame whose revision has been superseded is refused with 409 rather than served or revalidated.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  async viewStudioPreviewFrame(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Req() req: Request,
    @Res() res: Response,
    @Next() next: NextFunction,
  ) {
    const ifNoneMatch = req.headers['if-none-match'];
    const result = await this.service.getFrame(auth, id, {
      ifNoneMatch: Array.isArray(ifNoneMatch) ? ifNoneMatch.join(', ') : ifNoneMatch,
    });

    if ('notModified' in result) {
      res.setHeader('ETag', result.etag);
      res.status(HttpStatus.NOT_MODIFIED).end();
      return;
    }

    // Set before `sendFile` so the validator travels with the bytes; the client revalidates
    // every time, because the revision can be superseded between two paints.
    res.setHeader('ETag', result.etag);
    await sendFile(res, next, () => Promise.resolve(result.file), this.logger);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @Authenticated()
  @Endpoint({
    summary: 'Cancel a Studio preview',
    description:
      'Stops a preview the client no longer needs and releases its stored frame. The record survives so a client still holding the id is told the frame is gone rather than that it never existed.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  cancelStudioPreview(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<StudioPreviewDto> {
    return this.service.cancel(auth, id);
  }
}
