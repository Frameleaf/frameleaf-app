import { ApiProperty } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { UploadFieldName } from 'src/dtos/asset-media.dto.js';
import { isoDatetimeToDate } from 'src/validation.js';

export class CreateProfileImageDto {
  @ApiProperty({ type: 'string', format: 'binary', description: 'Profile image file' })
  [UploadFieldName.PROFILE_DATA]!: Express.Multer.File;

  @ApiProperty({
    type: 'string',
    format: 'uuid',
    required: false,
    description: 'ID of the photo the image was copied from, if any. A Locked photo is refused.',
  })
  assetId?: string;

  @ApiProperty({
    type: 'boolean',
    required: false,
    description:
      'The image is a new crop of the current profile picture: keep the photo it was copied from, if any. Ignored when assetId is set.',
  })
  keepSource?: boolean | 'true' | 'false';
}

const CreateProfileImageResponseSchema = z
  .object({
    userId: z.uuidv4().describe('User ID'),
    profileChangedAt: isoDatetimeToDate.describe('Profile image change date'),
    profileImagePath: z.string().describe('Profile image file path'),
  })
  .meta({ id: 'CreateProfileImageResponseDto' });

export class CreateProfileImageResponseDto extends createZodDto(CreateProfileImageResponseSchema) {}
