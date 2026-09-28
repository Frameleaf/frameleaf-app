import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  StudioPreviewStreamAnswerDto,
  StudioPreviewStreamDto,
  StudioPreviewStreamOpenDto,
} from 'src/dtos/studio-preview-stream.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { StudioPreviewStreamService } from 'src/services/studio-preview-stream.service.js';
import { UUIDv7ParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.0.0').alpha('v3.0.0');

/**
 * Bounded WebRTC playback of a stored Studio revision (FL-96, `STU-402`).
 *
 * Signalling and authorisation only: the media goes from the render worker to the browser over
 * WebRTC, never through the server. Every route is scoped to the account that opened the session,
 * and only the Svelte host calls them; the React editor has no API dependency.
 */
@ApiTags(ApiTag.StudioPreviews)
@Controller('studio/preview-streams')
export class StudioPreviewStreamController {
  constructor(private service: StudioPreviewStreamService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Authenticated()
  @Endpoint({
    summary: 'Open a Studio preview stream',
    description:
      "Opens a bounded WebRTC playback session of the project's current stored revision from an exact rational time. Refused for a superseded revision, an unavailable source, or when the account already holds the most sessions it may; an open session of the same project is superseded.",
    history: history(),
  })
  openStudioPreviewStream(
    @Auth() auth: AuthDto,
    @Body() dto: StudioPreviewStreamOpenDto,
  ): Promise<StudioPreviewStreamDto> {
    return this.service.open(auth, dto);
  }

  @Get(':id')
  @Authenticated()
  @Endpoint({
    summary: 'Get a Studio preview stream',
    description:
      "The session's state and, while it waits for an answer, the worker's offer. Polling it is the keepalive; each poll re-checks project access and the stored head, and closes the session when either has changed.",
    history: history(),
  })
  getStudioPreviewStream(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<StudioPreviewStreamDto> {
    return this.service.get(auth, id);
  }

  @Put(':id/answer')
  @Authenticated()
  @Endpoint({
    summary: 'Answer a Studio preview stream',
    description:
      "The browser's complete answer (non-trickle ICE) to the current negotiation's offer: receive one video, send nothing. The server writes the session's bitrate bound into it before the worker reads it.",
    history: history(),
  })
  answerStudioPreviewStream(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: StudioPreviewStreamAnswerDto,
  ): Promise<StudioPreviewStreamDto> {
    return this.service.answer(auth, id, dto);
  }

  @Post(':id/reconnect')
  @HttpCode(HttpStatus.OK)
  @Authenticated()
  @Endpoint({
    summary: 'Reconnect a Studio preview stream',
    description:
      "Starts the next negotiation after the peer connection dropped, only once project access, the stored head, every source's availability and the worker's lease have been validated again. Any failure closes the session with its reason.",
    history: history(),
  })
  reconnectStudioPreviewStream(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
  ): Promise<StudioPreviewStreamDto> {
    return this.service.reconnect(auth, id);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @Authenticated()
  @Endpoint({
    summary: 'Close a Studio preview stream',
    description: 'Ends the session; the worker stops sending on its next signalling poll.',
    history: history(),
  })
  closeStudioPreviewStream(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<StudioPreviewStreamDto> {
    return this.service.closeOwned(auth, id);
  }
}
