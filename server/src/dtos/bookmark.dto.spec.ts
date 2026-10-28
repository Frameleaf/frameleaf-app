import { BookmarkCreateDto, BookmarkUpdateDto, CaptureSourceDto } from 'src/dtos/bookmark.dto.js';
import { LibraryScope } from 'src/enum.js';

describe('designer bookmark input', () => {
  it.each([
    'javascript:alert(1)',
    'data:text/html,<script>x</script>',
    'file:///private/a',
    'https://u:p@example.org/a',
    '/relative',
    'not a URL',
  ])('rejects unsafe URL %s', (url) => {
    expect(BookmarkCreateDto.schema.safeParse({ url, title: 'Reference' }).success).toBe(false);
  });

  it('defaults to design scope and preserves plain text without interpreting markup', () => {
    expect(
      BookmarkCreateDto.schema.parse({ url: 'https://example.org/a', title: '<script>alert(1)</script>' }),
    ).toEqual({
      url: 'https://example.org/a',
      title: '<script>alert(1)</script>',
      libraryScope: LibraryScope.Design,
    });
  });

  it('does not reset omitted fields on an update', () => {
    expect(BookmarkUpdateDto.schema.parse({ title: 'Updated' })).toEqual({ title: 'Updated' });
  });

  it('rejects invalid provenance URLs and unbounded metadata', () => {
    const input = {
      captureId: '10000000-0000-4000-8000-000000000001',
      pageUrl: 'https://example.org',
      mediaUrl: 'https://example.org/a.png',
      title: 'Reference',
      capturedAt: '2026-10-28T10:00:00Z',
    };
    expect(CaptureSourceDto.schema.safeParse(input).success).toBe(true);
    expect(CaptureSourceDto.schema.safeParse({ ...input, licenseUrl: 'javascript:alert(1)' }).success).toBe(false);
    expect(CaptureSourceDto.schema.safeParse({ ...input, note: 'a'.repeat(20_001) }).success).toBe(false);
  });
});
