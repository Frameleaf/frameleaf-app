import { HttpException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { MetadataKey } from 'src/enum.js';
import { HouseholdShareService } from 'src/services/household-share.service.js';
import { createDpopProof } from 'src/utils/frameleaf-dpop.js';
import { HouseholdGrantResponse } from 'src/utils/frameleaf-household.js';
import {
  HOUSEHOLD_BODY_CONTENT_TYPE,
  HOUSEHOLD_BODY_HEADER,
  signHouseholdBody,
  signHouseholdDownload,
} from 'src/utils/household-protocol.js';
import {
  type HouseholdCloud,
  type HouseholdServer,
  connectHouseholds,
  householdRequest,
  startHouseholdCloud,
  startHouseholdServer,
} from 'test/fixtures/household-servers.js';

vi.mock('src/utils/config.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getConfig: (repos: { configRepo: { serverName: string } }) =>
    Promise.resolve({ server: { name: repos.configRepo.serverName } }),
}));

type Manifest = Awaited<ReturnType<HouseholdShareService['manifest']>>;
type AssetBody = Record<string, unknown> & { download: { token: string } };

/**
 * FL-979: what leaves Anna's server for Ben's household. Grants and signatures are real; the database is the
 * in-memory `ShareWorld`, whose member-view test stands in for the SQL (the medium spec compares the real query).
 */
describe(HouseholdShareService.name, () => {
  let fixture: HouseholdCloud;
  let anna: HouseholdServer;
  let ben: HouseholdServer;
  let cara: HouseholdServer;
  let link: { ben: string; cara: string };
  let ownerId: string;
  let spaceId: string;
  const benUser = randomUUID();
  const benOther = randomUUID();

  const auth = (id = ownerId) => ({ user: { id } }) as unknown as AuthDto;
  const localLink = (cloudLinkId: string) => anna.links.rows.find((row) => row.cloudLinkId === cloudLinkId)!;
  const status = (promise: Promise<unknown>) =>
    promise
      .then(() => 200)
      .catch((error: unknown) => {
        if (error instanceof HttpException) return error.getStatus();
        throw error;
      });
  const requestAs = async (server: HouseholdServer, linkId: string, route = 'shares', query = '', method = 'GET') => {
    const { token } = await server.peer.cloud(HouseholdGrantResponse, 'grants', { version: 1, linkId });
    const target = `https://${anna.host}/api/household/v1/links/${linkId}/${route}`;
    return householdRequest(
      `${target}${query}`,
      {
        Authorization: `DPoP ${token}`,
        DPoP: createDpopProof(server.peer.signer(), { htm: method, htu: target, accessToken: token }),
      },
      { method },
    );
  };
  const accessAs = async (server: HouseholdServer, linkId: string) =>
    anna.peer.authorize(await requestAs(server, linkId), linkId);
  const asBen = () => accessAs(ben, link.ben);

  /** Offer the space to Ben's account, and accept it. */
  const offer = async ({ accepted = true, userId = benUser, albumId = spaceId, cloudLinkId = link.ben } = {}) => {
    const shareId = (await anna.world.invite({
      albumId,
      linkId: localLink(cloudLinkId).id,
      remoteUserId: userId,
      displayName: 'Ben',
      role: 'contributor',
    })) as string;
    if (accepted) await anna.world.accept(shareId, userId);
    return shareId;
  };
  const readAll = async (shareId: string) => {
    const entries: Manifest['entries'] = [];
    let cursor = '0';
    for (let page = 0; page < 50; page++) {
      const result = await anna.shares.manifest(await asBen(), shareId, { cursor });
      entries.push(...result.entries);
      cursor = result.nextCursor;
      if (result.complete) break;
    }
    return entries;
  };
  const listed = (entries: Manifest['entries']) =>
    entries
      .filter((entry) => 'asset' in entry)
      .map(({ id }) => id)
      .sort();
  const stopped = (entries: Manifest['entries']) =>
    entries
      .filter((entry) => 'stop' in entry)
      .map(({ id }) => id)
      .sort();
  const tokenFor = async (shareId: string, assetId: string) => {
    const entry = (await readAll(shareId)).find((row) => row.id === assetId && 'asset' in row) as unknown as {
      asset: AssetBody;
    };
    return entry.asset.download.token;
  };

  beforeEach(async () => {
    fixture = await startHouseholdCloud();
    anna = await startHouseholdServer(fixture, 'Anna');
    ben = await startHouseholdServer(fixture, 'Ben');
    cara = await startHouseholdServer(fixture, 'Cara');
    const ids: string[] = [];
    for (const server of [ben, cara]) {
      const { token } = await anna.service.invite();
      await server.service.accept(token);
      ids.push(server.links.rows[0].cloudLinkId);
    }
    await anna.service.reconcile();
    link = { ben: ids[0], cara: ids[1] };
    ownerId = randomUUID();
    spaceId = anna.world.addSpace(ownerId);
  });
  afterEach(async () => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    await Promise.all([anna.close(), ben.close(), cara.close(), fixture.cloud.close()]);
  });

  describe('visibility (T6, T7)', () => {
    it('acceptance: the manifest equals the member view, item for item', async () => {
      const { world } = anna;
      const plain = world.addItem(spaceId);
      const archived = world.addItem(spaceId, { visibility: 'archive' });
      world.addItem(spaceId, { deleted: true });
      world.addItem(spaceId, { locked: true });
      world.addItem(spaceId, { ruleHidden: true });
      world.addItem(spaceId, { sensitive: true });
      world.addItem(null); // only in a linked album or the library: not in the space
      const shareId = await offer();

      const entries = await readAll(shareId);
      const memberView = world.items
        .values()
        .filter((item) => world.isMemberVisible(item, spaceId))
        .map(({ id }) => id)
        .toArray()
        .sort();
      expect(listed(entries)).toEqual(memberView);
      expect(listed(entries)).toEqual([plain.id, archived.id].sort());
    });

    it('acceptance: locking an item replaces it with a tombstone that gives no reason', async () => {
      const item = anna.world.addItem(spaceId);
      const shareId = await offer();
      const first = await anna.shares.manifest(await asBen(), shareId, {});
      expect(listed(first.entries)).toEqual([item.id]);

      item.locked = true;
      await anna.shares.onAssetsLocked({ assetIds: [item.id] });
      const next = await anna.shares.manifest(await asBen(), shareId, { cursor: first.nextCursor });
      expect(next.entries).toEqual([{ seq: expect.any(Number), kind: 'asset', id: item.id, stop: true }]);
    });

    it.each(['locked', 'ruleHidden', 'deleted', 'sensitive'] as const)(
      'T7: answers 403 for a %s item even with a still-valid token',
      async (flag) => {
        const item = anna.world.addItem(spaceId);
        const shareId = await offer();
        const token = await tokenFor(shareId, item.id);
        await expect(anna.shares.original(await asBen(), shareId, item.id, token)).resolves.toBeDefined();
        anna.leases.clear();

        item[flag] = true;
        await expect(status(anna.shares.original(await asBen(), shareId, item.id, token))).resolves.toBe(403);
        expect(anna.rates.claimUploadStream).toHaveBeenCalledTimes(1);
      },
    );

    it('T7: the original route refuses a hidden item before any file is sent', async () => {
      const item = anna.world.addItem(spaceId);
      const shareId = await offer();
      const token = await tokenFor(shareId, item.id);
      item.locked = true;
      const route = `shares/${shareId}/originals/${item.id}`;
      const response = { setHeader: vi.fn(), sendFile: vi.fn() };
      await expect(
        status(
          anna.controller.original(
            link.ben,
            shareId,
            item.id,
            token,
            await requestAs(ben, link.ben, route, `?token=${token}`),
            response as never,
            vi.fn(),
          ),
        ),
      ).resolves.toBe(403);
      expect(response.sendFile).not.toHaveBeenCalled();
    });

    it('references a live video only when the part itself may be shared, and serves it through its still', async () => {
      const { world } = anna;
      const motion = world.addItem(null, { ownerId, type: 'VIDEO', visibility: 'hidden' });
      const lockedMotion = world.addItem(null, { ownerId, type: 'VIDEO', visibility: 'hidden', locked: true });
      const still = world.addItem(spaceId, { livePhotoVideoId: motion.id });
      const other = world.addItem(spaceId, { livePhotoVideoId: lockedMotion.id });
      const shareId = await offer();

      const entries = await readAll(shareId);
      const body = (id: string) => (entries.find((entry) => entry.id === id) as unknown as { asset: AssetBody }).asset;
      expect(body(still.id).livePhotoVideoId).toBe(motion.id);
      expect(body(other.id).livePhotoVideoId).toBeNull();
      expect(stopped(entries)).toEqual([lockedMotion.id]);
      expect(listed(entries)).toContain(motion.id);

      still.locked = true;
      await expect(anna.shares.visibleAssetIds(spaceId, [motion.id])).resolves.toEqual(new Set());
    });

    it('names a stack only when its primary and another member are visible', async () => {
      const { world } = anna;
      const [whole, broken] = [randomUUID(), randomUUID()];
      const primary = world.addItem(spaceId, { stackId: whole });
      const member = world.addItem(spaceId, { stackId: whole });
      const hiddenPrimary = world.addItem(spaceId, { stackId: broken, locked: true });
      const orphan = world.addItem(spaceId, { stackId: broken });
      world.stacks.set(whole, primary.id);
      world.stacks.set(broken, hiddenPrimary.id);
      const shareId = await offer();

      const entries = await readAll(shareId);
      const body = (id: string) => (entries.find((entry) => entry.id === id) as unknown as { asset: AssetBody }).asset;
      expect(body(primary.id)).toMatchObject({ stackId: whole, stackPrimary: true });
      expect(body(member.id)).toMatchObject({ stackId: whole, stackPrimary: false });
      expect(body(orphan.id)).toMatchObject({ stackId: null, stackPrimary: false });
    });

    it('never puts a storage path, owner id, favourite or sensitive flag in an asset entry', async () => {
      const item = anna.world.addItem(spaceId);
      const shareId = await offer();
      const [entry] = await readAll(shareId);
      const { asset } = entry as unknown as { asset: AssetBody };
      expect(Object.keys(asset).sort()).toEqual(
        [
          'id',
          'type',
          'originalFileName',
          'checksum',
          'size',
          'fileCreatedAt',
          'localDateTime',
          'timeZone',
          'description',
          'rating',
          'latitude',
          'longitude',
          'city',
          'state',
          'country',
          'width',
          'height',
          'duration',
          'livePhotoVideoId',
          'stackId',
          'stackPrimary',
          'updatedAt',
          'download',
        ].sort(),
      );
      const serialised = JSON.stringify(entry);
      expect(serialised).not.toContain(item.originalPath);
      expect(serialised).not.toContain(ownerId);
    });

    it('caps the file name and the description', async () => {
      anna.world.addItem(spaceId, { originalFileName: 'n'.repeat(400), description: 'd'.repeat(20_000) });
      const shareId = await offer();
      const [entry] = await readAll(shareId);
      const { asset } = entry as unknown as { asset: { originalFileName: string; description: string } };
      expect(asset.originalFileName).toHaveLength(255);
      expect(asset.description).toHaveLength(10_000);
    });
  });

  describe('people', () => {
    const addPerson = (name = 'Nana', personGroupId = randomUUID()) => {
      const person = { id: randomUUID(), albumId: spaceId, name, personOwnerId: ownerId, personGroupId };
      anna.world.people.push(person);
      return person;
    };

    it('acceptance: lists face boxes only on assets in the manifest', async () => {
      const { world } = anna;
      const person = addPerson();
      const shown = world.addItem(spaceId);
      const locked = world.addItem(spaceId, { locked: true });
      const outside = world.addItem(null);
      for (const { id } of [shown, locked, outside])
        world.faces.push({ assetId: id, personGroupId: person.personGroupId });
      const shareId = await offer();

      const entry = (await readAll(shareId)).find(({ id }) => id === person.id) as unknown as {
        person: { name: string; faces: Array<{ assetId: string }> };
      };
      expect(entry.person.name).toBe('Nana');
      expect(entry.person.faces.map(({ assetId }) => assetId)).toEqual([shown.id]);
      expect(Object.keys(entry.person.faces[0]).sort()).toEqual(['assetId', 'height', 'width', 'x1', 'x2', 'y1', 'y2']);
    });

    it('never lists a person a Locked rule hides, by name or by face', async () => {
      const { world } = anna;
      const person = addPerson('Secret');
      const item = world.addItem(spaceId);
      world.faces.push({ assetId: item.id, personGroupId: person.personGroupId });
      world.personRules.set(ownerId, [person.personGroupId]);
      const shareId = await offer();

      const entries = await readAll(shareId);
      expect(entries.find(({ id }) => id === person.id)).toEqual({
        seq: expect.any(Number),
        kind: 'person',
        id: person.id,
        stop: true,
      });
      expect(JSON.stringify(entries)).not.toContain('Secret');
    });

    it('does not name a person who is on no visible item', async () => {
      const { world } = anna;
      const person = addPerson('Only Hidden');
      const item = world.addItem(spaceId, { locked: true });
      world.faces.push({ assetId: item.id, personGroupId: person.personGroupId });
      const shareId = await offer();
      expect(JSON.stringify(await readAll(shareId))).not.toContain('Only Hidden');
    });
  });

  describe('paging', () => {
    it('acceptance: pages are stable and resume from a cursor', async () => {
      const items = Array.from({ length: 5 }, () => anna.world.addItem(spaceId));
      const shareId = await offer();

      const first = await anna.shares.manifest(await asBen(), shareId, { limit: '2' });
      expect(first.entries).toHaveLength(2);
      expect(first.complete).toBe(false);
      const again = await anna.shares.manifest(await asBen(), shareId, { limit: '2' });
      expect(again.entries.map(({ seq }) => seq)).toEqual(first.entries.map(({ seq }) => seq));

      // an item already read changes while the reader is between pages: it comes round again, in its latest state
      await anna.shares.onAssetChanged({ assetId: first.entries[0].id });
      const seen = new Set(first.entries.map(({ id }) => id));
      let cursor = first.nextCursor;
      const later: string[] = [];
      for (;;) {
        const page = await anna.shares.manifest(await asBen(), shareId, { cursor, limit: '2' });
        later.push(...page.entries.map(({ id }) => id));
        cursor = page.nextCursor;
        if (page.complete) break;
      }
      expect(later).toContain(first.entries[0].id);
      expect(new Set([...seen, ...later])).toEqual(new Set(items.map(({ id }) => id)));
    });

    it('caps a page at 200 entries and cuts it at 2 MiB without losing an entry', async () => {
      for (let index = 0; index < 205; index++) anna.world.addItem(spaceId);
      const shareId = await offer();
      const page = await anna.shares.manifest(await asBen(), shareId, { limit: '9999' });
      expect(page.entries).toHaveLength(200);
      expect(page.complete).toBe(false);

      const big = Array.from({ length: 300 }, () => anna.world.addItem(spaceId, { description: 'x'.repeat(10_000) }));
      const bigSpaceShare = await offer();
      expect(bigSpaceShare).toBe(shareId);
      await anna.shares.onAssetsChanged({ assetIds: big.map(({ id }) => id) });
      const before = await anna.world.getLastSeq(shareId);
      const cursor = String(before - big.length);
      const cut = await anna.shares.manifest(await asBen(), shareId, { cursor });
      expect(Buffer.byteLength(JSON.stringify(cut))).toBeLessThanOrEqual(2 * 1024 * 1024);
      expect(cut.entries.length).toBeLessThan(200);
      expect(cut.complete).toBe(false);
      const next = await anna.shares.manifest(await asBen(), shareId, { cursor: cut.nextCursor, limit: '1' });
      expect(next.entries[0].seq).toBeGreaterThan(cut.entries.at(-1)!.seq);
    });

    it('answers 410 to a cursor past the end of the feed, and 400 to a malformed one', async () => {
      anna.world.addItem(spaceId);
      const shareId = await offer();
      const last = await anna.world.getLastSeq(shareId);
      await expect(status(anna.shares.manifest(await asBen(), shareId, { cursor: String(last + 1) }))).resolves.toBe(
        410,
      );
      await expect(status(anna.shares.manifest(await asBen(), shareId, { cursor: 'abc' }))).resolves.toBe(400);
    });
  });

  describe('who may read (T6)', () => {
    it('acceptance: a peer without an accepted member gets 403', async () => {
      const item = anna.world.addItem(spaceId);
      const shareId = await offer({ accepted: false });
      await expect(status(anna.shares.manifest(await asBen(), shareId, {}))).resolves.toBe(403);
      await expect(status(anna.shares.original(await asBen(), shareId, item.id, 'x'))).resolves.toBe(403);
    });

    it('T6: a share of link A requested over link B answers a bare 403', async () => {
      const item = anna.world.addItem(spaceId);
      const shareId = await offer();
      const token = await tokenFor(shareId, item.id);
      const asCara = () => accessAs(cara, link.cara);
      await expect(status(anna.shares.manifest(await asCara(), shareId, {}))).resolves.toBe(403);
      await expect(status(anna.shares.original(await asCara(), shareId, item.id, token))).resolves.toBe(403);
      await expect(status(anna.shares.accept(await asCara(), shareId, benUser))).resolves.toBe(403);
      await expect(status(anna.shares.leave(await asCara(), shareId, benUser))).resolves.toBe(403);
      await expect(anna.shares.offered(await asCara())).resolves.toEqual([]);
      const unknown = await anna.shares.manifest(await asCara(), shareId, {}).catch((error: HttpException) => error);
      const missing = await anna.shares
        .manifest(await asCara(), randomUUID(), {})
        .catch((error: HttpException) => error);
      expect((unknown as HttpException).getResponse()).toEqual((missing as HttpException).getResponse());
    });

    it('acceptance: an unknown member on accept or leave gets 403', async () => {
      const shareId = await offer({ accepted: false });
      await expect(status(anna.shares.accept(await asBen(), shareId, randomUUID()))).resolves.toBe(403);
      await expect(status(anna.shares.leave(await asBen(), shareId, randomUUID()))).resolves.toBe(403);
      await expect(status(anna.shares.accept(await asBen(), shareId, 'not-a-uuid'))).resolves.toBe(403);
    });

    it('a member who left cannot accept again until invited again', async () => {
      const shareId = await offer();
      await anna.shares.leave(await asBen(), shareId, benUser);
      await expect(status(anna.shares.accept(await asBen(), shareId, benUser))).resolves.toBe(403);
      await expect(status(anna.shares.manifest(await asBen(), shareId, {}))).resolves.toBe(403);
    });

    it('acceptance: a removed member’s next manifest read is 403', async () => {
      anna.world.addItem(spaceId);
      const shareId = await offer();
      await expect(status(anna.shares.manifest(await asBen(), shareId, {}))).resolves.toBe(200);
      await anna.shares.removeMember(auth(), spaceId, shareId, benUser);
      await expect(status(anna.shares.manifest(await asBen(), shareId, {}))).resolves.toBe(403);
      expect(anna.world.shares).toHaveLength(0);
    });

    it('acceptance: another member leaving sends no stop for items still in the space', async () => {
      const item = anna.world.addItem(spaceId);
      const shareId = await offer();
      await offer({ userId: benOther });
      const before = await anna.shares.manifest(await asBen(), shareId, {});
      await anna.shares.leave(await asBen(), shareId, benOther);
      const after = await anna.shares.manifest(await asBen(), shareId, { cursor: before.nextCursor });
      expect(after.entries).toEqual([]);
      expect(stopped(await readAll(shareId))).toEqual([]);
      expect(listed(await readAll(shareId))).toEqual([item.id]);
    });
  });

  describe('download token', () => {
    it('refuses a token for another share, another item, an expired one or a bad signature', async () => {
      const item = anna.world.addItem(spaceId);
      const other = anna.world.addItem(spaceId);
      const secondSpace = anna.world.addSpace(ownerId, 'Second');
      anna.world.items.get(item.id)!.albums.add(secondSpace);
      const shareId = await offer();
      const secondShare = await offer({ albumId: secondSpace });
      const token = await tokenFor(shareId, item.id);
      const checksum = item.checksum.toString('hex');
      const sign = (change: object) =>
        signHouseholdDownload(anna.peer.signer(), {
          linkId: localLink(link.ben).id,
          shareId,
          assetId: item.id,
          checksum,
          exp: Math.floor(Date.now() / 1000) + 60,
          ...change,
        });

      await expect(status(anna.shares.original(await asBen(), secondShare, item.id, token))).resolves.toBe(403);
      await expect(status(anna.shares.original(await asBen(), shareId, other.id, token))).resolves.toBe(403);
      await expect(
        status(anna.shares.original(await asBen(), shareId, item.id, sign({ exp: Math.floor(Date.now() / 1000) - 1 }))),
      ).resolves.toBe(403);
      await expect(
        status(anna.shares.original(await asBen(), shareId, item.id, sign({ linkId: localLink(link.cara).id }))),
      ).resolves.toBe(403);
      await expect(
        status(anna.shares.original(await asBen(), shareId, item.id, sign({ checksum: 'a'.repeat(40) }))),
      ).resolves.toBe(403);
      const forged = signHouseholdDownload(ben.peer.signer(), {
        linkId: localLink(link.ben).id,
        shareId,
        assetId: item.id,
        checksum,
        exp: Math.floor(Date.now() / 1000) + 60,
      });
      await expect(status(anna.shares.original(await asBen(), shareId, item.id, forged))).resolves.toBe(403);
      await expect(status(anna.shares.original(await asBen(), shareId, item.id, 'garbage'))).resolves.toBe(403);
      await expect(status(anna.shares.original(await asBen(), shareId, item.id, undefined))).resolves.toBe(403);
    });

    it('T15: a third concurrent download gets 503, and a finished one frees its slot', async () => {
      const item = anna.world.addItem(spaceId);
      const shareId = await offer();
      const token = await tokenFor(shareId, item.id);
      const first = await anna.shares.original(await asBen(), shareId, item.id, token);
      await anna.shares.original(await asBen(), shareId, item.id, token);
      await expect(status(anna.shares.original(await asBen(), shareId, item.id, token))).resolves.toBe(503);
      await first.release?.();
      await expect(status(anna.shares.original(await asBen(), shareId, item.id, token))).resolves.toBe(200);
    });
  });

  describe('directory and addresses (T8, T9)', () => {
    const account = (name: string, profileImagePath = '') => ({
      id: randomUUID(),
      name,
      email: `${name.toLowerCase().replaceAll(' ', '.')}@example.com`,
      profileImagePath,
      active: true,
    });

    it('T8: directory entries are exactly id, name and hasAvatar, for active accounts', async () => {
      const shown = account('Anna', '/data/profile/a.jpg');
      anna.world.accounts.push(shown, { ...account('Gone'), active: false });
      await expect(anna.shares.directory()).resolves.toEqual([{ id: shown.id, name: 'Anna', hasAvatar: true }]);
    });

    it('T9: no manifest, shares list or directory reply contains an address', async () => {
      const { world } = anna;
      world.accounts.push(account('Anna'), { ...account('x'), name: 'named.after@example.com' });
      world.spaces.get(spaceId)!.ownerName = 'owner@example.com';
      world.addItem(spaceId);
      world.people.push({
        id: randomUUID(),
        albumId: spaceId,
        name: 'face@example.com',
        personOwnerId: ownerId,
        personGroupId: randomUUID(),
      });
      const person = world.people[0];
      world.faces.push({ assetId: world.items.keys().next().value!, personGroupId: person.personGroupId });
      const shareId = await offer();

      const replies = [await anna.shares.directory(), await anna.shares.offered(await asBen()), await readAll(shareId)];
      for (const reply of replies) expect(JSON.stringify(reply)).not.toContain('@');
    });

    it('T8: an avatar must be a small image of an active account', async () => {
      const { world } = anna;
      const good = account('Good', '/data/profile/good.jpg');
      const large = account('Large', '/data/profile/large.jpg');
      const svg = account('Svg', '/data/profile/s.svg');
      world.accounts.push(good, large, svg);
      world.fileSizes.set(large.profileImagePath, 1024 * 1024 + 1);
      await expect(anna.shares.avatar(good.id)).resolves.toMatchObject({ contentType: 'image/jpeg' });
      for (const id of [large.id, svg.id, randomUUID(), 'x'])
        await expect(status(anna.shares.avatar(id))).resolves.toBe(404);
    });

    it('T21: the shares list says nothing about whether a named account exists', async () => {
      const shareId = await offer({ accepted: false, userId: randomUUID() });
      const [offered] = await anna.shares.offered(await asBen());
      expect(offered.id).toBe(shareId);
      expect(Object.keys(offered.members[0]).sort()).toEqual(['remoteUserId', 'role', 'state']);
      expect(offered.members[0].state).toBe('invited');
    });

    it('takes one poke a minute and ignores the rest', async () => {
      await expect(anna.shares.poke(await asBen())).resolves.toBe(true);
      await expect(anna.shares.poke(await asBen())).resolves.toBe(false);
    });
  });

  describe('owner API', () => {
    const remote = (id = benUser) => [{ id, name: 'Ben Remote', hasAvatar: false }];
    const useDirectory = (entries: unknown) => vi.spyOn(anna.service, 'readPeer').mockResolvedValue(entries);

    it('refuses anyone but the space owner', async () => {
      useDirectory(remote());
      const dto = { linkId: localLink(link.ben).id, remoteUserId: benUser, role: 'viewer' as const };
      await expect(status(anna.shares.listLinks(auth(randomUUID()), spaceId))).resolves.toBe(400);
      await expect(status(anna.shares.invite(auth(randomUUID()), spaceId, dto))).resolves.toBe(400);
    });

    it('stores the name the directory gave, seeds the feed, and caches the directory', async () => {
      const read = useDirectory(remote());
      const item = anna.world.addItem(spaceId);
      const dto = { linkId: localLink(link.ben).id, remoteUserId: benUser, role: 'contributor' as const };
      const member = await anna.shares.invite(auth(), spaceId, dto);
      expect(member).toMatchObject({ displayName: 'Ben Remote', role: 'contributor', state: 'invited' });
      expect(anna.world.changes.map(({ entityId }) => entityId)).toEqual([item.id]);

      const links = await anna.shares.listLinks(auth(), spaceId);
      expect(links.find(({ linkId }) => linkId === dto.linkId)?.members).toHaveLength(1);
      expect(JSON.stringify(links)).not.toContain('@');
      expect(read.mock.calls.filter(([row]) => row.id === dto.linkId)).toHaveLength(1);
    });

    it('reads the directory again after five minutes', async () => {
      const read = useDirectory(remote());
      await anna.shares.listLinks(auth(), spaceId);
      const calls = read.mock.calls.length;
      const now = Date.now();
      vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60_000 + 1);
      await anna.shares.listLinks(auth(), spaceId);
      expect(read.mock.calls.length).toBeGreaterThan(calls);
    });

    it('refuses an account the directory does not list, or a directory with an extra field', async () => {
      useDirectory(remote(randomUUID()));
      const dto = { linkId: localLink(link.ben).id, remoteUserId: benUser, role: 'viewer' as const };
      await expect(status(anna.shares.invite(auth(), spaceId, dto))).resolves.toBe(400);
      expect(anna.world.shares).toHaveLength(0);
    });

    it('keeps to 200 shares a link and 50 members a share', async () => {
      useDirectory(remote());
      const dto = { linkId: localLink(link.ben).id, remoteUserId: benUser, role: 'viewer' as const };
      anna.world.shares = Array.from({ length: 200 }, () => ({
        id: randomUUID(),
        albumId: randomUUID(),
        linkId: dto.linkId,
      }));
      await expect(status(anna.shares.invite(auth(), spaceId, dto))).resolves.toBe(400);

      anna.world.shares = [];
      const shareId = await offer({ userId: randomUUID() });
      for (let index = 0; index < 49; index++) await offer({ userId: randomUUID() });
      await expect(status(anna.shares.invite(auth(), spaceId, dto))).resolves.toBe(400);
      expect(anna.world.members.filter((member) => member.shareId === shareId)).toHaveLength(50);
    });

    it('changes a role, and answers 404 for a member of another space', async () => {
      const shareId = await offer();
      await anna.shares.setRole(auth(), spaceId, shareId, benUser, 'contributor');
      expect(anna.world.members[0].role).toBe('contributor');
      const otherSpace = anna.world.addSpace(ownerId, 'Other');
      await expect(status(anna.shares.setRole(auth(), otherSpace, shareId, benUser, 'viewer'))).resolves.toBe(404);
      await expect(status(anna.shares.removeMember(auth(), otherSpace, shareId, benUser))).resolves.toBe(404);
    });
  });

  describe('change feed hooks', () => {
    it('registers every hook under its own event', () => {
      const reflector = new Reflector();
      const names = Object.getOwnPropertyNames(HouseholdShareService.prototype).flatMap((name) => {
        const method = (HouseholdShareService.prototype as unknown as Record<string, () => void>)[name];
        const event = typeof method === 'function' && reflector.get(MetadataKey.EventConfig, method);
        return event ? [(event as { name: string }).name] : [];
      });
      expect(new Set(names).size).toBe(names.length);
      expect(names).toEqual(
        expect.arrayContaining([
          'AssetsChanged',
          'AssetLocked',
          'AssetTrashAll',
          'AssetRestoreAll',
          'AssetDeleteAll',
          'AssetMetadataExtracted',
          'AlbumUpdate',
          'HouseholdFeedAssets',
          'HouseholdFeedPerson',
          'LockedRulesChanged',
        ]),
      );
    });

    it('moves a removed item to a new seq, and it then reads as stop', async () => {
      const item = anna.world.addItem(spaceId);
      const shareId = await offer();
      const first = await anna.shares.manifest(await asBen(), shareId, {});
      item.albums.delete(spaceId);
      await anna.shares.onAssetsChanged({ assetIds: [item.id] });
      const next = await anna.shares.manifest(await asBen(), shareId, { cursor: first.nextCursor });
      expect(stopped(next.entries)).toEqual([item.id]);
    });

    it('adds a new item on an album update without moving the others', async () => {
      const old = anna.world.addItem(spaceId);
      const shareId = await offer();
      const seq = anna.world.changes.find(({ entityId }) => entityId === old.id)!.seq;
      const added = anna.world.addItem(spaceId);
      await anna.shares.onAlbumUpdate({ id: spaceId, userIds: [], recipientIds: [] });
      expect(anna.world.changes.find(({ entityId }) => entityId === old.id)!.seq).toBe(seq);
      expect(listed(await readAll(shareId))).toContain(added.id);
    });

    it('a Locked-rule change moves every item of that owner and the people of those shares', async () => {
      const mine = anna.world.addItem(spaceId);
      const theirs = anna.world.addItem(spaceId, { ownerId: randomUUID() });
      const person = {
        id: randomUUID(),
        albumId: spaceId,
        name: 'N',
        personOwnerId: ownerId,
        personGroupId: randomUUID(),
      };
      anna.world.people.push(person);
      await offer();
      const seqOf = (id: string) => anna.world.changes.find(({ entityId }) => entityId === id)!.seq;
      const before = [seqOf(mine.id), seqOf(theirs.id), seqOf(person.id)];
      await anna.shares.onLockedRules({ userId: ownerId });
      expect(seqOf(mine.id)).toBeGreaterThan(before[0]);
      expect(seqOf(theirs.id)).toBe(before[1]);
      expect(seqOf(person.id)).toBeGreaterThan(before[2]);
    });

    it('never fails the action that fired it', async () => {
      await offer();
      vi.spyOn(anna.world, 'touchAssets').mockRejectedValue(new Error('database unavailable'));
      await expect(anna.shares.onAssetsLocked({ assetIds: [randomUUID()] })).resolves.toBeUndefined();
      expect(anna.logger.warn).toHaveBeenCalled();
    });
  });

  describe('comments (FL-1012, T9, T16, T17)', () => {
    const post = (change: Record<string, unknown> = {}) => ({
      id: randomUUID(),
      userId: benUser,
      assetId: null,
      isLiked: false,
      comment: 'Lovely day',
      ...change,
    });
    const commentEntry = (entries: Manifest['entries'], id: string) =>
      entries.find((entry) => entry.kind === 'comment' && entry.id === id) as unknown as
        { stop?: true; comment?: Record<string, any> } | undefined;
    /** A POST through the real controller, with the body signature a peer must produce. */
    const postRaw = async (
      shareId: string,
      raw: string,
      tamper?: string,
      contentType = HOUSEHOLD_BODY_CONTENT_TYPE,
    ) => {
      const { token } = await ben.peer.cloud(HouseholdGrantResponse, 'grants', { version: 1, linkId: link.ben });
      const target = `https://${anna.host}/api/household/v1/links/${link.ben}/shares/${shareId}/comments`;
      const proof = createDpopProof(ben.peer.signer(), { htm: 'POST', htu: target, accessToken: token });
      const { jti } = JSON.parse(Buffer.from(proof.split('.', 2)[1], 'base64url').toString()) as { jti: string };
      const request = householdRequest(
        target,
        {
          Authorization: `DPoP ${token}`,
          DPoP: proof,
          'Content-Type': contentType,
          [HOUSEHOLD_BODY_HEADER]: signHouseholdBody(ben.peer.signer(), jti, raw),
        },
        { method: 'POST', body: tamper ?? raw },
      );
      return anna.controller.postComment(link.ben, shareId, request, { setHeader: vi.fn() } as never);
    };

    it('lists a local comment with its author by name and no email (T9)', async () => {
      anna.world.comments.localUsers.set(ownerId, 'anna@example.com');
      const row = anna.world.comments.addLocal({ albumId: spaceId, userId: ownerId, comment: 'Hello Ben' });
      const shareId = await offer();
      const entries = await readAll(shareId);
      expect(commentEntry(entries, row.id)?.comment).toMatchObject({
        assetId: null,
        isLiked: false,
        comment: 'Hello Ben',
        author: { household: 'local', id: ownerId, name: 'Member' },
      });
      expect(JSON.stringify(entries)).not.toContain('anna@example.com');
    });

    it('seeds existing comments when a share is created, after the items they are about', async () => {
      const item = anna.world.addItem(spaceId);
      const row = anna.world.comments.addLocal({ albumId: spaceId, userId: ownerId, assetId: item.id });
      const shareId = await offer();
      const entries = await readAll(shareId);
      const position = (id: string) => entries.findIndex((entry) => entry.id === id);
      expect(position(row.id)).toBeGreaterThan(position(item.id));
    });

    it('a comment on a Locked, trashed, hidden or removed item is stop, and comes back when the item does', async () => {
      const cases: Array<Record<string, unknown>> = [
        { locked: true },
        { deleted: true },
        { visibility: 'hidden' },
        { albums: new Set() },
      ];
      for (const change of cases) {
        const item = anna.world.addItem(spaceId);
        const row = anna.world.comments.addLocal({ albumId: spaceId, userId: ownerId, assetId: item.id });
        const shareId = await offer();
        await anna.shares.onComments({ albumId: spaceId, activityIds: [row.id], deleted: false });
        expect(commentEntry(await readAll(shareId), row.id)?.comment).toBeDefined();

        Object.assign(item, change);
        await anna.shares.onFeedAssets({ assetIds: [item.id] });
        const hidden = commentEntry(await readAll(shareId), row.id);
        expect(hidden).toMatchObject({ stop: true });
        expect(hidden?.comment).toBeUndefined();

        Object.assign(item, { locked: false, deleted: false, visibility: 'timeline', albums: new Set([spaceId]) });
        await anna.shares.onFeedAssets({ assetIds: [item.id] });
        expect(commentEntry(await readAll(shareId), row.id)?.comment).toBeDefined();
      }
    });

    it('T16: comment as a non-member, an invited member or a member who left → 403', async () => {
      const shareId = await offer();
      await offer({ accepted: false, userId: benOther });
      const access = await asBen();
      expect(await status(anna.shares.postComment(access, shareId, post({ userId: randomUUID() })))).toBe(403);
      expect(await status(anna.shares.postComment(access, shareId, post({ userId: benOther })))).toBe(403);
      await anna.world.leave(shareId, benUser);
      expect(await status(anna.shares.postComment(access, shareId, post()))).toBe(403);
      expect(anna.world.comments.activities.size).toBe(0);
    });

    it('a Viewer cannot post or edit, but can still delete what they wrote as a Contributor', async () => {
      const shareId = await offer();
      const access = await asBen();
      const { id } = await anna.shares.postComment(access, shareId, post());
      await anna.shares.setRole(auth(), spaceId, shareId, benUser, 'viewer');

      expect(await status(anna.shares.postComment(await asBen(), shareId, post({ id: randomUUID() })))).toBe(403);
      expect(
        await status(
          anna.shares.postComment(
            await asBen(),
            shareId,
            post({ id: randomUUID(), comment: undefined, isLiked: true }),
          ),
        ),
      ).toBeGreaterThanOrEqual(400);
      const edit = { userId: benUser, comment: 'Changed' };
      expect(await status(anna.shares.putComment(await asBen(), shareId, id, edit))).toBe(403);
      expect(anna.world.comments.activities.get(id)?.comment).toBe('Lovely day');

      await anna.shares.deleteComment(await asBen(), shareId, id, { userId: benUser });
      expect(anna.world.comments.activities.has(id)).toBe(false);
    });

    it('T6: a member of the share on another link cannot be named over this one', async () => {
      const shareId = await offer();
      const access = await accessAs(cara, link.cara);
      expect(await status(anna.shares.postComment(access, shareId, post()))).toBe(403);
    });

    it('T16: a body naming one of the sender’s local users → 403, even if the directory listed that id', async () => {
      const localUser = randomUUID();
      anna.world.comments.localUsers.set(localUser, 'Anna');
      const shareId = await offer({ userId: localUser });
      await offer();
      const access = await asBen();
      expect(await status(anna.shares.postComment(access, shareId, post({ userId: localUser })))).toBe(403);
      expect(anna.world.comments.activities.size).toBe(0);
    });

    it('T16: edit or delete another member’s comment, or a local one → 403', async () => {
      const shareId = await offer();
      await offer({ userId: benOther });
      const access = await asBen();
      const { id } = await anna.shares.postComment(access, shareId, post());
      const local = anna.world.comments.addLocal({ albumId: spaceId, userId: ownerId });
      const other = { userId: benOther, comment: 'Not yours' };
      expect(await status(anna.shares.putComment(access, shareId, id, other))).toBe(403);
      expect(await status(anna.shares.deleteComment(access, shareId, id, { userId: benOther }))).toBe(403);
      const mine = { userId: benUser, comment: 'Mine now' };
      expect(await status(anna.shares.putComment(access, shareId, local.id, mine))).toBe(403);
      expect(await status(anna.shares.deleteComment(access, shareId, local.id, { userId: benUser }))).toBe(403);
      expect(anna.world.comments.activities.get(id)?.comment).toBe('Lovely day');
      expect(anna.world.comments.activities.get(local.id)?.comment).toBe('hello');
    });

    it('comment on a Locked or out-of-space item → 403, and nothing is stored', async () => {
      const locked = anna.world.addItem(spaceId, { locked: true });
      const elsewhere = anna.world.addItem(null);
      const shareId = await offer();
      const access = await asBen();
      for (const assetId of [locked.id, elsewhere.id, randomUUID()]) {
        expect(await status(anna.shares.postComment(access, shareId, post({ assetId })))).toBe(403);
      }
      expect(anna.world.comments.activities.size).toBe(0);
    });

    it('over-length, wrong-type and unknown-field bodies → 400', async () => {
      const shareId = await offer();
      const access = await asBen();
      for (const body of [
        post({ comment: 'x'.repeat(4001) }),
        post({ comment: 42 }),
        post({ comment: ' '.repeat(3) }),
        post({ isLiked: 'yes' }),
        post({ isLiked: true }),
        post({ comment: null }),
        post({ userId: 'ben' }),
        post({ id: 'not-a-uuid' }),
        post({ email: 'ben@example.com' }),
        post({ remoteAuthorId: randomUUID() }),
        null,
        [],
      ]) {
        expect(await status(anna.shares.postComment(access, shareId, body))).toBe(400);
      }
      const { id } = await anna.shares.postComment(access, shareId, post());
      const refusals = [
        { userId: benUser, comment: 'x'.repeat(4001) },
        { userId: benUser, comment: 'ok', isLiked: true },
      ];
      for (const body of refusals) {
        expect(await status(anna.shares.putComment(access, shareId, id, body))).toBe(400);
      }
      expect(await status(anna.shares.deleteComment(access, shareId, id, { userId: benUser, x: 1 }))).toBe(400);
    });

    it('T17: markup is stored and sent as the same plain text', async () => {
      const shareId = await offer();
      const markup = '<img src=x onerror=alert(1)><script>alert(2)</script>';
      const { id } = await anna.shares.postComment(await asBen(), shareId, post({ comment: markup }));
      expect(anna.world.comments.activities.get(id)?.comment).toBe(markup);
      expect(commentEntry(await readAll(shareId), id)?.comment?.comment).toBe(markup);
    });

    it('allows 30 writes per member per minute, then 429', async () => {
      const shareId = await offer();
      await offer({ userId: benOther });
      const access = await asBen();
      for (let index = 0; index < 30; index++) {
        await anna.shares.postComment(access, shareId, post());
      }
      expect(await status(anna.shares.postComment(access, shareId, post()))).toBe(429);
      expect(await status(anna.shares.postComment(access, shareId, post({ userId: benOther })))).toBe(200);
      expect(anna.world.comments.activities.size).toBe(31);
    });

    it('a retried post with the same id does not post twice', async () => {
      const shareId = await offer();
      const access = await asBen();
      const body = post();
      const first = await anna.shares.postComment(access, shareId, body);
      const second = await anna.shares.postComment(access, shareId, body);
      expect(second).toEqual(first);
      expect(anna.world.comments.activities.size).toBe(1);
      expect(anna.world.comments.events).toHaveLength(1);
    });

    it('T16: a post reusing the id of someone else’s comment is refused and changes nothing', async () => {
      const shareId = await offer();
      await offer({ userId: benOther });
      const local = anna.world.comments.addLocal({ albumId: spaceId, userId: ownerId });
      const access = await asBen();
      expect(await status(anna.shares.postComment(access, shareId, post({ id: local.id })))).toBe(403);
      const { id } = await anna.shares.postComment(access, shareId, post());
      expect(await status(anna.shares.postComment(access, shareId, post({ id, userId: benOther })))).toBe(403);
      expect(anna.world.comments.activities.get(local.id)?.comment).toBe('hello');
    });

    it('a like is one per person and item, under the latest id', async () => {
      const item = anna.world.addItem(spaceId);
      const shareId = await offer();
      const access = await asBen();
      const like = { assetId: item.id, isLiked: true, comment: null };
      const first = await anna.shares.postComment(access, shareId, post(like));
      const second = await anna.shares.postComment(access, shareId, post(like));
      expect(second.id).not.toBe(first.id);
      expect(anna.world.comments.activities.keys().toArray()).toEqual([second.id]);
      expect(commentEntry(await readAll(shareId), first.id)).toMatchObject({ stop: true });
    });

    it('a deleted comment reads as stop and touches no media', async () => {
      const item = anna.world.addItem(spaceId);
      const shareId = await offer();
      const access = await asBen();
      const { id } = await anna.shares.postComment(access, shareId, post({ assetId: item.id }));
      await anna.shares.deleteComment(access, shareId, id, { userId: benUser });
      expect(anna.world.comments.activities.has(id)).toBe(false);
      expect(commentEntry(await readAll(shareId), id)).toMatchObject({ stop: true });
      expect(anna.world.items.get(item.id)?.deleted).toBeFalsy();
      expect(anna.world.items.get(item.id)?.locked).toBeFalsy();
    });

    it('a mention notifies only this server’s members of the space', async () => {
      const member = randomUUID();
      const outsider = randomUUID();
      anna.world.comments.albumMembers.set(spaceId, new Set([member]));
      const shareId = await offer();
      const comment = `@{${member}} @{${outsider}} @{${benOther}}`;
      await anna.shares.postComment(await asBen(), shareId, post({ comment }));
      expect(anna.events.emit).toHaveBeenCalledWith(
        'SharedSpaceMention',
        expect.objectContaining({ userIds: [member], senderName: 'Ben' }),
      );
    });

    it('a body must carry this request’s signature, the private type and at most 64 KiB', async () => {
      const shareId = await offer();
      const raw = JSON.stringify(post());
      expect(await status(postRaw(shareId, raw))).toBe(200);
      const forged = JSON.stringify(post({ comment: 'changed by a relay' }));
      expect(await status(postRaw(shareId, JSON.stringify(post()), forged))).toBe(401);
      expect(await status(postRaw(shareId, raw, undefined, 'application/json'))).toBe(415);
      const huge = JSON.stringify(post({ comment: 'x'.repeat(70_000) }));
      expect(await status(postRaw(shareId, huge))).toBe(413);
      expect(anna.world.comments.activities.size).toBe(1);
    });

    it('an ended link refuses comments and keeps the history', async () => {
      const shareId = await offer();
      const { id } = await anna.shares.postComment(await asBen(), shareId, post());
      Object.assign(localLink(link.ben), { state: 'ended' });
      expect(await status(postRaw(shareId, JSON.stringify(post())))).toBe(403);
      expect(anna.world.comments.activities.has(id)).toBe(true);
    });
  });

  it('reads the other household’s directory through the signed client', async () => {
    connectHouseholds({ [ben.host]: ben });
    const benAccount = { id: benUser, name: 'Ben', email: 'ben@example.com', profileImagePath: '', active: true };
    ben.world.accounts.push(benAccount);
    const links = await anna.shares.listLinks(auth(), spaceId);
    const entry = links.find(({ linkId }) => linkId === localLink(link.ben).id)!;
    expect(entry.reachable).toBe(true);
    expect(entry.directory).toEqual([{ id: benUser, name: 'Ben', hasAvatar: false }]);
    expect(links.find(({ linkId }) => linkId === localLink(link.cara).id)?.reachable).toBe(false);
  });
});
