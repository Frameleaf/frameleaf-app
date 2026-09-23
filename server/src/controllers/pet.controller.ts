import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post, Put, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import {
  PetCandidateListResponseDto,
  PetCandidateReviewDto,
  PetCandidateSearchDto,
  PetCreateDto,
  PetMergeDto,
  PetObservationCreateDto,
  PetObservationResponseDto,
  PetResponseDto,
  PetSearchDto,
  PetUpdateDto,
} from 'src/dtos/pet.dto.js';
import { ApiTag } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { PetService } from 'src/services/pet.service.js';
import { UUIDParamDto } from 'src/validation.js';

/**
 * Pets (FL-58).
 *
 * Route order matters: `candidates` is declared before `:id` so the review queue is not
 * swallowed by the pet lookup, and observation routes sit under `observations/:id` so a
 * durable decision can be undone by its own id.
 *
 * Every endpoint is owner-scoped inside `PetService`; there is no shared-pet concept, so
 * no endpoint here takes an owner or user parameter.
 */
@ApiTags(ApiTag.Pets)
@Controller('pets')
export class PetController {
  constructor(private service: PetService) {}

  @Get()
  @Authenticated()
  @Endpoint({
    summary: 'Retrieve pets',
    description: 'Retrieve the signed-in account’s pet identities.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getAllPets(@Auth() auth: AuthDto, @Query() dto: PetSearchDto): Promise<PetResponseDto[]> {
    return this.service.getAll(auth, dto);
  }

  @Post()
  @Authenticated()
  @Endpoint({
    summary: 'Create a pet',
    description: 'Create a durable pet identity with a name, species and optional birthday.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  createPet(@Auth() auth: AuthDto, @Body() dto: PetCreateDto): Promise<PetResponseDto> {
    return this.service.create(auth, dto);
  }

  @Get('candidates')
  @Authenticated()
  @Endpoint({
    summary: 'Retrieve pet recognition candidates',
    description:
      'Retrieve recognition proposals awaiting review, with whether a recognition model is available at all.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getPetCandidates(@Auth() auth: AuthDto, @Query() dto: PetCandidateSearchDto): Promise<PetCandidateListResponseDto> {
    return this.service.getCandidates(auth, dto);
  }

  @Post('candidates/:id/accept')
  @Authenticated()
  @Endpoint({
    summary: 'Accept a pet recognition candidate',
    description:
      'Record a durable confirmed observation for the proposed pet, or for a different pet when one is supplied.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  acceptPetCandidate(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: PetCandidateReviewDto,
  ): Promise<PetObservationResponseDto> {
    return this.service.acceptCandidate(auth, id, dto);
  }

  @Post('candidates/:id/reject')
  @Authenticated()
  @Endpoint({
    summary: 'Reject a pet recognition candidate',
    description: 'Record a durable rejection so the proposal does not return after the model is rerun.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  rejectPetCandidate(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<PetObservationResponseDto> {
    return this.service.rejectCandidate(auth, id);
  }

  @Delete('observations/:id')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Remove a pet observation',
    description: 'Undo a durable observation, whether it was drawn by hand or made in review.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  deletePetObservation(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.removeObservation(auth, id);
  }

  @Get(':id')
  @Authenticated()
  @Endpoint({
    summary: 'Retrieve a pet',
    description: 'Retrieve a single pet identity.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getPet(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<PetResponseDto> {
    return this.service.get(auth, id);
  }

  @Put(':id')
  @Authenticated()
  @Endpoint({
    summary: 'Update a pet',
    description: 'Update a pet’s name, species, birthday, featured photo, hidden or favorite state.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  updatePet(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Body() dto: PetUpdateDto): Promise<PetResponseDto> {
    return this.service.update(auth, id, dto);
  }

  @Delete(':id')
  @Authenticated()
  @HttpCode(HttpStatus.NO_CONTENT)
  @Endpoint({
    summary: 'Delete a pet',
    description: 'Delete a pet identity and every observation recorded for it.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  deletePet(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.remove(auth, id);
  }

  @Post(':id/merge')
  @Authenticated()
  @Endpoint({
    summary: 'Merge pets',
    description: 'Merge other pet identities into this one, keeping every durable observation.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  mergePets(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto, @Body() dto: PetMergeDto): Promise<PetResponseDto> {
    return this.service.merge(auth, id, dto);
  }

  @Get(':id/observations')
  @Authenticated()
  @Endpoint({
    summary: 'Retrieve pet observations',
    description: 'Retrieve the durable observations recorded for a pet.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  getPetObservations(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<PetObservationResponseDto[]> {
    return this.service.getObservations(auth, id);
  }

  @Post(':id/observations')
  @Authenticated()
  @Endpoint({
    summary: 'Add a pet observation',
    description: 'Record by hand that a pet appears in an asset, optionally with a drawn region.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
  createPetObservation(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: PetObservationCreateDto,
  ): Promise<PetObservationResponseDto> {
    return this.service.addObservation(auth, id, dto);
  }
}
