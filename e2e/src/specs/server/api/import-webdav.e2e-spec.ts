import { LoginResponseDto } from '@frameleaf/sdk';
import { createUserDto } from 'src/fixtures.js';
import { makeRandomImage } from 'src/generators.js';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * FL-944, WRITTEN, NOT RUN: a real WebDAV server (`rclone serve webdav`, docker-compose.webdav-fixture.yml).
 * Skipped unless FRAMELEAF_E2E_WEBDAV=1, because the default stack does not start the fixture.
 *
 * The spec reaches the fixture on the published port and the server reaches it through the Docker host
 * gateway, a private address, so the connection needs `allowPrivateAddress`.
 */
const FROM_SPEC = 'http://127.0.0.1:2298';
const FROM_SERVER = 'http://host.docker.internal:2298/';
const USERNAME = 'frameleaf';
const PASSWORD = 'test-only-webdav-password';
const AUTH = `Basic ${Buffer.from(`${USERNAME}:${PASSWORD}`).toString('base64')}`;
const FOLDERS = 10;
const PER_FOLDER = 100;

type Run = { id: string; state: string; counts: Record<string, number>; albums: Array<{ name: string }> };

const dav = (method: string, path: string, init: RequestInit = {}) =>
  fetch(`${FROM_SPEC}/${path}`, { ...init, method, headers: { authorization: AUTH, ...init.headers } });

/** Every file's ETag, read with the same Depth 1 requests the importer is limited to. */
const etags = async (folder = '', found = new Map<string, string>()) => {
  const response = await dav('PROPFIND', folder, { headers: { depth: '1' } });
  const xml = await response.text();
  for (const [block] of xml.matchAll(/<[^>]*response[ >][\s\S]*?<\/[^>]*response>/g)) {
    const href = decodeURIComponent(/<[^>]*href>([^<]*)</.exec(block)?.[1] ?? '').replace(/^\/+/, '');
    if (/<[^>]*collection\s*\/>/.test(block)) {
      if (href.replace(/\/$/, '') !== folder.replace(/\/$/, '')) {
        await etags(href, found);
      }
    } else {
      found.set(href, /<[^>]*getetag>([^<]*)</.exec(block)?.[1] ?? '');
    }
  }
  return found;
};

describe.skipIf(!process.env.FRAMELEAF_E2E_WEBDAV)('import from WebDAV', () => {
  let owner: LoginResponseDto;
  const as = () => asBearerAuth(owner.accessToken);
  const credentials = { url: FROM_SERVER, username: USERNAME, password: PASSWORD, allowPrivateAddress: true };

  const settle = async (connectionId: string, runId: string): Promise<Run> => {
    for (let attempt = 0; attempt < 1200; attempt++) {
      const { body } = await request(app).get(`/import-connections/${connectionId}/runs/${runId}`).set(as());
      if (['review', 'completed', 'failed', 'cancelled'].includes(body.state)) {
        return body;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('The run did not settle');
  };

  beforeAll(async () => {
    await utils.resetDatabase();
    const admin = await utils.adminSetup();
    owner = await utils.userSetup(admin.accessToken, createUserDto.user1);
    for (let folder = 0; folder < FOLDERS; folder++) {
      const path = `Trips/Year ${2015 + folder}`;
      await dav('MKCOL', 'Trips/');
      await dav('MKCOL', `${encodeURI(path)}/`);
      for (let start = 0; start < PER_FOLDER; start += 20) {
        await Promise.all(
          Array.from({ length: 20 }, (_, index) =>
            dav('PUT', `${encodeURI(path)}/photo-${start + index}.png`, { body: makeRandomImage(16, 16) }),
          ),
        );
      }
    }
    await dav('MKCOL', '.trash/');
    await dav('PUT', '.trash/deleted.png', { body: makeRandomImage(16, 16) });
  }, 300_000);

  it('refuses a wrong password when connecting, and stores nothing', async () => {
    const { status, body } = await request(app)
      .post('/import-connections')
      .set(as())
      .send({
        provider: 'webdav',
        displayName: 'Wrong',
        credentials: { ...credentials, password: 'not-the-password' },
      });
    expect(status).toBe(400);
    expect(JSON.stringify(body)).not.toContain('not-the-password');
    const { body: connections } = await request(app).get('/import-connections').set(as());
    expect(connections).toEqual([]);
  });

  it('refuses a private address without the allowance', async () => {
    const { status } = await request(app)
      .post('/import-connections')
      .set(as())
      .send({ provider: 'webdav', displayName: 'No', credentials: { ...credentials, allowPrivateAddress: false } });
    expect(status).toBe(400);
  });

  it('imports 1,000 photos in nested folders with an album per folder and changes nothing', async () => {
    const before = await etags();
    expect(before.size).toBe(FOLDERS * PER_FOLDER + 1);

    const { status, body: connection } = await request(app)
      .post('/import-connections')
      .set(as())
      .send({ provider: 'webdav', displayName: 'Fixture', credentials, roots: [] });
    expect(status).toBe(201);
    expect(JSON.stringify(connection)).not.toContain(PASSWORD);

    const { body: started } = await request(app).post(`/import-connections/${connection.id}/scan`).set(as());
    const scanned = await settle(connection.id, started.id);
    expect(scanned.state).toBe('review');
    expect(scanned.counts.items).toBe(FOLDERS * PER_FOLDER);
    expect(scanned.albums).toHaveLength(FOLDERS);

    await request(app).post(`/import-connections/${connection.id}/runs/${started.id}/import`).set(as()).send({});
    const imported = await settle(connection.id, started.id);
    expect(imported.state).toBe('completed');
    expect(imported.counts.failed).toBe(0);

    const { body: albums } = await request(app).get('/albums').set(as());
    expect(albums).toHaveLength(FOLDERS);
    expect(await etags()).toEqual(before);
  }, 600_000);
});
