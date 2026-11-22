import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  USER_PLACE_MAX,
  UserPlaceCreateDto,
  UserPlaceResponseDto,
  UserPlaceUpdateDto,
  mapUserPlace,
} from 'src/dtos/user-place.dto.js';
import { BaseService } from 'src/services/base.service.js';

const isUniqueViolation = (error: unknown): boolean => (error as { code?: string } | null)?.code === '23505';

/**
 * FL-949: places a person names, each a centre and a radius: "Home", "Grandma's". Their photos taken there show the
 * name in the info line (`BaseService.withNamedPlace`), search finds them by it (`namedPlaceIds`), and a memory
 * mostly taken there carries it. Everything here is the caller's own: a partner sees where a photo was taken, never
 * what its owner calls the place, and a shared link sees neither list nor name.
 */
@Injectable()
export class UserPlaceService extends BaseService {
  async getAll(auth: AuthDto): Promise<UserPlaceResponseDto[]> {
    const places = await this.mapRepository.getUserPlaces(auth.user.id);
    return places.map((place) => mapUserPlace(place));
  }

  async create(auth: AuthDto, dto: UserPlaceCreateDto): Promise<UserPlaceResponseDto> {
    const ownerId = auth.user.id;
    // ponytail: counted before the insert, so two requests at once can pass 200 by one; a lock if that ever matters
    if ((await this.mapRepository.countUserPlaces(ownerId)) >= USER_PLACE_MAX) {
      throw new BadRequestException(`You can keep up to ${USER_PLACE_MAX} places; remove one to add another`);
    }
    const place = await this.named(() => this.mapRepository.createUserPlace({ ownerId, ...dto }));
    return mapUserPlace(place);
  }

  async update(auth: AuthDto, id: string, dto: UserPlaceUpdateDto): Promise<UserPlaceResponseDto> {
    const place = await this.named(() => this.mapRepository.updateUserPlace(auth.user.id, id, dto));
    if (!place) {
      throw new NotFoundException('Place not found');
    }
    return mapUserPlace(place);
  }

  /** Removes the name. Photos taken there keep their location. */
  async delete(auth: AuthDto, id: string): Promise<void> {
    if (!(await this.mapRepository.deleteUserPlace(auth.user.id, id))) {
      throw new NotFoundException('Place not found');
    }
  }

  private async named<T>(write: () => Promise<T>): Promise<T> {
    try {
      return await write();
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new BadRequestException('You already have a place with this name');
      }
      throw error;
    }
  }
}
