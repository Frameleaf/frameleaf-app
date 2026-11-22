import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Patch, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Endpoint, HistoryBuilder } from 'src/decorators.js';
import { UserPlaceCreateDto, UserPlaceResponseDto, UserPlaceUpdateDto } from 'src/dtos/user-place.dto.js';
import { ApiTag, Permission } from 'src/enum.js';
import { Auth, Authenticated } from 'src/middleware/auth.guard.js';
import { UserPlaceService } from 'src/services/user-place.service.js';
import { UUIDParamDto } from 'src/validation.js';

const history = () => new HistoryBuilder().added('v3.4.0').alpha('v3.4.0');

/**
 * FL-949: your own named places ("Home", "Grandma's"). Every route is the signed-in person's own: there is no route
 * for another account, an administrator or a shared link.
 */
@ApiTags(ApiTag.Users)
@Controller('users/me/places')
export class UserPlaceController {
  constructor(private service: UserPlaceService) {}

  @Get()
  @Authenticated({ permission: Permission.UserRead })
  @Endpoint({
    summary: 'List your named places',
    description: 'The places you named, by name. Only you see them.',
    history: history(),
  })
  getUserPlaces(@Auth() auth: AuthDto): Promise<UserPlaceResponseDto[]> {
    return this.service.getAll(auth);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @Authenticated({ permission: Permission.UserUpdate })
  @Endpoint({
    summary: 'Name a place',
    description:
      'Give a name to a centre and a radius of 25 m to 5 km. Photos taken inside it show the name to you, and search finds them by it. A name is used once, whatever its capitals; you can keep up to 200 places.',
    history: history(),
  })
  createUserPlace(@Auth() auth: AuthDto, @Body() dto: UserPlaceCreateDto): Promise<UserPlaceResponseDto> {
    return this.service.create(auth, dto);
  }

  @Patch(':id')
  @Authenticated({ permission: Permission.UserUpdate })
  @Endpoint({
    summary: 'Change a named place',
    description: 'Rename, move or resize one of your places.',
    history: history(),
  })
  updateUserPlace(
    @Auth() auth: AuthDto,
    @Param() { id }: UUIDParamDto,
    @Body() dto: UserPlaceUpdateDto,
  ): Promise<UserPlaceResponseDto> {
    return this.service.update(auth, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Authenticated({ permission: Permission.UserUpdate })
  @Endpoint({
    summary: 'Remove a named place',
    description: 'Removes the name. Photos taken there keep their location.',
    history: history(),
  })
  deleteUserPlace(@Auth() auth: AuthDto, @Param() { id }: UUIDParamDto): Promise<void> {
    return this.service.delete(auth, id);
  }
}
