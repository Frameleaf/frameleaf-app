import { describe, expect, it } from 'vitest';
import { captureInput, bookmarkInput } from './capture-input';
const binding = {
  serverId: 'one',
  userId: '11111111-1111-4111-8111-111111111111',
  credentialId: '22222222-2222-4222-8222-222222222222',
  origin: 'https://frameleaf.example',
};
const candidate = {
  id: 'candidate-1',
  kind: 'image' as const,
  url: 'https://images.example/folder/r%C3%A9f%C3%A9rence.exe?signature=private#fragment',
  pageUrl: 'https://page.example/work?secret=1#part',
  title: 'x'.repeat(4096),
};
describe('capture form input', () => {
  it('keeps an explicitly confirmed bookmark target separate from sanitized attribution', () => {
    const value = bookmarkInput(
      { binding, albumId: 'album', tagIds: ['tag'], note: 'Reference' },
      'https://page.example/work?variant=2#section',
      candidate.pageUrl,
      'Page title',
      '2026-10-28T12:00:00.000Z',
    );
    expect(value.bookmark).toEqual({
      url: 'https://page.example/work?variant=2#section',
      title: 'Page title',
    });
    expect(value.source).toEqual({
      pageUrl: 'https://page.example/work',
      title: 'Page title',
      capturedAt: '2026-10-28T12:00:00.000Z',
    });
    expect(value.file).toBeUndefined();
    for (const target of [
      'javascript:alert(1)',
      'https://user:password@page.example/',
      'file:///private/file',
      'https://page.example/' + 'x'.repeat(8192),
    ])
      expect(() =>
        bookmarkInput(
          { binding, albumId: 'album', tagIds: [], note: '' },
          target,
          candidate.pageUrl,
          'Title',
        ),
      ).toThrow();
  });
  it('preserves original bytes/note/destination, sanitizes attribution and bounds the title and filename', () => {
    const blob = new Blob(['bytes'], { type: 'image/png' });
    const value = captureInput(
      { binding, albumId: 'album', tagIds: ['tag'], note: 'A complete note' },
      candidate,
      blob,
      '2026-10-28T12:00:00.000Z',
    );
    expect(value.file?.blob).toBe(blob);
    expect(value.file?.filename).toBe('référence.png');
    expect(value.source).toEqual({
      pageUrl: 'https://page.example/work',
      mediaUrl: 'https://images.example/folder/r%C3%A9f%C3%A9rence.exe',
      title: 'x'.repeat(2000),
      capturedAt: '2026-10-28T12:00:00.000Z',
    });
    expect(value.note).toBe('A complete note');
    expect(value.tagIds).toEqual(['tag']);
  });
  it('uses a safe fallback for inline images and preserves a usable URL extension for unknown MIME', () => {
    const form = { binding, albumId: 'album', tagIds: [], note: '' };
    expect(
      captureInput(
        form,
        { ...candidate, url: 'data:image/svg+xml,%3Csvg%2F%3E' },
        new Blob(['svg'], { type: 'image/svg+xml' }),
      ).file?.filename,
    ).toBe('capture.svg');
    const value = captureInput(
      form,
      {
        ...candidate,
        url: 'https://images.example/file.jpeg?signature=private',
      },
      new Blob(['bytes'], { type: 'application/octet-stream' }),
    );
    expect(value.file?.filename).toBe('file.jpeg');
  });
});
