import { describe, expect, it } from 'vitest';
import { classifyStreamError } from './preview-stream-transport';
import { classifyPreviewError } from './preview-transport';

describe('preview worker refusals', () => {
  const refusal = { status: 409, data: { code: 'studio_preview_no_worker' } };
  it('reports a missing exact-frame worker', () => {
    expect(classifyPreviewError(refusal)).toEqual({ kind: 'no-worker' });
  });
  it('reports a lost stream worker without retrying an unclaimable stream', () => {
    expect(classifyStreamError(refusal)).toEqual({ kind: 'worker-lost' });
  });
});
