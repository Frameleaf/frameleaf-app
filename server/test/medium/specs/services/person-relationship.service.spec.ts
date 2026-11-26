import { Kysely } from 'kysely';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerOriginRepository } from 'src/repositories/partner-origin.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { PersonRelationshipService } from 'src/services/person-relationship.service.js';
import { PersonService } from 'src/services/person.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-842 against PostgreSQL: the table's rules, a merge, a deleted person and a partner's copies. */
let database: Kysely<DB>;
beforeAll(async () => {
  database = await getKyselyDB();
});
afterAll(async () => {
  await database?.destroy();
});

const setup = async () => {
  const { sut, ctx } = newMediumService(PersonRelationshipService, {
    database,
    real: [
      AccessRepository,
      AssetRepository,
      ConfigRepository,
      CryptoRepository,
      DatabaseRepository,
      PartnerOriginRepository,
      PersonRepository,
      SearchRepository,
      SystemMetadataRepository,
    ],
    mock: [EventRepository, JobRepository, LoggingRepository, StorageRepository],
  });
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  ctx.getMock(JobRepository).queue.mockResolvedValue();
  ctx.getMock(JobRepository).queueAll.mockResolvedValue();
  ctx.getMock(StorageRepository).unlink.mockResolvedValue();
  const { user } = await ctx.newUser();
  const person = async (ownerId: string, name: string) =>
    (await ctx.newPerson({ ownerId, name })).person.personGroupId!;
  return { sut, ctx, user, auth: factory.auth({ user }), person, people: ctx.get(PersonRepository) };
};

describe('person relationships (FL-842)', () => {
  it('stores a pair once, whichever way it is asked for', async () => {
    const { sut, auth, user, person, people } = await setup();
    const [alex, sam] = [await person(user.id, 'Alex'), await person(user.id, 'Sam')];

    await sut.create(auth, alex, { relatedPersonId: sam, relation: 'partner' });
    await expect(sut.create(auth, sam, { relatedPersonId: alex, relation: 'partner' })).rejects.toThrow('already');

    await expect(people.getRelationships(user.id)).resolves.toHaveLength(1);
  });

  it('refuses a self-link and an unordered partner row in the database itself', async () => {
    const { ctx, user, person } = await setup();
    const [alex, sam] = [await person(user.id, 'Alex'), await person(user.id, 'Sam')].toSorted();
    const insert = (personGroupId: string, relatedPersonGroupId: string) =>
      ctx.database
        .insertInto('person_relationship')
        .values({ ownerId: user.id, personGroupId, relatedPersonGroupId, kind: 'partner', parentRole: null })
        .execute();

    await expect(insert(alex, alex)).rejects.toThrow();
    await expect(insert(sam, alex)).rejects.toThrow();
  });

  it('removes the relationship when a person is deleted', async () => {
    const { sut, auth, user, person, people } = await setup();
    const [alex, mum] = [await person(user.id, 'Alex'), await person(user.id, 'Mum')];
    await sut.create(auth, alex, { relatedPersonId: mum, relation: 'mother' });

    await people.delete([mum], user.id);

    await expect(people.getRelationships(user.id)).resolves.toEqual([]);
  });

  it('keeps the union of relationships through a real merge', async () => {
    const { sut, auth, user, person, people } = await setup();
    const [kept, merged, mum, child] = [
      await person(user.id, 'Alex'),
      await person(user.id, 'Alex B'),
      await person(user.id, 'Mum'),
      await person(user.id, 'Child'),
    ];
    await sut.create(auth, merged, { relatedPersonId: mum, relation: 'mother' });
    await sut.create(auth, kept, { relatedPersonId: child, relation: 'child' });
    await sut.create(auth, kept, { relatedPersonId: merged, relation: 'sibling' });

    const results = await BaseService.create(PersonService, sut).mergePeople(auth, { ids: [kept, merged] });

    expect(results).toEqual([expect.objectContaining({ id: merged, success: true })]);
    const family = await sut.get(auth, kept);
    expect(family.parents.map(({ person }) => person.id)).toEqual([mum]);
    expect(family.children.map(({ person }) => person.id)).toEqual([child]);
    expect(family.siblings).toEqual([]);
    await expect(people.getRelationships(user.id)).resolves.toHaveLength(2);
  });

  describe('partner copies', () => {
    const copied = async (context: Awaited<ReturnType<typeof setup>>) => {
      const { ctx, user: alice, person } = context;
      const { user: bob } = await ctx.newUser();
      const [mum, child] = [await person(alice.id, 'Mum'), await person(alice.id, 'Child')];
      const copy = async (sourcePersonGroupId: string, name: string) => {
        const result = await ctx.get(PartnerOriginRepository).createPersonCopy({
          ownerId: bob.id,
          sourceOwnerId: alice.id,
          sourcePersonGroupId,
          rootOwnerId: alice.id,
          partnerSharedById: alice.id,
          name,
          birthDate: null,
          isHidden: false,
        });
        if ('conflict' in result) {
          throw new Error(result.conflict);
        }
        return result.personGroupId;
      };
      return { alice, bob, mum, child, mumCopy: await copy(mum, 'Mum'), childCopy: await copy(child, 'Child') };
    };

    it('gives the recipient the relationship between copied people and follows a removal', async () => {
      const context = await setup();
      const { sut, auth, people } = context;
      const { bob, mum, child, mumCopy, childCopy } = await copied(context);

      await sut.create(auth, child, { relatedPersonId: mum, relation: 'mother' });
      await expect(people.getRelationships(bob.id)).resolves.toEqual([
        { personGroupId: mumCopy, relatedPersonGroupId: childCopy, kind: 'parent', parentRole: 'mother' },
      ]);

      await sut.remove(auth, child, mum);
      await expect(people.getRelationships(bob.id)).resolves.toEqual([]);
    });

    it('stops following once the recipient edits the relationship', async () => {
      const context = await setup();
      const { sut, auth, people } = context;
      const { bob, mum, child, mumCopy, childCopy } = await copied(context);
      await sut.create(auth, child, { relatedPersonId: mum, relation: 'mother' });
      const bobAuth = factory.auth({ user: bob });
      await sut.remove(bobAuth, childCopy, mumCopy);
      await sut.create(bobAuth, childCopy, { relatedPersonId: mumCopy, relation: 'parent' });

      await sut.remove(auth, child, mum);

      await expect(people.getRelationships(bob.id)).resolves.toEqual([
        { personGroupId: mumCopy, relatedPersonGroupId: childCopy, kind: 'parent', parentRole: 'parent' },
      ]);
    });
  });
});
