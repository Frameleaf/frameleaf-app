import { createHash } from 'node:crypto';
import type { ConfigFFmpegDto } from 'src/dtos/config.dto.js';
import { canonicalJson } from 'src/utils/object.js';

export const videoProcessingPolicy = (config: ConfigFFmpegDto) =>
  createHash('sha256').update(canonicalJson(config)).digest('hex');
