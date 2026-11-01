import { describe, expect, it } from 'vitest';
import { sanitizeSourceUrl } from './source-url';

describe('source attribution', () => {
  it('removes credentials and transient query/fragment data', () => {
    expect(
      sanitizeSourceUrl(
        'https://user:secret@example.com:8443/work?a=secret#private',
      ),
    ).toBe('https://example.com:8443/work');
  });
  it('rejects non-web and malformed URLs', () => {
    for (const value of [
      'javascript:alert(1)',
      'file:///private/file',
      'data:image/png,a',
      '/relative',
      'not a URL',
    ])
      expect(sanitizeSourceUrl(value)).toBeNull();
  });
});
