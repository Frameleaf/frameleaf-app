import { processingFailureCause } from 'src/queue/processing-failure.js';

describe('processingFailureCause', () => {
  it('a render over its resource limit is too large, not unreadable (FL-1353)', () => {
    expect(processingFailureCause('RAW sensor rendering failed: resource_limit')).toBe('too-large');
    expect(processingFailureCause('Sharp resource limit: Input image exceeds pixel limit')).toBe('too-large');
  });
});
