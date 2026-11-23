import { LoginResponseDto } from '@frameleaf/sdk';
import { createUserDto } from 'src/fixtures.js';
import { makeRandomImage } from 'src/generators.js';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * FL-920: import connections, against the server's in-memory test source (`fake`), which a server
 * started with `FRAMELEAF_ENV=testing` registers. Its "credentials" are the remote itself: a token and
 * the files it holds, so each test describes a remote through the API.
 */

const SECRET = 'hunter2-app-password';

type RemoteFile = { path: string; data: string; caption?: string; favourite?: boolean; albumHint?: string | null };
type Run = { id: string; state: string; counts: Record<string, number>; albums: Array<{ name: string }> };

const image = () => makeRandomImage(32, 32);
const remote = (path: string, extra: Partial<RemoteFile> = {}): RemoteFile => ({
  path,
  data: image().toString('base64'),
  ...extra,
});

describe('/import-connections', () => {
  let admin: LoginResponseDto;
  let owner: LoginResponseDto;
  let stranger: LoginResponseDto;

  const as = (user: LoginResponseDto) => asBearerAuth(user.accessToken);
  const connect = async (files: RemoteFile[], token = SECRET) => {
    const { status, body } = await request(app)
      .post('/import-connections')
      .set(as(owner))
      .send({ provider: 'fake', displayName: 'My Nextcloud', credentials: { token, files }, dailyCheck: false });
    expect(status).toBe(201);
    return body as { id: string };
  };
  /** Wait for the job working on a run to stop, and return the run. */
  const settle = async (connectionId: string, runId: string): Promise<Run> => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const { body } = await request(app).get(`/import-connections/${connectionId}/runs/${runId}`).set(as(owner));
      if (['review', 'completed', 'failed', 'cancelled'].includes(body.state)) {
        return body;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error('The run did not settle');
  };
  const scan = async (connectionId: string) => {
    const { status, body } = await request(app).post(`/import-connections/${connectionId}/scan`).set(as(owner));
    expect(status).toBe(200);
    return settle(connectionId, body.id);
  };
  const importRun = async (connectionId: string, runId: string) => {
    const { status } = await request(app)
      .post(`/import-connections/${connectionId}/runs/${runId}/import`)
      .set(as(owner))
      .send({});
    expect(status).toBe(200);
    return settle(connectionId, runId);
  };
  const itemsOf = async (connectionId: string, runId: string) => {
    const { body } = await request(app).get(`/import-connections/${connectionId}/runs/${runId}/items`).set(as(owner));
    return body.items as Array<{ path: string; state: string; assetId: string | null }>;
  };
  const assetOf = async (id: string) => {
    const { body } = await request(app).get(`/assets/${id}`).set(as(owner));
    return body;
  };
  /** The album list counts in the background (FL-1297): an album not counted yet says `statsPending`. */
  const albumsOf = async () => {
    for (let attempt = 0; attempt < 120; attempt++) {
      const { body } = await request(app).get('/albums').set(as(owner));
      const albums = body as Array<{ id: string; albumName: string; assetCount: number; statsPending?: boolean }>;
      if (albums.every(({ statsPending }) => !statsPending)) {
        return albums;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('The album counts did not settle');
  };

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    [owner, stranger] = await Promise.all([
      utils.userSetup(admin.accessToken, createUserDto.user1),
      utils.userSetup(admin.accessToken, createUserDto.user2),
    ]);
  });

  it('requires authentication', async () => {
    const { status } = await request(app).get('/import-connections');
    expect(status).toBe(401);
  });

  it('lists the test source among the kinds this server can connect to', async () => {
    const { status, body } = await request(app).get('/import-connections/providers').set(as(owner));
    expect(status).toBe(200);
    expect(body.providers).toContain('fake');
  });

  it('refuses a sign-in the source does not accept', async () => {
    const { status } = await request(app)
      .post('/import-connections')
      .set(as(owner))
      .send({ provider: 'fake', displayName: 'Expired', credentials: { token: 'expired', files: [] } });
    expect(status).toBe(400);
  });

  it('imports a fake source: albums created, captions to descriptions, favourites kept, duplicates skipped', async () => {
    const duplicate = image();
    const existing = await utils.createAsset(owner.accessToken, {
      assetData: { bytes: duplicate, filename: 'already-here.png' },
    });
    const connection = await connect([
      remote('Trips/Italy/rome.png', { caption: 'Rome at dusk', favourite: true }),
      remote('Trips/Italy/pisa.png'),
      remote('Camera/loose.png', { albumHint: null }),
      { path: 'Camera/already-here.png', data: duplicate.toString('base64') },
      remote('Trips/notes.txt'),
    ]);

    const folders = await request(app).get(`/import-connections/${connection.id}/folders`).set(as(owner));
    expect(folders.body.folders).toEqual([
      { path: 'Camera', name: 'Camera' },
      { path: 'Trips', name: 'Trips' },
    ]);

    const review = await scan(connection.id);
    expect(review.state).toBe('review');
    expect(review.counts).toMatchObject({ items: 4, ready: 4, rejected: 1 });
    expect(review.albums.map(({ name }) => name)).toEqual(['Camera', 'Italy']);

    const done = await importRun(connection.id, review.id);
    expect(done.state).toBe('completed');
    expect(done.counts).toMatchObject({ imported: 3, matched: 1, failed: 0 });

    const items = await itemsOf(connection.id, review.id);
    const byPath = new Map(items.map((item) => [item.path, item]));
    expect(byPath.get('Camera/already-here.png')).toMatchObject({ state: 'matched', assetId: existing.id });
    const rome = await assetOf(byPath.get('Trips/Italy/rome.png')!.assetId!);
    expect(rome.isFavorite).toBe(true);
    expect(rome.exifInfo.description).toBe('Rome at dusk');
    const pisa = await assetOf(byPath.get('Trips/Italy/pisa.png')!.assetId!);
    expect(pisa.isFavorite).toBe(false);

    const albums = await albumsOf();
    const byName = albums.toSorted((a, b) => a.albumName.localeCompare(b.albumName));
    expect(byName.map(({ albumName, assetCount }) => [albumName, assetCount])).toEqual([
      ['Camera', 1],
      ['Italy', 2],
    ]);
    const list = await request(app).get('/import-connections').set(as(owner));
    expect(list.body).toEqual([expect.objectContaining({ id: connection.id, importedItems: 4, status: 'active' })]);
  });

  it('imports only what is new on a later scan, and a file removed at the source changes nothing here', async () => {
    const kept = remote('Later/kept.png');
    const removed = remote('Later/removed.png');
    const connection = await connect([kept, removed]);
    const first = await scan(connection.id);
    await importRun(connection.id, first.id);
    const before = await itemsOf(connection.id, first.id);
    const removedAssetId = before.find(({ path }) => path === 'Later/removed.png')!.assetId!;

    // The remote now holds one file fewer and one new one (signing in again describes the new remote).
    const { status } = await request(app)
      .patch(`/import-connections/${connection.id}`)
      .set(as(owner))
      .send({ credentials: { token: SECRET, files: [kept, remote('Later/new.png')] } });
    expect(status).toBe(200);

    const second = await scan(connection.id);
    expect(second.counts).toMatchObject({ items: 1, ready: 1 });
    const done = await importRun(connection.id, second.id);
    expect(done.counts).toMatchObject({ items: 1, imported: 1 });

    const still = await assetOf(removedAssetId);
    expect(still).toMatchObject({ id: removedAssetId, isTrashed: false });
    const albums = await albumsOf();
    const later = albums.find(({ albumName }) => albumName === 'Later')!;
    expect(later.assetCount).toBe(3);
    expect(await itemsOf(connection.id, first.id)).toEqual(before);
    // Two scans and two imports, each waited on, do not fit the default 15 seconds on a loaded runner.
  }, 60_000);

  it('never returns the credentials', async () => {
    const connection = await connect([remote('Secret/a.png')]);
    const run = await scan(connection.id);
    const answers = await Promise.all(
      [
        '/import-connections',
        `/import-connections/${connection.id}`,
        `/import-connections/${connection.id}/runs`,
        `/import-connections/${connection.id}/runs/${run.id}`,
        `/import-connections/${connection.id}/runs/${run.id}/items`,
      ].map((path) => request(app).get(path).set(as(owner))),
    );
    for (const { status, text } of answers) {
      expect(status).toBe(200);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('credentials');
    }
    const statistics = await request(app).get('/import-connections/statistics').set(as(admin));
    expect(statistics.text).not.toContain(SECRET);
  });

  it('shows a connection to its owner only, and gives an administrator counts only', async () => {
    const connection = await connect([remote('Mine/a.png')]);
    const run = await scan(connection.id);

    const list = await request(app).get('/import-connections').set(as(stranger));
    expect(list.body).toEqual([]);
    const base = `/import-connections/${connection.id}`;
    const refused = await Promise.all([
      request(app).get(base).set(as(stranger)),
      request(app).get(base).set(as(admin)),
      request(app).patch(base).set(as(stranger)).send({ dailyCheck: true }),
      request(app).delete(base).set(as(stranger)),
      request(app).get(`${base}/folders`).set(as(stranger)),
      request(app).put(`${base}/roots`).set(as(stranger)).send({ roots: [] }),
      request(app).post(`${base}/scan`).set(as(stranger)),
      request(app).get(`${base}/runs`).set(as(admin)),
      request(app).get(`${base}/runs/${run.id}`).set(as(stranger)),
      request(app).get(`${base}/runs/${run.id}/items`).set(as(stranger)),
      request(app).post(`${base}/runs/${run.id}/import`).set(as(stranger)).send({}),
      request(app).post(`${base}/runs/${run.id}/control`).set(as(stranger)).send({ action: 'cancel' }),
      // A connection's run is not a Google Photos import, even for its owner.
      request(app).get(`/takeout/${run.id}`).set(as(owner)),
    ]);
    expect(refused.map(({ status }) => status)).toEqual(refused.map(() => 404));
    const takeout = await request(app).get('/takeout').set(as(owner));
    expect(takeout.body).toEqual([]);

    const forbidden = await request(app).get('/import-connections/statistics').set(as(owner));
    expect(forbidden.status).toBe(403);
    const statistics = await request(app).get('/import-connections/statistics').set(as(admin));
    expect(statistics.status).toBe(200);
    expect(Object.keys(statistics.body).toSorted((a, b) => a.localeCompare(b))).toEqual(['providers', 'total']);
    expect(statistics.body.providers).toEqual([
      { provider: 'fake', connections: statistics.body.total, dailyCheck: expect.any(Number) },
    ]);
  });

  it('removes a connection and keeps the photos it brought in', async () => {
    const connection = await connect([remote('Gone/a.png')]);
    const run = await scan(connection.id);
    await importRun(connection.id, run.id);
    const [{ assetId }] = await itemsOf(connection.id, run.id);

    const { status } = await request(app).delete(`/import-connections/${connection.id}`).set(as(owner));
    expect(status).toBe(204);

    const { status: afterDelete } = await request(app).get(`/import-connections/${connection.id}`).set(as(owner));
    expect(afterDelete).toBe(404);
    expect(await assetOf(assetId!)).toMatchObject({ id: assetId, isTrashed: false });
  });
});
