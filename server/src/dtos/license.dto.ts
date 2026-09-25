import { createZodDto } from 'nestjs-zod';
import { UserSupporterSchema } from 'src/dtos/user.dto.js';

/** FL-156: the person's own supporter key, as `users/me/license` returns it. */
const LicenseResponseSchema = UserSupporterSchema.meta({ id: 'LicenseResponseDto' });

export class LicenseResponseDto extends createZodDto(LicenseResponseSchema) {}
export { UserSupporterSchema } from 'src/dtos/user.dto.js';
