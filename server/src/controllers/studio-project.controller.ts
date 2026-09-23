import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  StudioCommentCreateDto,
  StudioCommentDto,
  StudioCommentListResponseDto,
  StudioCommentParamDto,
  StudioCommentUpdateDto,
  StudioProjectCreateDto,
  StudioProjectDetailDto,
  StudioProjectDiffDto,
  StudioProjectDiffQueryDto,
  StudioProjectDto,
  StudioProjectHistoryResponseDto,
  StudioProjectLeaseDto,
  StudioProjectLeaseRequestDto,
  StudioProjectListResponseDto,
  StudioProjectRestoreDto,
  StudioProjectRevisionDetailDto,
  StudioProjectSaveDto,
  StudioProjectSaveResponseDto,
  StudioProjectSearchDto,
  StudioProjectUpdateDto,
  StudioRevisionParamDto,
} from 'src/dtos/studio-project.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { StudioProjectService } from 'src/services/studio-project.service.js';
import { UUIDv7ParamDto } from 'src/validation.js';

/**
 * Studio projects: storage, autosave, history, leases and review (FL-89, `STU-202`).
 *
 * Every route is scoped by the service to the owner or to a member of the project's shared space;
 * anything else answers `404`. Writes (`409 Conflict`) carry a `reason` the editor acts on:
 * `stale-revision` with the current head, `lease-lost` or `lease-held` with the lease state, and
 * `request-key-reused` for a client bug that must not be papered over.
 *
 * Nothing here executes a graph. Preview and render take a stored revision through the resource
 * resolver for the account doing the executing; saving is a storage boundary only.
 */
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
export class StudioProjectController {
  constructor(private service: StudioProjectService) {}

  @Get()
  @Authenticated()
  @Endpoint({
    summary: 'List Studio projects',
    description: 'Projects you own and projects shared with a space you belong to, most recently changed first.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  searchStudioProjects(@Auth() auth: AuthDto, @Query() dto: StudioProjectSearchDto): Promise<StudioProjectListResponseDto> {
    return this.service.search(auth, dto);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Authenticated()
  @Endpoint({
    summary: 'Create a Studio project',
    description:
      'Creates an empty project owned by you and hands the write lease to the given editor instance. An initial document, when given, is saved as revision 1.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  createStudioProject(@Auth() auth: AuthDto, @Body() dto: StudioProjectCreateDto): Promise<StudioProjectDetailDto> {
    return this.service.create(auth, dto);
  }

  @Get(':id')
  @Authenticated()
  @Endpoint({
    summary: 'Get a Studio project',
    description:
      'The project with its head document. A reviewer receives the document only when every source it references is available to them; otherwise it is withheld.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getStudioProject(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<StudioProjectDetailDto> {
    return this.service.get(auth, id);
  }

  @Put(':id')
  @Authenticated()
  @Endpoint({
    summary: 'Update a Studio project',
    description: 'Rename the project or set the shared space whose members may review it. Owner only.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  updateStudioProject(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: StudioProjectUpdateDto,
  ): Promise<StudioProjectDto> {
    return this.service.update(auth, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated()
  @Endpoint({
    summary: 'Delete a Studio project',
    description: 'Removes the project, its history and its comments. Owner only. Finished jobs keep their lineage.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  deleteStudioProject(@Auth() auth: AuthDto, @Param() { id }: UUIDv7ParamDto): Promise<void> {
    return this.service.remove(auth, id);
  }

  @Post(':id/lease')
  @HttpCode(HttpStatus.OK)
  @Authenticated()
  @Endpoint({
    summary: 'Acquire or renew the write lease',
    description:
      'One editor instance writes at a time. The holder renews with the same call; a free or lapsed lease is taken; a live lease held elsewhere is refused with `409` unless `takeover` is set explicitly.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  acquireStudioProjectLease(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: StudioProjectLeaseRequestDto,
  ): Promise<StudioProjectLeaseDto> {
    return this.service.acquireLease(auth, id, dto);
  }

  @Post(':id/lease/release')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated()
  @Endpoint({
    summary: 'Release the write lease',
    description: 'Gives the lease back so another editor instance can take it without waiting for it to lapse.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  releaseStudioProjectLease(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: StudioProjectLeaseRequestDto,
  ): Promise<void> {
    return this.service.releaseLease(auth, id, dto);
  }

  @Post(':id/revisions')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated()
  @Endpoint({
    summary: 'Save a Studio project revision',
    description:
      'Autosave. Stores the complete document as the next revision when `expectedRevision` is the head and the caller holds the lease. The same `requestKey` with the same document replays the earlier result; an unchanged document writes nothing.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  saveStudioProjectRevision(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: StudioProjectSaveDto,
  ): Promise<StudioProjectSaveResponseDto> {
    return this.service.save(auth, id, dto);
  }

  @Post(':id/restore')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated()
  @Endpoint({
    summary: 'Restore a Studio project revision',
    description:
      'Appends a new revision with the content of an earlier one. History is never rewritten; the restore is itself a revision.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  restoreStudioProjectRevision(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: StudioProjectRestoreDto,
  ): Promise<StudioProjectSaveResponseDto> {
    return this.service.restore(auth, id, dto);
  }

  @Get(':id/revisions')
  @Authenticated()
  @Endpoint({
    summary: 'List Studio project history',
    description: 'Revisions newest first, without their documents.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getStudioProjectHistory(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Query() dto: StudioProjectSearchDto,
  ): Promise<StudioProjectHistoryResponseDto> {
    return this.service.getHistory(auth, id, dto);
  }

  @Get(':id/revisions/:revision')
  @Authenticated()
  @Endpoint({
    summary: 'Get a Studio project revision',
    description: 'One historical revision with its document, under the same review rule as the head.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getStudioProjectRevision(
    @Auth() auth: AuthDto,
    @Param() { id, revision }: StudioRevisionParamDto,
  ): Promise<StudioProjectRevisionDetailDto> {
    return this.service.getRevision(auth, id, revision);
  }

  @Get(':id/revisions/:revision/diff')
  @Authenticated()
  @Endpoint({
    summary: 'Compare two Studio project revisions',
    description: 'What changed between `against` and this revision, as graph paths and counts. No graph values are returned.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  diffStudioProjectRevision(
    @Auth() auth: AuthDto,
    @Param() { id, revision }: StudioRevisionParamDto,
    @Query() { against }: StudioProjectDiffQueryDto,
  ): Promise<StudioProjectDiffDto> {
    return this.service.diff(auth, id, revision, against);
  }

  @Get(':id/comments')
  @Authenticated()
  @Endpoint({
    summary: 'List Studio review comments',
    description: 'Comments pinned to the timeline, oldest first.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getStudioProjectComments(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Query() dto: StudioProjectSearchDto,
  ): Promise<StudioCommentListResponseDto> {
    return this.service.getComments(auth, id, dto);
  }

  @Post(':id/comments')
  @HttpCode(HttpStatus.CREATED)
  @Authenticated()
  @Endpoint({
    summary: 'Add a Studio review comment',
    description: 'Owner and reviewers may comment. The time is an exact fraction of seconds. No lease is needed.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  addStudioProjectComment(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDv7ParamDto,
    @Body() dto: StudioCommentCreateDto,
  ): Promise<StudioCommentDto> {
    return this.service.addComment(auth, id, dto);
  }

  @Put(':id/comments/:commentId')
  @Authenticated()
  @Endpoint({
    summary: 'Update a Studio review comment',
    description: 'The author edits the text; the author or the owner resolves or reopens it.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  updateStudioProjectComment(
    @Auth() auth: AuthDto,
    @Param() { id, commentId }: StudioCommentParamDto,
    @Body() dto: StudioCommentUpdateDto,
  ): Promise<StudioCommentDto> {
    return this.service.updateComment(auth, id, commentId, dto);
  }

  @Delete(':id/comments/:commentId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated()
  @Endpoint({
    summary: 'Remove a Studio review comment',
    description: 'The author or the project owner may remove a comment.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  removeStudioProjectComment(@Auth() auth: AuthDto, @Param() { id, commentId }: StudioCommentParamDto): Promise<void> {
    return this.service.removeComment(auth, id, commentId);
  }
}
