import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Next,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import type { NextFunction, Response } from 'express';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto.js';
import {
  AssetFaceUpdateDto,
  MergePersonDto,
  MergeSuggestionsResponseDto,
  PeopleResponseDto,
  PeopleUpdateDto,
  PersonCorrectionDto,
  PersonCorrectionSearchDto,
  PersonCorrectionsResponseDto,
  PersonCreateDto,
  PersonMergeVerdictCreateDto,
  PersonMergeVerdictDeleteDto,
  PersonMergeVerdictResponseDto,
  PersonResponseDto,
  PersonSearchDto,
  PersonStatisticsResponseDto,
  PersonUpdateDto,
} from 'src/dtos/person.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PersonService } from 'src/services/person.service.js';
import { sendFile } from 'src/utils/file.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.People)
@Controller('people')
export class PersonController {
  constructor(
    private service: PersonService,
    private logger: LoggingRepository,
  ) {
    this.logger.setContext(PersonController.name);
  }

  @Get()
  @Authenticated({ permission: Permission.PersonRead })
  @Endpoint({
    summary: 'Get all people',
    description: 'Retrieve a list of all people.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getAllPeople(@Auth() auth: AuthDto, @Query() options: PersonSearchDto): Promise<PeopleResponseDto> {
    return this.service.getAll(auth, options);
  }

  @Post()
  @Authenticated({ permission: Permission.PersonCreate })
  @Endpoint({
    summary: 'Create a person',
    description: 'Create a new person that can have multiple faces assigned to them.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  createPerson(@Auth() auth: AuthDto, @Body() dto: PersonCreateDto): Promise<PersonResponseDto> {
    return this.service.create(auth, dto);
  }

  @Put()
  @Authenticated({ permission: Permission.PersonUpdate })
  @Endpoint({
    summary: 'Update people',
    description: 'Bulk update multiple people at once.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  updatePeople(@Auth() auth: AuthDto, @Body() dto: PeopleUpdateDto): Promise<BulkIdResponseDto[]> {
    return this.service.updateAll(auth, dto);
  }

  @Delete()
  @Authenticated({ permission: Permission.PersonDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete people',
    description: 'Bulk delete a list of people at once.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  deletePeople(@Auth() auth: AuthDto, @Body() dto: BulkIdsDto): Promise<void> {
    return this.service.deleteAll(auth, dto);
  }

  // NOTE: this must be declared before `getPerson(:id)` below — both are GET and Nest
  // matches routes in declaration order, so a later position here would make
  // `/people/merge-suggestions` fall through to `:id` and fail UUID validation.
  @Get('merge-suggestions')
  @Authenticated({ permission: Permission.PersonRead })
  @Endpoint({
    summary: 'Get merge suggestions',
    description:
      'Retrieve suggested pairs of people that may be the same person, based on face similarity, for the guided merge review flow.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  getMergeSuggestions(@Auth() auth: AuthDto): Promise<MergeSuggestionsResponseDto> {
    return this.service.getMergeSuggestions(auth);
  }

  @Put('merge-suggestions/verdicts')
  @Authenticated({ permission: Permission.PersonUpdate })
  @Endpoint({
    summary: 'Record a merge suggestion verdict',
    description:
      'Answer a suggested pair of people: "same" merges them now, "different" never suggests the pair again, "later" skips it for 30 days and "ignore" stops suggesting `personId` with anyone. Replaces an earlier verdict for the same pair (a "later" never replaces a "different"); the pair may be given in either order.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  setMergeVerdict(
    @Auth() auth: AuthDto,
    @Body() dto: PersonMergeVerdictCreateDto,
  ): Promise<PersonMergeVerdictResponseDto> {
    return this.service.setMergeVerdict(auth, dto);
  }

  @Delete('merge-suggestions/verdicts')
  @Authenticated({ permission: Permission.PersonUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Undo a merge suggestion verdict',
    description:
      'Remove the recorded verdict for a pair of people, so the pair can be suggested again. The same person id twice undoes "ignore" for that person.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  deleteMergeVerdict(@Auth() auth: AuthDto, @Body() dto: PersonMergeVerdictDeleteDto): Promise<void> {
    return this.service.deleteMergeVerdict(auth, dto);
  }

  @Post('corrections/:id/undo')
  @Authenticated({ permission: Permission.PersonUpdate })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Undo a face correction',
    description:
      'Reverse one manual face decision from the correction history, while the face still stands as the decision ' +
      'left it (same original, same place, same person). Otherwise 409 with a `reason`.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  undoCorrection(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<PersonCorrectionDto> {
    return this.service.undoCorrection(auth, id);
  }

  @Get(':id')
  @Authenticated({ permission: Permission.PersonRead })
  @Endpoint({
    summary: 'Get a person',
    description: 'Retrieve a person by id.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getPerson(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<PersonResponseDto> {
    return this.service.getById(auth, id);
  }

  @Put(':id')
  @Authenticated({ permission: Permission.PersonUpdate })
  @Endpoint({
    summary: 'Update person',
    description: 'Update an individual person.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3', { replacementId: 'updatePerson' }),
  })
  updatePerson(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: PersonUpdateDto,
  ): Promise<PersonResponseDto> {
    return this.service.update(auth, id, dto);
  }

  @Patch(':id')
  @ApiExcludeEndpoint()
  @Authenticated({ permission: Permission.PersonUpdate })
  updatePersonV3(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: PersonUpdateDto,
  ): Promise<PersonResponseDto> {
    return this.service.update(auth, id, dto);
  }

  @Delete(':id')
  @Authenticated({ permission: Permission.PersonDelete })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete person',
    description: 'Delete an individual person.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  deletePerson(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.delete(auth, id);
  }

  @Get(':id/corrections')
  @Authenticated({ permission: Permission.PersonRead })
  @Endpoint({
    summary: 'Get correction history',
    description:
      'Retrieve the manual face decisions made about this person (faces moved onto or off them, "not a face of ' +
      'anyone", merges and moved face boxes), most recent first, a page at a time. Only the owner sees them. A ' +
      'photo that can no longer be shown (trashed, Locked, hidden) is left out of the evidence.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  getCorrectionHistory(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Query() dto: PersonCorrectionSearchDto,
  ): Promise<PersonCorrectionsResponseDto> {
    return this.service.getCorrectionHistory(auth, id, dto);
  }

  @Get(':id/statistics')
  @Authenticated({ permission: Permission.PersonStatistics })
  @Endpoint({
    summary: 'Get person statistics',
    description: 'Retrieve statistics about a specific person.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  getPersonStatistics(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<PersonStatisticsResponseDto> {
    return this.service.getStatistics(auth, id);
  }

  @Get(':id/thumbnail')
  @FileResponse()
  @Authenticated({ permission: Permission.PersonRead })
  @Endpoint({
    summary: 'Get person thumbnail',
    description: 'Retrieve the thumbnail file for a person.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  async getPersonThumbnail(
    @Res() res: Response,
    @Next() next: NextFunction,
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
  ) {
    await sendFile(res, next, () => this.service.getThumbnail(auth, id), this.logger);
  }

  @Put(':id/reassign')
  @Authenticated({ permission: Permission.PersonReassign })
  @Endpoint({
    summary: 'Reassign faces',
    description: 'Bulk reassign a list of faces to a different person.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
  reassignFaces(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: AssetFaceUpdateDto,
  ): Promise<PersonResponseDto[]> {
    return this.service.reassignFaces(auth, id, dto);
  }

  @Post('merge')
  @Authenticated({ permission: Permission.PersonMerge })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Merge people',
    description:
      'Merge an ordered list of people together into a single person. The final name and birth date are always the first defined value, following the order. Also automatically merges people for other users in the cluster group, skipping people that would result in overriding a previously set name or birth date.',
    history: new HistoryBuilder().added('v3.2.1').stable('v3.2.1'),
  })
  mergePeople(@Auth() auth: AuthDto, @Body() dto: MergePersonDto): Promise<BulkIdResponseDto[]> {
    return this.service.mergePeople(auth, dto);
  }

  @Post(':id/merge')
  @Authenticated({ permission: Permission.PersonMerge })
  @HttpCode(HttpStatus.OK)
  @Endpoint({
    summary: 'Merge people',
    description: 'Merge a list of people into the person specified in the path parameter.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3.2.1', { replacementId: 'mergePeople' }),
  })
  mergePersonLegacy(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: MergePersonDto,
  ): Promise<BulkIdResponseDto[]> {
    return this.service.mergePeople(auth, { ids: [id, ...dto.ids] });
  }
}
