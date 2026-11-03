import { NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { CaptureCommitDto } from 'src/dtos/capture.dto.js';
import { canonicalJson } from 'src/utils/object.js';

export const captureActor = (auth: AuthDto): string => {
  if (!auth.sharedLink && !auth.system) {
    if (auth.apiKey) return `key:${auth.apiKey.id}`;
    if (auth.session) return `session:${auth.session.id}`;
  }
  throw new NotFoundException('Capture unavailable');
};

export const captureRequestHash = (dto: CaptureCommitDto): Buffer =>
  createHash('sha256')
    .update(canonicalJson({ ...dto, tagIds: [...new Set(dto.tagIds)].toSorted() }))
    .digest();
