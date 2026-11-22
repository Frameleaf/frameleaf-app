import { HttpException } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { HouseholdReceiveService } from 'src/services/household-receive.service.js';
import { HouseholdBadPage, parseHouseholdPage } from 'src/utils/household-manifest.js';
import { startReceiver } from 'test/fixtures/household-receive.js';
import {
  type HouseholdCloud,
  type HouseholdServer,
  householdRequest,
  startHouseholdCloud,
  startHouseholdServer,
} from 'test/fixtures/household-servers.js';

vi.mock('src/utils/config.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getConfig: (repos: { configRepo: { serverName?: string } }) =>
    Promise.resolve({
      server: { name: repos.configRepo.serverName },
      machineLearning: { facialRecognition: { maxDistance: 0.5 } },
    }),
}));

type Serve = (assetId: string, bytes: Buffer, range: string | null) => Response | undefined;
type Page = { entries: Array<Record<string, any>>; nextCursor: string; complete: boolean; [key: string]: unknown };

/**
 * FL-994: Ben's server receives a space from Anna's. Grants, proofs, signatures, tokens, hashing and files on disk
 * are real, and Anna is the real FL-979 sender; only the databases are in memory (the medium spec covers the SQL).
 */
describe(HouseholdReceiveService.name, () => {
  let fixture: HouseholdCloud;
  let anna: HouseholdServer;
  let ben: HouseholdServer;
  let receiver: ReturnType<typeof startReceiver>;
  let media: string;
  let cloudLink: string;
  let ownerId: string;
  let spaceId: string;
  let serve: Serve | undefined;
  let ranges: Array<string | null>;
  let originalCalls: string[];
  const originals = new Map<string, Buffer>();
  const benUser = randomUUID();
  const benOther = randomUUID();

  const auth = (id = benUser) => ({ user: { id } }) as unknown as AuthDto;
  const benLink = () => ben.links.rows[0];
  const annaLink = () => anna.links.rows.find((row) => row.cloudLinkId === cloudLink)!;
  const status = (promise: Promise<unknown>) =>
    promise
      .then(() => 200)
      .catch((error: unknown) => {
        if (error instanceof HttpException) return error.getStatus();
        throw error;
      });

  /** Carries Ben's calls to Anna's real controller, and serves originals after her real token and visibility checks. */
  const connect = () => {
    const real = fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!url.hostname.endsWith('.test')) {
        return real(input, init);
      }
      if (url.host !== anna.host) {
        throw new TypeError('fetch failed');
      }
      const headers = init?.headers as Record<string, string>;
      const request = householdRequest(url.href, headers, { method: init?.method ?? 'GET' });
      const response = { setHeader: vi.fn() } as never;
      const path = url.pathname.replace(`/api/household/v1/links/${cloudLink}/`, '');
      const parts = path.split('/');
      try {
        if (path === 'handshake') return Response.json(await anna.controller.handshake(cloudLink, request, response));
        if (path === 'shares') return Response.json(await anna.controller.offered(cloudLink, request, response));
        if (parts[2] === 'manifest') {
          const query = url.searchParams;
          return Response.json(
            await anna.controller.manifest(
              cloudLink,
              parts[1],
              query.get('cursor') ?? undefined,
              query.get('limit') ?? undefined,
              request,
              response,
            ),
          );
        }
        if (parts[4] === 'accept') {
          return Response.json(await anna.controller.accept(cloudLink, parts[1], parts[3], request, response));
        }
        if (parts[4] === 'leave') {
          return Response.json(await anna.controller.leave(cloudLink, parts[1], parts[3], request, response));
        }
        if (parts[2] === 'originals') {
          const access = await anna.peer.authorize(request, cloudLink);
          const file = await anna.shares.original(access, parts[1], parts[3], url.searchParams.get('token'));
          await file.release?.();
          originalCalls.push(parts[3]);
          const range = headers.Range ?? null;
          ranges.push(range);
          const bytes = originals.get(parts[3])!;
          const custom = serve?.(parts[3], bytes, range);
          if (custom) return custom;
          if (range) {
            const start = Number(/bytes=(\d+)-/.exec(range)![1]);
            return new Response(bytes.subarray(start), {
              status: 206,
              headers: { 'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` },
            });
          }
          return new Response(bytes);
        }
      } catch (error) {
        if (error instanceof HttpException) {
          return Response.json(error.getResponse(), { status: error.getStatus() });
        }
        throw error;
      }
      throw new TypeError('fetch failed');
    });
  };

  /** A real file on Anna's side. The fixture's manifest reports every item as 1000 bytes. */
  const addItem = (change: Record<string, unknown> = {}, sha1 = false) => {
    const bytes = randomBytes(1000);
    const checksum = createHash(sha1 ? 'sha1' : 'sha256')
      .update(bytes)
      .digest();
    const item = anna.world.addItem(spaceId, { checksum, ...change });
    originals.set(item.id, bytes);
    return item;
  };
  const invite = async (userId = benUser) => {
    const shareId = (await anna.world.invite({
      albumId: spaceId,
      linkId: annaLink().id,
      remoteUserId: userId,
      displayName: 'Ben',
      role: 'viewer',
    })) as string;
    return shareId;
  };
  const inbound = (userId = benUser) => receiver.receive.shares.find((share) => share.userId === userId)!;
  const accept = async (userId = benUser) => {
    await invite(userId);
    await receiver.service.poll(await linkRow());
    await receiver.service.accept(auth(userId), inbound(userId).id);
    return inbound(userId);
  };
  const linkRow = async () => (await ben.links.get(benLink().id)) as never;
  const pull = async (userId = benUser) => {
    const share = inbound(userId);
    share.nextPullAt = null;
    await receiver.service.pull(await linkRow(), { ...share });
    return inbound(userId);
  };
  const copies = (userId = benUser) =>
    receiver.library.assets
      .values()
      .filter((asset) => asset.ownerId === userId)
      .toArray();
  const originOf = (remoteId: string, userId = benUser) =>
    receiver.receive.origins.find((o) => o.remoteId === remoteId && o.userId === userId);
  const copyOf = (remoteId: string, userId = benUser) =>
    receiver.library.assets.get(originOf(remoteId, userId)!.localId)!;
  const editedOnSender = (id: string, description: string) => {
    anna.world.items.get(id)!.description = description;
    return anna.world.touchAssets([id]);
  };
  /** Anna's real page, changed as a hostile server would before signing it. */
  const tamper = (change: (page: Page) => unknown) => {
    const real = anna.shares.manifest.bind(anna.shares);
    vi.spyOn(anna.shares, 'manifest').mockImplementation(
      async (...args) => change((await real(...args)) as never) as never,
    );
  };
  const tamperAsset = (change: (asset: Record<string, any>) => void) =>
    tamper((page) => {
      for (const entry of page.entries) {
        if (entry.asset) change(entry.asset);
      }
      return page;
    });
  /** The first 400 bytes arrive, then the connection drops. */
  const cutAt400 = (bytes: Buffer) => {
    let sent = false;
    return new Response(
      new ReadableStream({
        async pull(controller) {
          if (sent) {
            // long enough for the first chunk to reach the disk, as on a real connection
            await new Promise((resolve) => setTimeout(resolve, 50));
            controller.error(new Error('connection lost'));
          } else {
            sent = true;
            controller.enqueue(bytes.subarray(0, 400));
          }
        },
      }),
    );
  };
  const partFiles = () => {
    const found: string[] = [];
    const walk = (folder: string) => {
      for (const name of existsSync(folder) ? readdirSync(folder) : []) {
        const path = join(folder, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (name.endsWith('.part')) found.push(path);
      }
    };
    walk(media);
    return found;
  };

  beforeEach(async () => {
    media = await mkdtemp(join(tmpdir(), 'household-receive-'));
    StorageCore.setMediaLocation(media);
    fixture = await startHouseholdCloud();
    anna = await startHouseholdServer(fixture, 'Anna');
    ben = await startHouseholdServer(fixture, 'Ben');
    const { token } = await anna.service.invite();
    await ben.service.accept(token);
    await anna.service.reconcile();
    cloudLink = ben.links.rows[0].cloudLinkId;
    ownerId = randomUUID();
    spaceId = anna.world.addSpace(ownerId);
    receiver = startReceiver(ben);
    for (const id of [benUser, benOther]) {
      receiver.receive.activeUsers.add(id);
      receiver.library.addUser(id);
    }
    originals.clear();
    serve = undefined;
    ranges = [];
    originalCalls = [];
    connect();
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    StorageCore.reset();
    await Promise.all([anna.close(), ben.close(), fixture.cloud.close(), rm(media, { recursive: true, force: true })]);
  });

  describe('invitations (T21)', () => {
    it('invites an existing active account and raises one notification', async () => {
      await invite();
      await receiver.service.poll(await linkRow());
      await receiver.service.poll(await linkRow());
      expect(receiver.receive.shares).toHaveLength(1);
      expect(inbound()).toMatchObject({ state: 'invited', spaceName: 'Family', ownerName: 'Anna Owner' });
      expect(receiver.sent).toHaveLength(1);
      expect(receiver.sent[0]).toMatchObject({ userId: benUser, type: 'Custom' });
      expect(receiver.sent[0].data).toMatchObject({ kind: 'household-share-invite', inboundShareId: inbound().id });
    });

    it('T21: an unknown user id makes no row, no notification and no call back', async () => {
      const unknown = randomUUID();
      await invite(unknown);
      await receiver.service.poll(await linkRow());
      expect(receiver.receive.shares).toHaveLength(0);
      expect(receiver.sent).toHaveLength(0);
      expect(anna.world.members.find((m) => m.remoteUserId === unknown)).toMatchObject({
        acceptedAt: null,
        leftAt: null,
      });
    });

    it('ignores an inactive account', async () => {
      receiver.receive.activeUsers.delete(benUser);
      await invite();
      await receiver.service.poll(await linkRow());
      expect(receiver.receive.shares).toHaveLength(0);
    });

    it('refuses a share list that breaks the protocol, writing nothing', async () => {
      await invite();
      vi.spyOn(anna.shares, 'offered').mockResolvedValue([{ id: 'not-a-uuid', evil: true }] as never);
      await expect(receiver.service.poll(await linkRow())).rejects.toThrow(HouseholdBadPage);
      expect(receiver.receive.shares).toHaveLength(0);
    });

    it('accept makes a space owned by the recipient, labelled with the local household name, and tells the sender', async () => {
      await ben.service.rename(benLink().id, 'The Grandparents');
      const share = await accept();
      const album = receiver.library.albums.get(share.albumId!)!;
      expect(album).toMatchObject({ albumName: 'Family', description: 'From The Grandparents', ownerId: benUser });
      expect(anna.world.members.find((m) => m.remoteUserId === benUser)?.acceptedAt).toBeTruthy();
    });

    it('decline tells the sender and creates no space', async () => {
      await invite();
      await receiver.service.poll(await linkRow());
      await receiver.service.decline(auth(), inbound().id);
      expect(inbound()).toMatchObject({ state: 'left', albumId: null });
      expect(anna.world.members.find((m) => m.remoteUserId === benUser)?.leftAt).toBeTruthy();
      expect(receiver.library.albums.size).toBe(0);
    });

    it('another account cannot see, accept or decline the invitation', async () => {
      await invite();
      await receiver.service.poll(await linkRow());
      await expect(status(receiver.service.accept(auth(benOther), inbound().id))).resolves.toBe(404);
      await expect(status(receiver.service.decline(auth(benOther), inbound().id))).resolves.toBe(404);
      await expect(receiver.service.list(auth(benOther))).resolves.toEqual([]);
    });

    it('a peer re-inviting in a loop raises at most one notification a day', async () => {
      await invite();
      await receiver.service.poll(await linkRow());
      await receiver.service.decline(auth(), inbound().id);
      for (let round = 0; round < 3; round++) {
        await anna.world.invite({
          albumId: spaceId,
          linkId: annaLink().id,
          remoteUserId: benUser,
          displayName: 'Ben',
          role: 'viewer',
        });
        await receiver.service.poll(await linkRow());
        await receiver.service.decline(auth(), inbound().id);
      }
      expect(receiver.sent).toHaveLength(1);
    });
  });

  describe('pull', () => {
    it('acceptance: after accept, items appear in the space and match the manifest', async () => {
      const first = addItem({ description: 'Beach', originalFileName: 'beach.jpg' });
      const second = addItem({ originalFileName: 'old.jpg' }, true); // SHA-1, as older items are stored
      const share = await accept();
      expect((await pull()).lastError).toBeNull();

      expect(copies()).toHaveLength(2);
      for (const item of [first, second]) {
        const copy = copyOf(item.id);
        expect(readFileSync(copy.originalPath).equals(originals.get(item.id)!)).toBe(true);
        expect(copy.ownerId).toBe(benUser);
        expect(receiver.library.albums.get(share.albumId!)!.items.has(copy.id)).toBe(true);
        expect(copy.exif).toMatchObject({ latitude: 1, longitude: 2, city: 'Leeds', country: 'UK' });
      }
      expect(copyOf(first.id).exif.description).toBe('Beach');
      expect(inbound().cursor).toBeGreaterThan(0);
      expect(inbound().lastPulledAt).toBeTruthy();
    });

    it('T13: every file is ingested through the normal upload path, by the guarded route', async () => {
      addItem({ originalFileName: 'a.jpg' });
      await accept();
      await pull();
      expect(receiver.library.assetMedia.uploadAsset).toHaveBeenCalledTimes(1);
      expect(receiver.library.uploads[0].publication).toEqual(expect.any(Function));
    });

    it('acceptance: a sender edit updates the copy; after the recipient edits it, later sender edits do not', async () => {
      const item = addItem({ description: 'First', originalFileName: 'a.jpg' });
      await accept();
      await pull();

      await editedOnSender(item.id, 'Second');
      await pull();
      expect(copyOf(item.id).exif.description).toBe('Second');

      // what the partner hook does when the recipient edits: `markOverridden` on the origin
      originOf(item.id)!.overriddenFields.push('description');
      copyOf(item.id).exif.description = 'Mine';
      await editedOnSender(item.id, 'Third');
      await pull();
      expect(copyOf(item.id).exif.description).toBe('Mine');
      expect(copyOf(item.id).exif.city).toBe('Leeds');
    });

    it('acceptance, T19: a sender deleting or removing an item leaves the copy, and only stops following', async () => {
      const removed = addItem({ originalFileName: 'a.jpg' });
      const trashed = addItem({ originalFileName: 'b.jpg' });
      const share = await accept();
      await pull();
      const before = copies()
        .map(({ id }) => id)
        .sort();

      anna.world.items.get(removed.id)!.albums.clear();
      anna.world.items.get(trashed.id)!.deleted = true;
      await anna.world.touchAssets([removed.id, trashed.id]);
      await pull();

      expect(
        copies()
          .map(({ id }) => id)
          .sort(),
      ).toEqual(before);
      expect(originOf(removed.id)!.followUntilEdited).toBe(false);
      expect(originOf(trashed.id)!.followUntilEdited).toBe(false);
      expect(receiver.library.albums.get(share.albumId!)!.items.size).toBe(2);
      expect(receiver.library.assetRepo.remove).not.toHaveBeenCalled();
      expect(receiver.library.assetRepo.updateAll).not.toHaveBeenCalled();
    });

    it('a stopped item is not updated by a later entry', async () => {
      const item = addItem({ description: 'One', originalFileName: 'a.jpg' });
      await accept();
      await pull();
      anna.world.items.get(item.id)!.locked = true;
      await anna.world.touchAssets([item.id]);
      await pull();
      anna.world.items.get(item.id)!.locked = false;
      await editedOnSender(item.id, 'Two');
      await pull();
      expect(copyOf(item.id).exif.description).toBe('One');
    });

    it('acceptance, T19: unlinking keeps all copies, and nothing more is pulled', async () => {
      const item = addItem({ originalFileName: 'a.jpg' });
      await accept();
      await pull();
      await ben.service.end(benLink().id);
      await receiver.service.run();

      expect(inbound().state).toBe('left');
      expect(copies()).toHaveLength(1);
      expect(originOf(item.id)!.followUntilEdited).toBe(false);
      expect(receiver.library.assetRepo.remove).not.toHaveBeenCalled();
    });

    it('a copy the recipient permanently deleted is not created again', async () => {
      const item = addItem({ originalFileName: 'a.jpg' });
      await accept();
      await pull();
      receiver.library.assets.delete(originOf(item.id)!.localId);
      await editedOnSender(item.id, 'Changed');
      await pull();
      expect(copies()).toHaveLength(0);
      expect(receiver.library.assetMedia.uploadAsset).toHaveBeenCalledTimes(1);
    });

    it('a second recipient on this server does not download the file again', async () => {
      addItem({ originalFileName: 'a.jpg' });
      await accept();
      await pull();
      expect(originalCalls).toHaveLength(1);
      await accept(benOther);
      await pull(benOther);
      expect(originalCalls).toHaveLength(1);
      expect(copies(benOther)).toHaveLength(1);
    });

    it('a stored file that changed is downloaded again rather than reused', async () => {
      const item = addItem({ originalFileName: 'a.jpg' });
      await accept();
      await pull();
      await writeFile(copyOf(item.id).originalPath, randomBytes(1000));
      await accept(benOther);
      await pull(benOther);
      expect(originalCalls).toHaveLength(2);
      expect(readFileSync(copyOf(item.id, benOther).originalPath).equals(originals.get(item.id)!)).toBe(true);
    });

    it('an item the recipient already holds is placed in the space and never written to', async () => {
      const item = addItem({ description: 'From Anna', originalFileName: 'a.jpg' });
      const mine = {
        id: randomUUID(),
        ownerId: benUser,
        checksum: createHash('sha256').update(originals.get(item.id)!).digest(),
        originalPath: '/mine.jpg',
        type: 'IMAGE' as never,
        visibility: 'timeline',
        deletedAt: null,
        livePhotoVideoId: null,
        exif: { description: 'My own words' },
      };
      receiver.library.assets.set(mine.id, mine);
      const share = await accept();
      await pull();
      await editedOnSender(item.id, 'Edited by Anna');
      await pull();

      expect(mine.exif.description).toBe('My own words');
      expect(originOf(item.id)).toMatchObject({ localId: mine.id, isCopy: false, followUntilEdited: false });
      expect(receiver.library.albums.get(share.albumId!)!.items.has(mine.id)).toBe(true);
      expect(partFiles()).toEqual([]);
    });

    it('pairs a live photo and its video part, in either order, and hides the part', async () => {
      const video = addItem({ type: 'VIDEO', visibility: 'hidden', originalFileName: 'live.mov' });
      const still = addItem({ originalFileName: 'live.jpg', livePhotoVideoId: video.id });
      const share = await accept();
      await pull();
      const [image, motion] = [copyOf(still.id), copyOf(video.id)];
      expect(image.livePhotoVideoId).toBe(motion.id);
      expect(motion.visibility).toBe('hidden');
      expect(receiver.library.albums.get(share.albumId!)!.items.has(motion.id)).toBe(false);
    });

    it('never pairs onto the recipient’s own video', async () => {
      const video = addItem({ type: 'VIDEO', visibility: 'hidden', originalFileName: 'live.mov' });
      const mine = {
        id: randomUUID(),
        ownerId: benUser,
        checksum: createHash('sha256').update(originals.get(video.id)!).digest(),
        originalPath: '/mine.mov',
        type: 'VIDEO' as never,
        visibility: 'timeline',
        deletedAt: null,
        livePhotoVideoId: null,
        exif: {},
      };
      receiver.library.assets.set(mine.id, mine);
      const still = addItem({ originalFileName: 'live.jpg', livePhotoVideoId: video.id });
      await accept();
      await pull();
      expect(mine.visibility).toBe('timeline');
      expect(copyOf(still.id).livePhotoVideoId).toBeNull();
    });
  });

  describe('hostile manifests (T10)', () => {
    const shareId = randomUUID();
    const asset = (change: Record<string, unknown> = {}) => ({
      id: randomUUID(),
      type: 'IMAGE',
      originalFileName: 'a.jpg',
      checksum: 'a'.repeat(40),
      size: 10,
      fileCreatedAt: '2026-01-01T00:00:00.000Z',
      localDateTime: '2026-01-01T00:00:00.000Z',
      timeZone: 'UTC',
      description: '',
      rating: null,
      latitude: 1,
      longitude: 2,
      city: null,
      state: null,
      country: null,
      width: 1,
      height: 1,
      duration: null,
      livePhotoVideoId: null,
      stackId: null,
      stackPrimary: false,
      updatedAt: '2026-01-01T00:00:00.000Z',
      download: { token: 'a.b.c', expiresAt: '2026-01-01T00:15:00.000Z' },
      ...change,
    });
    const page = (entries: unknown[], change: Record<string, unknown> = {}) => ({
      version: 1,
      shareId,
      entries,
      nextCursor: String((entries.at(-1) as { seq?: number } | undefined)?.seq ?? 0),
      complete: true,
      ...change,
    });
    const entry = (seq: number, change: Record<string, unknown> = {}) => {
      const body = asset(change);
      return { seq, kind: 'asset', id: body.id, asset: body };
    };

    it('accepts a well-formed page', () => {
      expect(parseHouseholdPage(page([entry(1), entry(2)]), shareId, 0).nextCursor).toBe(2);
    });

    it.each([
      ['a 1 MB description', () => page([entry(1, { description: 'x'.repeat(1024 * 1024) })])],
      ['latitude 900', () => page([entry(1, { latitude: 900 })])],
      ['longitude 900', () => page([entry(1, { longitude: 900 })])],
      ['an unknown field on an item', () => page([entry(1, { ownerEmail: 'a@b.test' })])],
      ['an unknown field on an entry', () => page([{ ...entry(1), extra: 1 }])],
      ['an unknown field on the page', () => page([entry(1)], { extra: 1 })],
      ['too many entries', () => page(Array.from({ length: 201 }, (_, index) => entry(index + 1)))],
      ['a page over 2 MiB', () => page([entry(1)], { padding: 'x'.repeat(2 * 1024 * 1024) })],
      ['a bad date', () => page([entry(1, { fileCreatedAt: 'yesterday' })])],
      ['a date in year 9999', () => page([entry(1, { fileCreatedAt: '9999-01-01T00:00:00.000Z' })])],
      ['a bad checksum', () => page([entry(1, { checksum: 'zz' })])],
      ['a file name with a path', () => page([entry(1, { originalFileName: '../../evil.jpg' })])],
      ['a NUL in a description', () => page([entry(1, { description: 'a\0b' })])],
      ['rating 7', () => page([entry(1, { rating: 7 })])],
      ['a negative size', () => page([entry(1, { size: -1 })])],
      ['another share', () => page([entry(1)], { shareId: randomUUID() })],
      ['a sequence going backwards', () => page([entry(2), entry(1)])],
      [
        'the same item twice',
        () => {
          const one = entry(1);
          return page([one, { ...one, seq: 2 }]);
        },
      ],
      ['a wrong next cursor', () => page([entry(1)], { nextCursor: '9' })],
      ['an entry naming two items', () => page([{ ...entry(1), id: randomUUID() }])],
      ['an empty page that is not the last', () => page([], { complete: false })],
      [
        'too many faces',
        () =>
          page([
            {
              seq: 1,
              kind: 'person',
              id: randomUUID(),
              person: {
                name: 'N',
                faces: Array.from({ length: 5001 }, () => ({
                  assetId: randomUUID(),
                  x1: 0,
                  y1: 0,
                  x2: 1,
                  y2: 1,
                  width: 2,
                  height: 2,
                })),
              },
            },
          ]),
      ],
    ])('refuses %s', (_name, build) => {
      expect(() => parseHouseholdPage(build(), shareId, 0)).toThrow(HouseholdBadPage);
    });

    it('refuses a page that does not move past the cursor', () => {
      expect(() => parseHouseholdPage(page([entry(5)]), shareId, 5)).toThrow(HouseholdBadPage);
    });

    it.each([
      ['oversize page', (p: Page) => ({ ...p, padding: 'x'.repeat(3 * 1024 * 1024) })],
      ['unknown field', (p: Page) => ({ ...p, entries: p.entries.map((e) => ({ ...e, surprise: true })) })],
      [
        '1 MB description',
        (p: Page) => ({
          ...p,
          entries: p.entries.map((e) => ({ ...e, asset: { ...e.asset, description: 'x'.repeat(1024 * 1024) } })),
        }),
      ],
      [
        'latitude 900',
        (p: Page) => ({ ...p, entries: p.entries.map((e) => ({ ...e, asset: { ...e.asset, latitude: 900 } })) }),
      ],
    ])('acceptance: %s → page refused, nothing written, cursor kept, status set', async (_name, change) => {
      addItem({ originalFileName: 'a.jpg' });
      await accept();
      tamper(change);
      const after = await pull();
      expect(after).toMatchObject({ lastError: 'bad-page', cursor: 0, failures: 1 });
      expect(copies()).toHaveLength(0);
      expect(receiver.receive.origins).toHaveLength(0);
      expect(originalCalls).toHaveLength(0);
      expect(new Date(after.nextPullAt as never).getTime()).toBeGreaterThan(Date.now());
    });

    it('a bad page affects that share only', async () => {
      addItem({ originalFileName: 'a.jpg' });
      const otherSpace = anna.world.addSpace(ownerId, 'Other');
      const bytes = randomBytes(1000);
      const other = anna.world.addItem(otherSpace, {
        checksum: createHash('sha256').update(bytes).digest(),
        originalFileName: 'b.jpg',
      });
      originals.set(other.id, bytes);
      await accept();
      const otherShare = (await anna.world.invite({
        albumId: otherSpace,
        linkId: annaLink().id,
        remoteUserId: benUser,
        displayName: 'Ben',
        role: 'viewer',
      })) as string;
      await receiver.service.poll(await linkRow());
      const second = receiver.receive.shares.find((share) => share.remoteShareId === otherShare)!;
      await receiver.service.accept(auth(), second.id);

      const real = anna.shares.manifest.bind(anna.shares);
      vi.spyOn(anna.shares, 'manifest').mockImplementation(async (access, id, query) => {
        const result = await real(access, id, query);
        return (id === otherShare ? result : { ...result, surprise: true }) as never;
      });
      await receiver.service.pull(await linkRow(), { ...inbound() });
      await receiver.service.pull(await linkRow(), { ...second });

      expect(inbound().lastError).toBe('bad-page');
      expect(receiver.receive.shares.find(({ id }) => id === second.id)!.lastError).toBeNull();
      expect(copies()).toHaveLength(1);
    });

    it('T18: a peer cannot redirect a download anywhere', async () => {
      addItem({ originalFileName: 'a.jpg' });
      await accept();
      await pull();
      const calls = vi.mocked(fetch).mock.calls.filter(([url]) => String(url).includes(anna.host));
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every(([, init]) => init?.redirect === 'error')).toBe(true);
    });
  });

  describe('downloads (T11, T12)', () => {
    it('acceptance: an interrupted download resumes with Range', async () => {
      const item = addItem({ originalFileName: 'a.jpg' });
      await accept();
      serve = (_id, bytes) => cutAt400(bytes);
      const failed = await pull();
      expect(failed.lastError).toBe('unreachable');
      expect(copies()).toHaveLength(0);
      expect(partFiles()).toHaveLength(1);
      expect(statSync(partFiles()[0]).size).toBe(400);

      serve = undefined;
      const resumed = await pull();
      expect(ranges).toEqual([null, 'bytes=400-']);
      expect(resumed.lastError).toBeNull();
      expect(readFileSync(copyOf(item.id).originalPath).equals(originals.get(item.id)!)).toBe(true);
      expect(partFiles()).toEqual([]);
    });

    it('a long download is not cut by the 30 second limit on a reply', async () => {
      const item = addItem({ originalFileName: 'a.jpg' });
      await accept();
      const timeouts = vi.spyOn(globalThis, 'setTimeout');
      const cleared = vi.spyOn(globalThis, 'clearTimeout');
      serve = (_id, bytes) => {
        // by the time the body streams, the client has cleared its timer on the headers
        const timer = timeouts.mock.results.findLast((_, index) => timeouts.mock.calls[index][1] === 30_000);
        expect(cleared.mock.calls.some(([id]) => id === timer?.value)).toBe(false);
        return new Response(bytes);
      };
      await pull();
      const timers = timeouts.mock.results.filter((_, index) => timeouts.mock.calls[index][1] === 30_000);
      expect(timers.length).toBeGreaterThan(0);
      expect(timers.every(({ value }) => cleared.mock.calls.some(([id]) => id === value))).toBe(true);
      expect(copyOf(item.id)).toBeDefined();
    });

    it('starts again when the peer ignores the range', async () => {
      const item = addItem({ originalFileName: 'a.jpg' });
      await accept();
      serve = (_id, bytes) => cutAt400(bytes);
      await pull();
      serve = (_id, bytes) => new Response(bytes); // 200, whole file
      await pull();
      expect(readFileSync(copyOf(item.id).originalPath).equals(originals.get(item.id)!)).toBe(true);
    });

    it('refuses a 206 that starts somewhere else', async () => {
      addItem({ originalFileName: 'a.jpg' });
      await accept();
      serve = (_id, bytes) => cutAt400(bytes);
      await pull();
      serve = (_id, bytes) =>
        new Response(bytes.subarray(100), {
          status: 206,
          headers: { 'content-range': `bytes 100-999/1000` },
        });
      const after = await pull();
      expect(after.lastError).toBe('bad-file');
      expect(copies()).toHaveLength(0);
      expect(partFiles()).toEqual([]);
    });

    it('acceptance: a file declared over the cap is refused and reported, without downloading', async () => {
      addItem({ originalFileName: 'a.jpg' });
      await accept();
      tamperAsset((asset) => {
        asset.size = 21 * 1024 ** 3;
      });
      const after = await pull();
      expect(after.lastError).toBe('file-too-large');
      expect(originalCalls).toHaveLength(0);
      expect(copies()).toHaveLength(0);
    });

    it('the cap is the smaller of the two servers’ limits', async () => {
      addItem({ originalFileName: 'a.jpg' });
      await accept();
      const real = anna.peer.handshake.bind(anna.peer);
      vi.spyOn(anna.peer, 'handshake').mockImplementation(async () => ({ ...(await real()), maxOriginalBytes: 500 }));
      const after = await pull();
      expect(after.lastError).toBe('file-too-large');
      expect(copies()).toHaveLength(0);
    });

    it('a stream longer than declared is cut, and the temp file is gone', async () => {
      addItem({ originalFileName: 'a.jpg' });
      await accept();
      let sent = 0;
      serve = () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              sent += 256;
              controller.enqueue(randomBytes(256));
              if (sent > 1024 * 1024) controller.close();
            },
          }),
        );
      const after = await pull();
      expect(after.lastError).toBe('bad-file');
      expect(sent).toBeLessThan(64 * 1024);
      expect(copies()).toHaveLength(0);
      expect(partFiles()).toEqual([]);
    });

    it('a size-less stream is cut at the cap', async () => {
      addItem({ originalFileName: 'a.jpg' });
      await accept();
      tamperAsset((asset) => {
        asset.size = null;
      });
      const real = anna.peer.handshake.bind(anna.peer);
      vi.spyOn(anna.peer, 'handshake').mockImplementation(async () => ({ ...(await real()), maxOriginalBytes: 500 }));
      const after = await pull();
      expect(after.lastError).toBe('file-too-large');
      expect(partFiles()).toEqual([]);
    });

    it('checksum mismatch: not ingested, and the temp file is gone', async () => {
      addItem({ originalFileName: 'a.jpg' });
      await accept();
      serve = () => new Response(randomBytes(1000));
      const after = await pull();
      expect(after.lastError).toBe('checksum-mismatch');
      expect(receiver.library.assetMedia.uploadAsset).not.toHaveBeenCalled();
      expect(copies()).toHaveLength(0);
      expect(partFiles()).toEqual([]);
    });

    it('T12: a checksum matching a file another local user owns still downloads', async () => {
      const item = addItem({ originalFileName: 'a.jpg' });
      const stored = join(media, 'other.jpg');
      await writeFile(stored, originals.get(item.id)!);
      receiver.library.assets.set(randomUUID(), {
        id: randomUUID(),
        ownerId: benOther,
        checksum: item.checksum,
        originalPath: stored,
        type: 'IMAGE' as never,
        visibility: 'timeline',
        deletedAt: null,
        livePhotoVideoId: null,
        exif: {},
      });
      await accept();
      await pull();
      expect(originalCalls).toEqual([item.id]);
      expect(copyOf(item.id).originalPath).not.toBe(stored);
    });

    it('T12: a failed download of such a checksum creates nothing', async () => {
      const item = addItem({ originalFileName: 'a.jpg' });
      receiver.library.assets.set(randomUUID(), {
        id: randomUUID(),
        ownerId: benOther,
        checksum: item.checksum,
        originalPath: '/other.jpg',
        type: 'IMAGE' as never,
        visibility: 'timeline',
        deletedAt: null,
        livePhotoVideoId: null,
        exif: {},
      });
      await accept();
      serve = () => new Response(randomBytes(1000));
      await pull();
      expect(copies()).toHaveLength(0);
      expect(originOf(item.id)).toBeUndefined();
    });

    it.each([
      ['a type the uploader refuses', { originalFileName: 'evil.exe' }],
      ['a script', { originalFileName: 'evil.svg.html' }],
      ['a declared type that disagrees with the name', { originalFileName: 'a.mp4' }],
    ])('refuses %s without downloading it', async (_name, change) => {
      addItem(change);
      await accept();
      const after = await pull();
      expect(after.lastError).toBe('unsupported-type');
      expect(originalCalls).toHaveLength(0);
      expect(copies()).toHaveLength(0);
    });

    it('one refused item does not stop the rest of the share', async () => {
      addItem({ originalFileName: 'evil.exe' });
      const good = addItem({ originalFileName: 'good.jpg' });
      await accept();
      const after = await pull();
      expect(after.lastError).toBe('unsupported-type');
      expect(copyOf(good.id)).toBeDefined();
    });

    it('an item the sender locked meanwhile is skipped, not retried for ever', async () => {
      const item = addItem({ originalFileName: 'a.jpg' });
      await accept();
      const real = anna.shares.original.bind(anna.shares);
      vi.spyOn(anna.shares, 'original').mockImplementation((...args) => {
        anna.world.items.get(item.id)!.locked = true;
        return real(...args);
      });
      const after = await pull();
      expect(after.lastError).toBe('not-available');
      expect(copies()).toHaveLength(0);
    });

    it('an expired download token is renewed by reading the page again', async () => {
      const item = addItem({ originalFileName: 'a.jpg' });
      await accept();
      let reads = 0;
      const real = anna.shares.manifest.bind(anna.shares);
      vi.spyOn(anna.shares, 'manifest').mockImplementation(async (...args) => {
        const result = (await real(...args)) as unknown as Page;
        if (++reads === 1) {
          for (const entry of result.entries)
            entry.asset.download.expiresAt = new Date(Date.now() - 1000).toISOString();
        }
        return result as never;
      });
      const after = await pull();
      expect(reads).toBe(2);
      expect(after.lastError).toBeNull();
      expect(copyOf(item.id)).toBeDefined();
    });
  });

  describe('quota (T14)', () => {
    it('over quota: the pull pauses, keeps the cursor and drops nothing', async () => {
      const first = addItem({ originalFileName: 'a.jpg' });
      await accept();
      receiver.library.users.get(benUser)!.quotaSizeInBytes = 500;
      const paused = await pull();
      expect(paused).toMatchObject({ lastError: 'over-quota', cursor: 0 });
      expect(originalCalls).toHaveLength(0);
      expect(copies()).toHaveLength(0);

      receiver.library.users.get(benUser)!.quotaSizeInBytes = null;
      const resumed = await pull();
      expect(resumed.lastError).toBeNull();
      expect(copyOf(first.id)).toBeDefined();
    });

    it('counts what this pull already took against the quota', async () => {
      addItem({ originalFileName: 'a.jpg' });
      addItem({ originalFileName: 'b.jpg' });
      await accept();
      receiver.library.users.get(benUser)!.quotaSizeInBytes = 1500;
      const after = await pull();
      expect(after.lastError).toBe('over-quota');
      expect(copies()).toHaveLength(1);
    });

    it('a poke does not cut a paused share’s wait short', async () => {
      addItem({ originalFileName: 'a.jpg' });
      await accept();
      receiver.library.users.get(benUser)!.quotaSizeInBytes = 1;
      await pull();
      const wait = inbound().nextPullAt;
      await receiver.receive.pullNow(benLink().id);
      expect(inbound().nextPullAt).toBe(wait);
    });
  });

  describe('removal, per person', () => {
    it('acceptance: a person removed from a share stops receiving while another member continues', async () => {
      const first = addItem({ originalFileName: 'a.jpg' });
      await accept();
      await accept(benOther);
      await pull();
      await pull(benOther);

      await anna.world.removeMember(spaceId, inbound().remoteShareId, benUser);
      await receiver.service.poll(await linkRow());
      expect(inbound().state).toBe('left');
      expect(inbound(benOther).state).toBe('accepted');
      expect(originOf(first.id)!.followUntilEdited).toBe(false);
      expect(originOf(first.id, benOther)!.followUntilEdited).toBe(true);

      const second = addItem({ originalFileName: 'b.jpg' });
      await anna.world.seedAlbum(spaceId);
      await editedOnSender(first.id, 'After removal');
      await receiver.service.run();
      await pull(benOther);

      // the sender still answers for the household: this server is what stops the removed person
      expect(copies()).toHaveLength(1);
      expect(copyOf(first.id).exif.description).not.toBe('After removal');
      expect(copyOf(second.id, benOther)).toBeDefined();
      expect(copyOf(first.id, benOther).exif.description).toBe('After removal');
    });

    it('a removal is read before the next pull, and an unreadable member list stops pulling', async () => {
      const first = addItem({ originalFileName: 'a.jpg' });
      await accept();
      await pull();
      await editedOnSender(first.id, 'Changed');
      inbound().nextPullAt = null;
      const offered = vi.spyOn(anna.shares, 'offered').mockResolvedValueOnce([{ id: 'broken' }] as never);
      await receiver.service.run();
      expect(copyOf(first.id).exif.description).not.toBe('Changed');

      offered.mockRestore();
      await anna.world.removeMember(spaceId, inbound().remoteShareId, benUser);
      inbound().nextPullAt = null;
      await receiver.service.run();
      expect(inbound().state).toBe('left');
      expect(copyOf(first.id).exif.description).not.toBe('Changed');
    });

    it('the sender deleting the share marks it left and keeps every copy', async () => {
      addItem({ originalFileName: 'a.jpg' });
      await accept();
      await pull();
      await anna.world.removeMember(spaceId, inbound().remoteShareId, benUser);
      await receiver.service.poll(await linkRow());
      expect(inbound().state).toBe('left');
      expect(copies()).toHaveLength(1);
    });

    it('the recipient deleting the local space leaves the share and keeps the copies', async () => {
      addItem({ originalFileName: 'a.jpg' });
      const share = await accept();
      await pull();
      receiver.library.albums.delete(share.albumId!);
      await pull();
      expect(inbound().state).toBe('left');
      expect(copies()).toHaveLength(1);
      expect(anna.world.members.find((m) => m.remoteUserId === benUser)?.leftAt).toBeTruthy();
    });

    it('re-invited after removal: asked again, never resumed silently', async () => {
      addItem({ originalFileName: 'a.jpg' });
      await accept();
      await pull();
      await anna.world.removeMember(spaceId, inbound().remoteShareId, benUser);
      await receiver.service.poll(await linkRow());
      // removing the last member ended that share, so this is a new one: it is an invitation like any other
      await invite();
      await receiver.service.poll(await linkRow());
      expect(receiver.receive.shares.map(({ state }) => state)).toEqual(['left', 'invited']);
      await expect(receiver.receive.getDue(benLink().id)).resolves.toEqual([]);
    });

    it('tells an unreachable sender about a decline at the next poll', async () => {
      await invite();
      await receiver.service.poll(await linkRow());
      const real = anna.controller.leave.bind(anna.controller);
      const leave = vi.spyOn(anna.controller, 'leave').mockRejectedValueOnce(new TypeError('fetch failed'));
      await receiver.service.decline(auth(), inbound().id);
      expect(inbound().leaveUnsent).toBe(true);
      leave.mockImplementation(real);
      await receiver.service.poll(await linkRow());
      expect(inbound().leaveUnsent).toBe(false);
      expect(anna.world.members.find((m) => m.remoteUserId === benUser)?.leftAt).toBeTruthy();
    });
  });

  describe('feed recovery', () => {
    it('410: reads from the start and stops following what the feed no longer lists', async () => {
      const kept = addItem({ originalFileName: 'a.jpg' });
      const gone = addItem({ originalFileName: 'b.jpg' });
      await accept();
      await pull();
      inbound().lastReconciledAt = new Date(Date.now() - 2 * 60 * 60_000) as never;
      // the sender's database went back in time and no longer holds `gone`
      anna.world.changes = anna.world.changes.filter((change) => change.entityId !== gone.id);
      anna.world.items.delete(gone.id);
      inbound().cursor = 999_999;
      await new Promise((resolve) => setTimeout(resolve, 5));
      await pull();
      expect(inbound().cursor).toBe(0);
      await pull();
      expect(originOf(kept.id)!.followUntilEdited).toBe(true);
      expect(originOf(gone.id)!.followUntilEdited).toBe(false);
      expect(copies()).toHaveLength(2);
    });

    it('a peer answering 410 in a loop cannot force a full read each time', async () => {
      addItem({ originalFileName: 'a.jpg' });
      await accept();
      await pull();
      inbound().cursor = 999_999;
      expect(await pull()).toMatchObject({ lastError: 'peer-restored', cursor: 999_999 });
    });
  });

  describe('people (T20)', () => {
    const boxes = (assetId: string, x = 10) => ({
      assetId,
      x1: x,
      y1: 10,
      x2: x + 40,
      y2: 50,
      width: 100,
      height: 100,
    });
    const localFace = (remoteAssetId: string, change: Record<string, unknown> = {}) => ({
      id: randomUUID(),
      remoteAssetId,
      personGroupId: null,
      correctedAt: null,
      x1: 12,
      y1: 12,
      x2: 52,
      y2: 52,
      width: 100,
      height: 100,
      ...change,
    });
    const asPerson = (name: string, faces: Array<ReturnType<typeof boxes>>) => {
      const id = randomUUID();
      tamper((page) => ({
        ...page,
        entries: [
          ...page.entries,
          {
            seq: Math.max(0, ...page.entries.map((entry) => entry.seq as number)) + 1,
            kind: 'person',
            id,
            person: { name, faces },
          },
        ],
        nextCursor: String(Math.max(0, ...page.entries.map((entry) => entry.seq as number)) + 1),
      }));
      return id;
    };

    it('acceptance: a person appears with their name, on the faces detected locally', async () => {
      const item = addItem({ originalFileName: 'a.jpg' });
      await accept();
      await pull();
      const face = localFace(item.id);
      receiver.receive.faces.push(face);
      receiver.receive.recognized.add(item.id);
      inbound().cursor = 0;
      const remote = asPerson('Nana', [boxes(item.id)]);
      await pull();

      const origin = originOf(remote)!;
      expect(receiver.library.people.get(origin.localId)).toMatchObject({ ownerId: benUser, name: 'Nana' });
      expect(origin.isCopy).toBe(true);
      expect(face.personGroupId).toBe(origin.localId);
      expect(receiver.receive.pending.size).toBe(0);
    });

    it('waits for local face detection, then matches', async () => {
      const item = addItem({ originalFileName: 'a.jpg' });
      await accept();
      await pull();
      inbound().cursor = 0;
      const remote = asPerson('Nana', [boxes(item.id)]);
      await pull();
      expect(originOf(remote)).toBeUndefined();
      expect(receiver.receive.pending.size).toBe(1);

      const face = localFace(item.id);
      receiver.receive.faces.push(face);
      receiver.receive.recognized.add(item.id);
      await receiver.service.poll(await linkRow());
      expect(face.personGroupId).toBe(originOf(remote)!.localId);
      expect(receiver.receive.pending.size).toBe(0);
    });

    it('T20: never moves a face the recipient’s recognition already placed, and never renames their person', async () => {
      const item = addItem({ originalFileName: 'a.jpg' });
      await accept();
      await pull();
      const mine = randomUUID();
      receiver.library.people.set(mine, { ownerId: benUser, personGroupId: mine, name: 'Grandma' });
      const face = localFace(item.id, { personGroupId: mine });
      receiver.receive.faces.push(face);
      receiver.receive.recognized.add(item.id);
      inbound().cursor = 0;
      const remote = asPerson('Stranger', [boxes(item.id)]);
      await pull();
      expect(face.personGroupId).toBe(mine);
      expect(receiver.library.people.get(mine)!.name).toBe('Grandma');
      expect(originOf(remote)).toMatchObject({ localId: mine, isCopy: false });
    });

    it('T20: a further face joins the recipient’s person only within their own threshold, with an undoable entry', async () => {
      const first = addItem({ originalFileName: 'a.jpg' });
      const second = addItem({ originalFileName: 'b.jpg' });
      const third = addItem({ originalFileName: 'c.jpg' });
      await accept();
      await pull();
      const mine = randomUUID();
      receiver.library.people.set(mine, { ownerId: benUser, personGroupId: mine, name: 'Grandma' });
      const placed = localFace(first.id, { personGroupId: mine });
      const near = localFace(second.id);
      const far = localFace(third.id);
      receiver.receive.faces.push(placed, near, far);
      for (const { id } of [first, second, third]) receiver.receive.recognized.add(id);
      receiver.library.search.searchFaces.mockImplementation(((query: { embedding: string }) =>
        Promise.resolve(query.embedding === `embedding-${near.id}` ? [{ personGroupId: mine }] : [])) as never);
      inbound().cursor = 0;
      asPerson('Nana', [boxes(first.id), boxes(second.id), boxes(third.id)]);
      await pull();

      expect(near.personGroupId).toBe(mine);
      expect(far.personGroupId).toBeNull();
      expect(receiver.library.peopleRepo.recordFaceCorrections).toHaveBeenCalledWith([
        expect.objectContaining({ action: 'reassign', faceId: near.id, fromPersonId: null, toPersonId: mine }),
      ]);
    });

    it('a sender rename follows until the recipient renames the person', async () => {
      const item = addItem({ originalFileName: 'a.jpg' });
      await accept();
      await pull();
      receiver.receive.faces.push(localFace(item.id));
      receiver.receive.recognized.add(item.id);
      inbound().cursor = 0;
      const remote = asPerson('Nana', [boxes(item.id)]);
      await pull();
      const { localId } = originOf(remote)!;

      const rename = (name: string) =>
        (receiver.service as any).applyPerson(
          { share: inbound(), link: benLink() },
          { linkId: benLink().id, remoteId: remote, kind: 'person', userId: benUser },
          name,
          [boxes(item.id)],
        );
      await rename('Nana Jones');
      expect(receiver.library.people.get(localId)!.name).toBe('Nana Jones');
      originOf(remote)!.overriddenFields.push('name');
      await rename('Someone Else');
      expect(receiver.library.people.get(localId)!.name).toBe('Nana Jones');
    });

    it('a box on something this link did not deliver matches nothing', async () => {
      await accept();
      const foreign = randomUUID();
      receiver.receive.faces.push(localFace(foreign));
      asPerson('Nana', [boxes(foreign)]);
      await pull();
      expect(receiver.library.people.size).toBe(0);
    });

    it('stop on a person ends following and keeps them', async () => {
      const item = addItem({ originalFileName: 'a.jpg' });
      await accept();
      await pull();
      receiver.receive.faces.push(localFace(item.id));
      receiver.receive.recognized.add(item.id);
      inbound().cursor = 0;
      const remote = asPerson('Nana', [boxes(item.id)]);
      await pull();
      const { localId } = originOf(remote)!;
      vi.mocked(anna.shares.manifest).mockRestore();
      inbound().cursor = 0;
      tamper((page) => ({
        ...page,
        entries: [{ seq: 900_000, kind: 'person', id: remote, stop: true }],
        nextCursor: '900000',
      }));
      await pull();
      expect(originOf(remote)!.followUntilEdited).toBe(false);
      expect(receiver.library.people.has(localId)).toBe(true);
    });
  });

  describe('status and scheduling', () => {
    it('a household that stalls does not hold up another household', async () => {
      const slow = { ...(await linkRow()), id: randomUUID() };
      const fast = { ...(await linkRow()), id: randomUUID() };
      vi.spyOn(ben.links, 'getAll').mockResolvedValue([slow, fast]);
      let release!: () => void;
      const stalled = new Promise<void>((resolve) => (release = resolve));
      const reached: string[] = [];
      const runLink = vi
        .spyOn(receiver.service as never as { pullDue: (link: { id: string }) => Promise<void> }, 'pullDue')
        .mockImplementation(async ({ id }) => {
          reached.push(id);
          if (id === slow.id) {
            await stalled;
          }
        });
      vi.spyOn(receiver.service, 'poll').mockResolvedValue();

      const running = receiver.service.run();
      await vi.waitFor(() => expect(reached).toEqual([slow.id, fast.id]));
      release();
      await running;
      runLink.mockRestore();
    });

    it('reports per share: state, last pulled and last error', async () => {
      await ben.service.rename(benLink().id, 'The Grandparents');
      addItem({ originalFileName: 'a.exe' });
      await accept();
      await pull();
      await expect(receiver.service.list(auth())).resolves.toEqual([
        expect.objectContaining({
          householdName: 'The Grandparents',
          spaceName: 'Family',
          state: 'accepted',
          lastError: 'unsupported-type',
          lastPulledAt: expect.any(String),
        }),
      ]);
    });

    it('a poke makes the next tick poll at once', async () => {
      await invite();
      benLink().pollRequestedAt = new Date() as never;
      await receiver.service.run();
      expect(receiver.receive.shares).toHaveLength(1);
      expect(benLink().pollRequestedAt).toBeNull();
    });

    it('quiet hours hold pulls back but not the poll', async () => {
      addItem({ originalFileName: 'a.jpg' });
      await accept();
      receiver.jobs.getQueueHolds.mockResolvedValue([{ closedUntil: new Date(Date.now() + 60_000) }]);
      await receiver.service.run();
      expect(copies()).toHaveLength(0);
      receiver.jobs.getQueueHolds.mockResolvedValue([{ closedUntil: null }]);
      await receiver.service.run();
      expect(copies()).toHaveLength(1);
    });

    it('T19: the service has no call that deletes or trashes media', () => {
      const source = readFileSync(join(import.meta.dirname, 'household-receive.service.ts'), 'utf8');
      expect(source).not.toMatch(/assets\.(remove|delete|updateAll|trash)|trashRepository|AssetDelete|AssetTrash/);
    });
  });
});
