import { describe, expect, it, vi } from 'vitest';
import { defaults } from '@frameleaf/sdk';
import {
  connectServer,
  createAlbum,
  getCatalog,
  normalizeServerAddress,
  serverPermissionPattern,
} from './api';

const capabilities = {
  version: 1,
  captureSupported: true,
  serverId: 'server-a',
  userId: '11111111-1111-4111-8111-111111111111',
  maxFileBytes: 104857600,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('capture server boundary', () => {
  it('creates a design album at the chosen parent and projects only destination fields', async () => {
    const parentId = '22222222-2222-4222-8222-222222222222';
    const created = {
      id: '33333333-3333-4333-8333-333333333333',
      albumName: 'Packaging',
      parentId,
      libraryScope: 'design',
      unexpected: 'private',
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(capabilities))
      .mockResolvedValueOnce(json(created));
    vi.stubGlobal('fetch', fetch);
    try {
      const binding = {
        origin: 'https://photos.example/frameleaf',
        serverId: capabilities.serverId,
        userId: capabilities.userId,
        credentialId: 'key',
      };
      expect(
        await createAlbum(binding, 'selected-key', ' Packaging ', parentId),
      ).toEqual({ id: created.id, albumName: 'Packaging', parentId });
      expect(fetch.mock.calls[1][0]).toBe(
        'https://photos.example/frameleaf/api/capture/albums',
      );
      expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
        name: 'Packaging',
        parentId,
        libraryScope: 'design',
      });
      expect(new Headers(fetch.mock.calls[1][1].headers).get('x-api-key')).toBe(
        'selected-key',
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('does not retry an ambiguous album creation and does not accept an unrelated destination response', async () => {
    const binding = {
      origin: 'https://photos.example',
      serverId: capabilities.serverId,
      userId: capabilities.userId,
      credentialId: 'key',
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(capabilities))
      .mockRejectedValueOnce(new Error('secret transport diagnostic'));
    vi.stubGlobal('fetch', fetch);
    try {
      await expect(
        createAlbum(binding, 'selected-key', 'Packaging'),
      ).rejects.toThrow('Refresh collections');
      expect(fetch).toHaveBeenCalledTimes(2);
      fetch
        .mockReset()
        .mockResolvedValueOnce(json(capabilities))
        .mockResolvedValueOnce(
          json({
            id: '33333333-3333-4333-8333-333333333333',
            albumName: 'Other',
            parentId: null,
          }),
        );
      await expect(
        createAlbum(binding, 'selected-key', 'Packaging'),
      ).rejects.toThrow('Refresh collections');
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it.each([
    { status: 401, value: {}, code: 'authorization' },
    {
      status: 200,
      value: { ...capabilities, version: 2 },
      code: 'unsupported',
    },
    {
      status: 200,
      value: {
        ...capabilities,
        userId: '22222222-2222-4222-8222-222222222222',
      },
      code: 'identity',
    },
  ])(
    'preserves fatal preflight classification before album mutation: $code',
    async ({ status, value, code }) => {
      const fetch = vi.fn().mockResolvedValue(json(value, status));
      vi.stubGlobal('fetch', fetch);
      try {
        const binding = {
          origin: 'https://photos.example',
          serverId: capabilities.serverId,
          userId: capabilities.userId,
          credentialId: 'key',
        };
        await expect(
          createAlbum(binding, 'selected-key', 'Packaging'),
        ).rejects.toMatchObject({ code });
        expect(fetch).toHaveBeenCalledOnce();
        expect(fetch.mock.calls[0][1].method).not.toBe('POST');
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
  it('normalizes the site and optional API suffix without losing a deployment subpath', () => {
    expect(
      normalizeServerAddress('https://photos.example/frameleaf/api/'),
    ).toBe('https://photos.example/frameleaf');
    expect(normalizeServerAddress('https://photos.example/')).toBe(
      'https://photos.example',
    );
    expect(
      serverPermissionPattern('https://photos.example:9443/frameleaf'),
    ).toBe('https://photos.example/*');
  });
  it.each([
    'http://photos.example',
    'https://user:secret@photos.example',
    'https://photos.example/?token=private',
    'https://photos.example/#key',
    'file:///tmp/server',
    'javascript:alert(1)',
    'https://photos.example/a%2fb',
    'https://photos.example/a\\b',
  ])('refuses unsafe address %s', (url) => {
    expect(() => normalizeServerAddress(url)).toThrow();
  });
  it('allows HTTP only for explicit loopback development', () => {
    expect(() => normalizeServerAddress('http://localhost:2283')).toThrow();
    expect(normalizeServerAddress('http://127.0.0.1:2283', true)).toBe(
      'http://127.0.0.1:2283',
    );
    expect(() =>
      normalizeServerAddress('http://localhost.evil.test', true),
    ).toThrow();
    expect(() => normalizeServerAddress('http://192.168.1.10', true)).toThrow();
  });
  it('uses the generated contract with no cookies, referrer or redirect forwarding', async () => {
    const fetch = vi.fn().mockResolvedValue(json(capabilities));
    const binding = await connectServer(
      'https://photos.example/frameleaf',
      'capture-key',
      { fetch },
    );
    expect(binding).toMatchObject({
      serverId: capabilities.serverId,
      userId: capabilities.userId,
      origin: 'https://photos.example/frameleaf',
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(
      'https://photos.example/frameleaf/api/capture/capabilities',
    );
    expect(new Headers(init.headers).get('x-api-key')).toBe('capture-key');
    expect(init).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      cache: 'no-store',
    });
  });
  it("does not inherit another caller's authentication from SDK defaults", async () => {
    const before = defaults.headers;
    defaults.headers = { Authorization: 'unrelated-session' };
    try {
      const fetch = vi.fn().mockResolvedValue(json(capabilities));
      await connectServer('https://photos.example', 'capture-key', { fetch });
      const headers = new Headers(fetch.mock.calls[0][1].headers);
      expect(headers.get('authorization')).toBeNull();
      expect(headers.get('x-api-key')).toBe('capture-key');
    } finally {
      defaults.headers = before;
    }
  });
  it.each([
    { ...capabilities, version: 2 },
    { ...capabilities, captureSupported: false },
    { ...capabilities, userId: '' },
    { ...capabilities, maxFileBytes: -1 },
  ])('rejects incompatible or malformed capabilities', async (value) => {
    await expect(
      connectServer('https://photos.example', 'key', {
        fetch: vi.fn().mockResolvedValue(json(value)),
      }),
    ).rejects.toThrow();
  });
  it('stops at redirects and never includes a server response or credential in an error', async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response('echo-private-key', {
        status: 302,
        headers: { Location: 'https://elsewhere.example/' },
      }),
    );
    await expect(
      connectServer('https://photos.example', 'echo-private-key', { fetch }),
    ).rejects.toThrow('Could not connect');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('checks the bound server and user before requesting private catalog data', async () => {
    const fetch = vi.fn().mockResolvedValue(json(capabilities));
    const binding = await connectServer('https://photos.example', 'key', {
      fetch,
    });
    fetch.mockResolvedValue(
      json({ ...capabilities, userId: '22222222-2222-4222-8222-222222222222' }),
    );
    await expect(getCatalog(binding, 'key', fetch)).rejects.toThrow(
      'different server or account',
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('projects known catalog fields instead of caching an arbitrary server response', async () => {
    const album = {
      id: '22222222-2222-4222-8222-222222222222',
      albumName: 'Inspiration',
      parentId: null,
      color: 'teal' as const,
      icon: 'mdiPalette',
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json(capabilities))
      .mockResolvedValueOnce(json(capabilities))
      .mockResolvedValueOnce(
        json({
          albums: [{ ...album, unexpected: 'not-cached' }],
          tags: [],
          unexpected: 'not-cached',
        }),
      );
    const binding = await connectServer('https://photos.example', 'key', {
      fetch,
    });
    expect(await getCatalog(binding, 'key', fetch)).toEqual({
      albums: [album],
      tags: [],
    });
  });
  it('bounds streamed metadata even without a Content-Length header', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(new Response(new Uint8Array(8 * 1024 * 1024 + 1)));
    await expect(
      connectServer('https://photos.example', 'key', { fetch }),
    ).rejects.toThrow('too large');
  });
});
