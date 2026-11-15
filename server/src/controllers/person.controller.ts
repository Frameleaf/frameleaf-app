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
  PersonCategoriesResponseDto,
  PersonCategoriesSetDto,
  PersonCategoryCreateDto,
  PersonCategoryResponseDto,
  PersonCategoryUpdateDto,
} from 'src/dtos/person-category.dto.js';
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
  PersonSplitVerdictCreateDto,
  PersonSplitVerdictDeleteDto,
  PersonSplitVerdictResponseDto,
  PersonStatisticsResponseDto,
  PersonUpdateDto,
  SplitSuggestionsResponseDto,
} from 'src/dtos/person.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated, FileResponse } from 'src/middleware/auth.guard.js';
import { RemoteMediaCeiling } from 'src/middleware/rate-limit.guard.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PersonCategoryService } from 'src/services/person-category.service.js';
import { PersonService } from 'src/services/person.service.js';
import { sendFile } from 'src/utils/file.js';
import { UUIDParamDto } from 'src/validation.js';

@ApiTags(ApiTag.People)
@Controller('people')
export class PersonController {
  constructor(
    private service: PersonService,
    private logger: LoggingRepository,
    private categoryService: PersonCategoryService,
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

  // Declared before `getPerson(:id)`, like the merge suggestions above.
  @Get('split-suggestions')
  @Authenticated({ permission: Permission.PersonRead })
  @Endpoint({
    summary: 'Get split suggestions',
    description:
      'Retrieve people who may hold the faces of two different people, with a few faces from each side, for the guided review flow.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  getSplitSuggestions(@Auth() auth: AuthDto): Promise<SplitSuggestionsResponseDto> {
    return this.service.getSplitSuggestions(auth);
  }

  @Put('split-suggestions/verdicts')
  @Authenticated({ permission: Permission.PersonUpdate })
  @Endpoint({
    summary: 'Record a split suggestion verdict',
    description:
      'Answer whether a person is all one person: "split" moves the faces that look like someone else to a new, unnamed person now, "same" never asks about this person again and "later" skips it for 30 days.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  setSplitVerdict(
    @Auth() auth: AuthDto,
    @Body() dto: PersonSplitVerdictCreateDto,
  ): Promise<PersonSplitVerdictResponseDto> {
    return this.service.setSplitVerdict(auth, dto);
  }

  @Delete('split-suggestions/verdicts')
  @Authenticated({ permission: Permission.PersonUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Undo a split suggestion verdict',
    description: 'Remove a "same" or "later" answer, so the person can be suggested again.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  deleteSplitVerdict(@Auth() auth: AuthDto, @Body() dto: PersonSplitVerdictDeleteDto): Promise<void> {
    return this.service.deleteSplitVerdict(auth, dto);
  }

  // FL-874: declared before `getPerson(:id)` and the other `:id` routes, like the merge suggestions above, so
  // `/people/categories` is never read as a person id.
  @Get('categories')
  @Authenticated({ permission: Permission.PersonRead })
  @Endpoint({
    summary: 'Get person categories',
    description:
      "Retrieve the caller's categories for their people, such as Family, Friends and Work, in their order. An " +
      'account starts with Family, Friends and Work, made the first time its categories are read; once deleted, ' +
      'they are not made again. Categories are per account: a partner never sees them.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  getPersonCategories(@Auth() auth: AuthDto): Promise<PersonCategoryResponseDto[]> {
    return this.categoryService.getAll(auth);
  }

  @Post('categories')
  @Authenticated({ permission: Permission.PersonUpdate })
  @Endpoint({
    summary: 'Create a person category',
    description: "Add a category for the caller's people. It comes after the caller's other categories.",
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  createPersonCategory(
    @Auth() auth: AuthDto,
    @Body() dto: PersonCategoryCreateDto,
  ): Promise<PersonCategoryResponseDto> {
    return this.categoryService.create(auth, dto);
  }

  @Patch('categories/:id')
  @Authenticated({ permission: Permission.PersonUpdate })
  @Endpoint({
    summary: 'Update a person category',
    description: "Rename, recolor or reorder one of the caller's categories.",
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  updatePersonCategory(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: PersonCategoryUpdateDto,
  ): Promise<PersonCategoryResponseDto> {
    return this.categoryService.update(auth, id, dto);
  }

  @Delete('categories/:id')
  @Authenticated({ permission: Permission.PersonUpdate })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete a person category',
    description: "Delete one of the caller's categories. The people in it are not changed.",
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  deletePersonCategory(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.categoryService.delete(auth, id);
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

  @Put(':id/categories')
  @Authenticated({ permission: Permission.PersonUpdate })
  @Endpoint({
    summary: "Set a person's categories",
    description:
      "Put one of the caller's own people in exactly these of the caller's categories, replacing the ones they were " +
      "in. An empty list takes them out of all of them. A category that is not the caller's answers 400.",
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
  setPersonCategories(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: PersonCategoriesSetDto,
  ): Promise<PersonCategoriesResponseDto> {
    return this.categoryService.setPersonCategories(auth, id, dto);
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
  // FL-436: person thumbnails are always written as JPEG
  @FileResponse('image/jpeg')
  @Authenticated({ permission: Permission.PersonRead })
  // FL-161: shown by the dozen on the people pages; counted against the higher media ceiling
  @RemoteMediaCeiling()
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
    return this.service.mergePerson(auth, id, dto);
  }
}
