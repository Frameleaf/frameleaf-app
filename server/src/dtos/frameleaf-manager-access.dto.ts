import { createZodDto } from 'nestjs-zod';
import z from 'zod';

export class ManagerAccessDto extends createZodDto(
  z.object({
    url: z
      .url()
      .nullable()
      .describe(
        'Deployment-configured HTTPS Manager origin, or null when unavailable. Requires separate Manager sign-in; configuration is not a reachability check.',
      ),
  }),
) {}
