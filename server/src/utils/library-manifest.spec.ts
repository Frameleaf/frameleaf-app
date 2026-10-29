import { BadRequestException } from '@nestjs/common';
import { portableCaptureSource } from 'src/utils/library-manifest.js';

const source = (pageUrl: string) => ({
  captureId: '11111111-1111-4111-8111-111111111111',
  pageUrl,
  title: 'Reference',
  capturedAt: '2026-01-01T00:00:00.000Z',
});
it('removes browser credentials, query and fragment from attribution', () => {
  expect(portableCaptureSource(source('https://user:secret@example.com/path?token=secret#private')).pageUrl).toBe(
    'https://example.com/path',
  );
});
it.each(['broken URL', 'file:///private/example', 'javascript:alert(1)'])(
  'refuses invalid legacy source URL %s with a safe client error',
  (url) => {
    expect(() => portableCaptureSource(source(url))).toThrow(BadRequestException);
  },
);
