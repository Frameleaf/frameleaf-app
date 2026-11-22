import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { HouseholdLinkRepository } from 'src/repositories/household-link.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;
let repository: HouseholdLinkRepository;
beforeAll(async () => {
  database = await getKyselyDB();
  repository = new HouseholdLinkRepository(database);
});
afterAll(async () => {
  await database?.destroy();
});

const newLink = () =>
  repository.create({
    cloudLinkId: randomUUID(),
    peerInstanceId: randomUUID(),
    peerName: 'Ben',
    householdName: 'The Bakers',
    peerPublicKey: 'k'.repeat(43),
  });
const soon = () => new Date(Date.now() + 300_000);

describe(HouseholdLinkRepository.name, () => {
  it('creates a link active with no addresses, and keeps the first row for a Cloud link id', async () => {
    const link = await newLink();
    expect(link).toMatchObject({
      state: 'active',
      addresses: [],
      pausedReason: null,
      connectionPath: null,
      lastSeenAt: null,
      endedAt: null,
    });
    // a second introduction of the same Cloud link never replaces the key stored at pairing
    const again = await repository.create({
      cloudLinkId: link.cloudLinkId,
      peerInstanceId: randomUUID(),
      peerName: 'Mallory',
      householdName: 'Mallory',
      peerPublicKey: 'm'.repeat(43),
    });
    expect(again).toMatchObject({ id: link.id, peerName: 'Ben', peerPublicKey: 'k'.repeat(43) });
    await expect(repository.getByCloudLinkId(link.cloudLinkId)).resolves.toMatchObject({ id: link.id });
    await expect(repository.get(link.id)).resolves.toMatchObject({ cloudLinkId: link.cloudLinkId });
    expect((await repository.getAll()).map(({ id }) => id)).toContain(link.id);
  });

  it('stores addresses as JSON, accepts only the three states, and never changes an ended link', async () => {
    const link = await newLink();
    const addresses = [{ kind: 'wan', uri: 'https://ben.example' }];
    await expect(
      repository.update(link.id, { addresses, connectionPath: 'wan', lastSeenAt: new Date() }),
    ).resolves.toMatchObject({ addresses, connectionPath: 'wan' });
    await expect(repository.update(link.id, { state: 'paused', pausedReason: 'licence' })).resolves.toMatchObject({
      state: 'paused',
    });
    await expect(repository.update(link.id, { state: 'blocked' })).rejects.toThrow(/household_link_state_check/);

    await expect(repository.update(link.id, { state: 'ended', endedAt: new Date() })).resolves.toMatchObject({
      state: 'ended',
    });
    await expect(repository.update(link.id, { state: 'active', endedAt: null })).resolves.toBeUndefined();
    await expect(repository.get(link.id)).resolves.toMatchObject({ state: 'ended', addresses });
    // its name is the administrator's own note, so it can still be changed
    await expect(repository.rename(link.id, 'Nana and Grandad')).resolves.toMatchObject({
      householdName: 'Nana and Grandad',
      state: 'ended',
    });
    await expect(repository.rename(randomUUID(), 'Nobody')).resolves.toBeUndefined();
  });

  it('admits a request id once, across links', async () => {
    const link = await newLink();
    const other = await newLink();
    const jti = randomUUID();
    await expect(repository.admit(jti, link.id, soon())).resolves.toBe(true);
    await expect(repository.admit(jti, link.id, soon())).resolves.toBe(false);
    await expect(repository.admit(jti, other.id, soon())).resolves.toBe(false);
    await expect(repository.admit(randomUUID(), link.id, soon())).resolves.toBe(true);
  });

  it('admits one of many identical requests arriving together', async () => {
    const link = await newLink();
    const jti = randomUUID();
    const results = await Promise.all(Array.from({ length: 12 }, () => repository.admit(jti, link.id, soon())));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('removes admitted requests once their grant has expired, and keeps the live ones', async () => {
    const link = await newLink();
    const expired = randomUUID();
    const live = randomUUID();
    await database
      .insertInto('household_peer_request')
      .values({ jti: expired, linkId: link.id, expiresAt: new Date(Date.now() - 1000) })
      .execute();
    await repository.admit(live, link.id, soon());
    const rows = await database
      .selectFrom('household_peer_request')
      .select('jti')
      .where('linkId', '=', link.id)
      .execute();
    expect(rows.map(({ jti }) => jti)).toEqual([live]);
  });

  it('refuses a request for a link that does not exist, and drops a link’s requests with the link', async () => {
    await expect(repository.admit(randomUUID(), randomUUID(), soon())).rejects.toThrow(/linkId_fkey/);
    const link = await newLink();
    await repository.admit(randomUUID(), link.id, soon());
    await database.deleteFrom('household_link').where('id', '=', link.id).execute();
    const { count } = await database
      .selectFrom('household_peer_request')
      .select(sql<number>`count(*)::int`.as('count'))
      .where('linkId', '=', link.id)
      .executeTakeFirstOrThrow();
    expect(count).toBe(0);
  });
});
