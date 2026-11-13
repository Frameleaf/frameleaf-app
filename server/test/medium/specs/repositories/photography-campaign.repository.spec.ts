import { ConflictException, NotFoundException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotographyCampaignRepository } from 'src/repositories/photography-campaign.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { newUuid } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});
const draft = {
  name: 'Prints',
  templateKey: 'print-sale' as const,
  subject: 'Your prints',
  body: 'Choose your prints.',
  audience: { source: 'clients' as const },
};

it('keeps owner contacts separate and preserves opt-outs when sources are synchronized again', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const { user: other } = await ctx.newUser();
  const repository = new PhotographyCampaignRepository(db);
  for (const owner of [user, other]) {
    await sql`INSERT INTO photography_studio_site ("ownerId",revision,value) VALUES (${owner.id}::uuid,gen_random_uuid(),${JSON.stringify({ inquiries: [{ name: 'Client', email: 'client@example.test' }] })}::text::jsonb)`.execute(
      db,
    );
    await repository.syncContacts(owner.id);
  }
  const [contact] = await repository.contacts(user.id, { source: 'all' });
  expect(contact).toBeDefined();
  expect(await repository.unsubscribe(contact.unsubscribeToken)).toBe(true);
  expect(await repository.unsubscribe(contact.unsubscribeToken)).toBe(true);
  await repository.syncContacts(user.id);
  expect(await repository.contacts(user.id, { source: 'all' })).toEqual([]);
  expect(await repository.contacts(other.id, { source: 'all' })).toHaveLength(1);
  const id = newUuid();
  await repository.save(user.id, id, draft);
  await expect(repository.get(other.id, id)).rejects.toBeInstanceOf(NotFoundException);
  await expect(repository.save(other.id, id, draft)).rejects.toBeInstanceOf(ConflictException);
  await repository.schedule(user.id, id, new Date(0), [contact.id], (await repository.get(user.id, id)).revision);
  expect(await repository.claim(id)).toBeUndefined();
  let sent = false;
  expect(
    await repository.sendIfEligible(id, contact.id, () => {
      sent = true;
      return Promise.resolve();
    }),
  ).toBe(false);
  expect(sent).toBe(false);
});

it('claims each recipient once and resumes untouched recipients without replaying uncertain attempts', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const repository = new PhotographyCampaignRepository(db);
  const contacts = await db
    .insertInto('photography_contact')
    .values(
      ['one', 'two'].map((name) => ({
        ownerId: user.id,
        name,
        email: `${name}@example.test`,
        source: 'clients',
        unsubscribeToken: newUuid().replaceAll('-', '').repeat(2),
        unsubscribedAt: null,
      })),
    )
    .returningAll()
    .execute();
  const id = newUuid();
  await repository.save(user.id, id, draft);
  await repository.schedule(
    user.id,
    id,
    new Date(0),
    contacts.map(({ id }) => id),
    (await repository.get(user.id, id)).revision,
  );
  await expect(
    repository.schedule(
      user.id,
      id,
      new Date(0),
      contacts.map(({ id }) => id),
      (await repository.get(user.id, id)).revision,
    ),
  ).rejects.toBeInstanceOf(ConflictException);
  const claims = await Promise.all([repository.claim(id), repository.claim(id)]);
  expect(claims.filter(Boolean)).toHaveLength(1);
  const first = claims.find(Boolean)!;
  // Emulate time passing without waiting for the account pacing interval.
  await sql`UPDATE photography_campaign_delivery SET "attemptedAt"=now()-interval '11 minutes' WHERE "campaignId"=${id}::uuid`.execute(
    db,
  );
  const second = await new PhotographyCampaignRepository(db).claim(id);
  expect(second?.id).not.toBe(first.id);
  expect(second).toBeDefined();
  await repository.finish(id, second!.id, 'sent');
  await repository.complete(id);
  const result = await repository.get(user.id, id);
  expect(result).toMatchObject({ status: 'completed', sentCount: 1, uncertainCount: 1, pendingCount: 0 });
  expect(await repository.claim(id)).toBeUndefined();
});

it('serializes unsubscribe with a send already in progress and excludes all later sends', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const repository = new PhotographyCampaignRepository(db);
  const contact = await db
    .insertInto('photography_contact')
    .values({
      ownerId: user.id,
      name: 'Client',
      email: 'race@example.test',
      source: 'clients',
      unsubscribeToken: newUuid().replaceAll('-', '').repeat(2),
      unsubscribedAt: null,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const id = newUuid();
  const campaign = await repository.save(user.id, id, draft);
  await repository.schedule(user.id, id, new Date(0), [contact.id], campaign.revision);
  const pending = Promise.withResolvers<void>();
  const sending = Promise.withResolvers<void>();
  const send = repository.sendIfEligible(id, contact.id, async () => {
    sending.resolve();
    await pending.promise;
  });
  await sending.promise;
  const optOut = repository.unsubscribe(contact.unsubscribeToken);
  pending.resolve();
  expect(await send).toBe(true);
  expect(await optOut).toBe(true);
  let laterSend = false;
  expect(
    await repository.sendIfEligible(id, contact.id, () => {
      laterSend = true;
      return Promise.resolve();
    }),
  ).toBe(false);
  expect(laterSend).toBe(false);
});
