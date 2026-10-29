import { readPageMeta } from 'src/utils/link-preview.js';
import { PublicFetchError, fetchPublic, isPublicAddress } from 'src/utils/public-fetch.js';

vi.mock('node:dns', async (importOriginal) => {
  const dns = await importOriginal<typeof import('node:dns')>();
  return {
    ...dns,
    // a public-looking name that points at this machine, as a rebinding attacker would set it up
    lookup: (hostname: string, options: unknown, callback: (...args: unknown[]) => void) =>
      hostname === 'rebind.example.com'
        ? callback(null, [{ address: '127.0.0.1', family: 4 }])
        : dns.lookup(hostname, options as never, callback as never),
  };
});

describe('isPublicAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '192.168.1.10',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '::1',
    '::',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:192.168.0.1',
  ])('refuses %s', (address) => expect(isPublicAddress(address)).toBe(false));

  it.each(['93.184.216.34', '1.1.1.1', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows %s', (address) =>
    expect(isPublicAddress(address)).toBe(true),
  );
});

describe('fetchPublic', () => {
  const options = { maxBytes: 1024, accept: 'text/html' };

  it.each([
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://169.254.169.254/latest/meta-data/',
    'http://localhost/',
    'http://printer.local/',
    'ftp://example.com/',
    'https://example.com:8080/',
    'https://user:pass@example.com/',
  ])('refuses %s before connecting', async (address) => {
    await expect(fetchPublic(address, options)).rejects.toBeInstanceOf(PublicFetchError);
  });

  it('refuses a name that resolves to a private address, at connect time', async () => {
    const error = await fetchPublic('https://rebind.example.com/', options).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(TypeError);
    expect((error as TypeError).cause).toBeInstanceOf(PublicFetchError);
  });
});

describe('readPageMeta', () => {
  it('prefers Open Graph, decodes entities and reads only the head', () => {
    expect(
      readPageMeta(`<html><head>
        <title>Plain &amp; simple</title>
        <meta property="og:title" content="Moodboard &#8212; Spring">
        <meta content='/cover.jpg' property='og:image'>
        </head><body><meta property="og:title" content="not this"></body></html>`),
    ).toEqual({ title: 'Moodboard — Spring', image: '/cover.jpg' });
  });

  it('falls back to the title and has no picture without one', () => {
    expect(readPageMeta('<head><title>\n  Studio  notes \n</title></head>')).toEqual({
      title: 'Studio notes',
      image: null,
    });
  });
});
