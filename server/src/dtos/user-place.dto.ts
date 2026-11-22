import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import type { Selectable } from 'kysely';
import type { UserPlaceTable } from 'src/schema/tables/user-place.table.js';
import { asDateTimeString } from 'src/utils/date.js';

/** FL-949: a person's own named places ("Home", "Grandma's"). Never returned to anyone else. */

export const USER_PLACE_NAME_MAX_LENGTH = 80;
export const USER_PLACE_MIN_RADIUS_M = 25;
export const USER_PLACE_MAX_RADIUS_M = 5000;
/** The most places one person keeps. */
export const USER_PLACE_MAX = 200;

const name = z.string().trim().min(1).max(USER_PLACE_NAME_MAX_LENGTH);
const latitude = z.number().min(-90).max(90).meta({ format: 'double' });
const longitude = z.number().min(-180).max(180).meta({ format: 'double' });
const radiusMeters = z.int().min(USER_PLACE_MIN_RADIUS_M).max(USER_PLACE_MAX_RADIUS_M);

const UserPlaceCreateSchema = z
  .object({
    name: name.describe('What you call the place'),
    latitude: latitude.describe('Latitude of its centre'),
    longitude: longitude.describe('Longitude of its centre'),
    radiusMeters: radiusMeters.describe('How far it reaches from its centre, in metres (25 to 5000)'),
  })
  .meta({ id: 'UserPlaceCreateDto' });

const UserPlaceUpdateSchema = z
  .object({
    name: name.optional().describe('What you call the place'),
    latitude: latitude.optional().describe('Latitude of its centre'),
    longitude: longitude.optional().describe('Longitude of its centre'),
    radiusMeters: radiusMeters.optional().describe('How far it reaches from its centre, in metres (25 to 5000)'),
  })
  .refine((dto) => Object.values(dto).some((value) => value !== undefined), {
    message: 'At least one of name, latitude, longitude or radiusMeters is required',
  })
  .meta({ id: 'UserPlaceUpdateDto' });

const UserPlaceResponseSchema = z
  .object({
    id: z.uuidv4().describe('Place ID'),
    name: z.string().describe('What you call the place'),
    latitude: latitude.describe('Latitude of its centre'),
    longitude: longitude.describe('Longitude of its centre'),
    radiusMeters: z.int().describe('How far it reaches from its centre, in metres'),
    createdAt: z.string().meta({ format: 'date-time' }).describe('Creation date'),
    updatedAt: z.string().meta({ format: 'date-time' }).describe('Last change'),
  })
  .meta({ id: 'UserPlaceResponseDto' });

export class UserPlaceCreateDto extends createZodDto(UserPlaceCreateSchema) {}
export class UserPlaceUpdateDto extends createZodDto(UserPlaceUpdateSchema) {}
export class UserPlaceResponseDto extends createZodDto(UserPlaceResponseSchema) {}

export type UserPlace = Pick<
  Selectable<UserPlaceTable>,
  'id' | 'name' | 'latitude' | 'longitude' | 'radiusMeters' | 'createdAt' | 'updatedAt'
>;

export const mapUserPlace = (place: UserPlace): UserPlaceResponseDto => ({
  id: place.id,
  name: place.name,
  latitude: place.latitude,
  longitude: place.longitude,
  radiusMeters: place.radiusMeters,
  createdAt: asDateTimeString(place.createdAt),
  updatedAt: asDateTimeString(place.updatedAt),
});
