import { describe, expect, it } from 'vitest';
import { libraryReferenceUrl } from './library-reference';

describe('saved reference links', () => {
  it('opens explicit HTTP(S) references without accepting credentials or executable schemes', () => {
    expect(libraryReferenceUrl('https://example.org/reference?q=deliberate')).toBe(
      'https://example.org/reference?q=deliberate',
    );
    for (const value of [
      'javascript:alert(1)',
      'data:text/html,x',
      'https://u:p@example.org',
      '/relative',
      'invalid',
    ]) {
      expect(libraryReferenceUrl(value)).toBeUndefined();
    }
  });
});
