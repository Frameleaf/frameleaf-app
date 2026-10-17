import { defineParams } from '@sveltejs/kit/params';
import { UUID_REGEX } from './lib/uuid.ts';

export const params = defineParams({
  id: (param) => (UUID_REGEX.test(param) ? param : undefined),
  photos: (param) => (param === 'photos' ? param : undefined),
});
