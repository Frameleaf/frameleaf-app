import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  StudioMovieCreateDto,
  StudioMovieDto,
  StudioMovieQueuedDto,
  StudioMovieSongDto,
  StudioMovieSongQueryDto,
} from 'src/dtos/studio-movie.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { StudioMovieService } from 'src/services/studio-movie.service.js';
import { UUIDv7ParamDto } from 'src/validation.js';

/** Make a movie from an album, a memory or a selection (FL-561). */
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/movies')
export class StudioMovieController {
  constructor(private service: StudioMovieService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Authenticated()
  @Endpoint({
    summary: 'Make a movie',
    description:
      'Queues a movie made from one album, memory or set of photos and videos you can read: the best moments, cut on the bars of music made for it (a mood) or of a song from your library (an audio file, or a video whose soundtrack is used), with a title at the start. It is saved as a Studio project; nothing reaches the library until it is exported. With `previousId` the new cut is saved as the next revision of the earlier version’s project, so the earlier cut stays in its history. Follow the job here or in Activity (`/media-operations/{id}`).',
    history: new HistoryBuilder().added('v3.3.0').alpha('v3.3.0'),
  })
  createStudioMovie(@Auth() auth: AuthDto, @Body() dto: StudioMovieCreateDto): Promise<StudioMovieQueuedDto> {
    return this.service.create(auth, dto);
  }

  @Get('songs')
  @Authenticated()
  @Endpoint({
    summary: 'List songs for a movie',
    description:
      'Your audio files, then your videos long enough to lend their soundtrack, newest first, optionally filtered by part of the file name.',
    history: new HistoryBuilder().added('v3.3.0').alpha('v3.3.0'),
  })
  getStudioMovieSongs(@Auth() auth: AuthDto, @Query() dto: StudioMovieSongQueryDto): Promise<StudioMovieSongDto[]> {
    return this.service.getSongs(auth, dto.query);
  }

  @Get(':id')
  @Authenticated()
  @Endpoint({
    summary: 'Get a movie',
    description:
      'Owner only. The job status, step and progress, and once it has completed the movie: its project, length, shots, beats and music.',
    history: new HistoryBuilder().added('v3.3.0').alpha('v3.3.0'),
  })
  getStudioMovie(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<StudioMovieDto> {
    return this.service.get(auth, id);
  }
}
