import { BadRequestException, NotFoundException } from '@nestjs/common';
import { BaseService } from 'src/services/base.service.js';
import { PartnerPeopleService } from 'src/services/partner-people.service.js';
import { PersonRelationshipService } from 'src/services/person-relationship.service.js';
import {
  type PersonRelationshipEdge,
  groupRelationships,
  mergedRelationships,
  refuseRelationship,
  relationshipEdge,
} from 'src/utils/person-relationship.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { PersonFactory } from 'test/factories/person.factory.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const [a, b, c, d] = [
  '00000000-0000-4000-a000-00000000000a',
  '00000000-0000-4000-a000-00000000000b',
  '00000000-0000-4000-a000-00000000000c',
  '00000000-0000-4000-a000-00000000000d',
];
const parent = (parentId: string, childId: string, parentRole = 'parent'): PersonRelationshipEdge => ({
  personGroupId: parentId,
  relatedPersonGroupId: childId,
  kind: 'parent',
  parentRole,
});

describe('person relationship rules', () => {
  it('stores "b is a\'s mother" with the parent first, and "child" the other way round', () => {
    expect(relationshipEdge(a, b, 'mother')).toEqual(parent(b, a, 'mother'));
    expect(relationshipEdge(a, b, 'child')).toEqual(parent(a, b));
  });

  it('stores partners and siblings smaller id first, whichever way they are asked for', () => {
    expect(relationshipEdge(b, a, 'partner')).toEqual(relationshipEdge(a, b, 'partner'));
    expect(relationshipEdge(b, a, 'sibling').personGroupId).toBe(a);
  });

  it('shows a parent from both ends', () => {
    const edges = [parent(a, b, 'mother')];
    expect(groupRelationships(edges, a).children).toEqual([{ personId: b, parentRole: 'mother' }]);
    expect(groupRelationships(edges, b).parents).toEqual([{ personId: a, parentRole: 'mother' }]);
  });

  it('adds people who share a parent as siblings, once, and says they are inferred', () => {
    const edges = [parent(a, b), parent(a, c), relationshipEdge(b, d, 'sibling')];
    const groups = groupRelationships(edges, b);
    expect(groups.siblings.toSorted()).toEqual([c, d]);
    expect(groups.inferredSiblingIds).toEqual([c]);
  });

  it('does not repeat a recorded sibling who also shares a parent', () => {
    const groups = groupRelationships([parent(a, b), parent(a, c), relationshipEdge(b, c, 'sibling')], b);
    expect(groups.siblings).toEqual([c]);
    expect(groups.inferredSiblingIds).toEqual([]);
  });

  it('refuses a loop at any depth', () => {
    expect(refuseRelationship([parent(a, b), parent(b, c)], parent(c, a))).toBe('cycle');
    expect(refuseRelationship([parent(a, b)], parent(b, a))).toBe('inverse-parent');
  });

  it('refuses a second mother, a second father and a third parent', () => {
    expect(refuseRelationship([parent(a, c, 'mother')], parent(b, c, 'mother'))).toBe('mother-exists');
    expect(refuseRelationship([parent(a, c, 'father')], parent(b, c, 'father'))).toBe('father-exists');
    expect(refuseRelationship([parent(a, c, 'mother'), parent(b, c, 'father')], parent(d, c))).toBe('two-parents');
  });

  it('refuses a parent who is also a partner or sibling, and a duplicate', () => {
    expect(refuseRelationship([parent(a, b)], relationshipEdge(a, b, 'partner'))).toBe('other-relationship');
    expect(refuseRelationship([relationshipEdge(a, b, 'sibling')], parent(a, b))).toBe('other-relationship');
    expect(refuseRelationship([relationshipEdge(a, b, 'partner')], relationshipEdge(b, a, 'partner'))).toBe(
      'duplicate',
    );
  });

  describe('merge', () => {
    it('gives the person who stays the union of relationships', () => {
      expect(mergedRelationships([parent(c, a, 'mother'), parent(b, d)], a, b)).toEqual([parent(c, b, 'mother')]);
    });

    it('drops what would link the survivor to themselves or repeat what they have', () => {
      const edges = [parent(a, b), relationshipEdge(a, c, 'partner'), relationshipEdge(b, c, 'partner')];
      expect(mergedRelationships(edges, a, b)).toEqual([]);
    });

    it('drops what the rules refuse, such as a second mother', () => {
      expect(mergedRelationships([parent(c, a, 'mother'), parent(d, b, 'mother')], a, b)).toEqual([]);
    });
  });
});

describe(PersonRelationshipService.name, () => {
  let sut: PersonRelationshipService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(PersonRelationshipService));
  });

  const own = (auth: ReturnType<typeof AuthFactory.create>, ...names: string[]) => {
    const people = names.map((name) => PersonFactory.create({ ownerId: auth.user.id, name }));
    const ownIds = new Set(people.map((person) => person.personGroupId));
    mocks.access.person.checkOwnerAccess.mockImplementation((_userId, ids) =>
      Promise.resolve(new Set([...ids].filter((id) => ownIds.has(id)))),
    );
    mocks.person.getByGroupId.mockImplementation(({ personGroupId }) =>
      Promise.resolve(people.find((person) => person.personGroupId === personGroupId)),
    );
    mocks.person.getOwnPeople.mockImplementation((_owner, ids) =>
      Promise.resolve(people.filter((person) => ids.includes(person.personGroupId))),
    );
    return people;
  };

  it("answers 404 for someone else's person, on read and on edit", async () => {
    const auth = AuthFactory.create();
    mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set());
    await expect(sut.get(auth, newUuid())).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      sut.create(auth, newUuid(), { relatedPersonId: newUuid(), relation: 'sibling' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(sut.remove(auth, newUuid(), newUuid())).rejects.toBeInstanceOf(NotFoundException);
    expect(mocks.person.createRelationships).not.toHaveBeenCalled();
    expect(mocks.person.deleteRelationship).not.toHaveBeenCalled();
  });

  it("refuses a related person who is not the caller's", async () => {
    const auth = AuthFactory.create();
    const [alex] = own(auth, 'Alex');
    await expect(
      sut.create(auth, alex.personGroupId, { relatedPersonId: newUuid(), relation: 'sibling' }),
    ).rejects.toThrow('Both people must be your own people');
    expect(mocks.person.createRelationships).not.toHaveBeenCalled();
  });

  it('records a parent and returns the family', async () => {
    const auth = AuthFactory.create();
    const [alex, mum] = own(auth, 'Alex', 'Mum');
    const edge = parent(mum.personGroupId, alex.personGroupId, 'mother');
    mocks.person.getRelationships.mockResolvedValueOnce([]).mockResolvedValue([edge]);

    const family = await sut.create(auth, alex.personGroupId, {
      relatedPersonId: mum.personGroupId,
      relation: 'mother',
    });

    expect(mocks.person.createRelationships).toHaveBeenCalledWith(auth.user.id, [edge]);
    expect(family.parents).toEqual([
      { person: expect.objectContaining({ id: mum.personGroupId, name: 'Mum' }), parentRole: 'mother' },
    ]);
    expect(mocks.partnerOrigin.markPersonOverridden).toHaveBeenCalledWith(
      auth.user.id,
      [alex.personGroupId, mum.personGroupId],
      ['relationships'],
    );
  });

  it('refuses a loop in the words of the mock, changing nothing', async () => {
    const auth = AuthFactory.create();
    const [emma, margaret] = own(auth, 'Emma', 'Margaret');
    mocks.person.getRelationships.mockResolvedValue([parent(margaret.personGroupId, c), parent(c, emma.personGroupId)]);

    const error = await sut
      .create(auth, margaret.personGroupId, { relatedPersonId: emma.personGroupId, relation: 'parent' })
      .catch((error_) => error_);

    expect(error).toBeInstanceOf(BadRequestException);
    expect(error.getResponse()).toMatchObject({
      message: "Emma is descended from Margaret, so Emma can't also be Margaret's parent.",
      reason: 'cycle',
    });
    expect(mocks.person.createRelationships).not.toHaveBeenCalled();
  });

  it('leaves out a relative this session may not see', async () => {
    const auth = AuthFactory.create();
    const [alex, hidden] = own(auth, 'Alex', 'Hidden');
    mocks.person.getRelationships.mockResolvedValue([parent(hidden.personGroupId, alex.personGroupId)]);
    mocks.access.person.checkOwnerAccess
      .mockResolvedValueOnce(new Set([alex.personGroupId]))
      .mockResolvedValueOnce(new Set());

    await expect(sut.get(auth, alex.personGroupId)).resolves.toMatchObject({ parents: [] });
  });

  it('answers 404 when there is nothing to remove', async () => {
    const auth = AuthFactory.create();
    const [alex, sam] = own(auth, 'Alex', 'Sam');
    mocks.person.deleteRelationship.mockResolvedValue(false);
    await expect(sut.remove(auth, alex.personGroupId, sam.personGroupId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('on a merge, adds the union and stops a copy following', async () => {
    const owner = newUuid();
    mocks.person.getRelationships.mockResolvedValue([parent(c, a, 'mother')]);

    await expect(sut.onMerge(owner, a, b)).resolves.toBe(true);

    expect(mocks.person.createRelationships).toHaveBeenCalledWith(owner, [parent(c, b, 'mother')]);
    expect(mocks.partnerOrigin.markPersonOverridden).toHaveBeenCalledWith(owner, [b], ['relationships']);
  });

  describe('partner copies', () => {
    const origin = (
      ownerId: string,
      sourceOwnerId: string,
      personGroupId: string,
      source: string,
      overridden = false,
    ) => ({
      ownerId,
      personGroupId,
      sourceOwnerId,
      sourcePersonGroupId: source,
      rootOwnerId: sourceOwnerId,
      partnerSharedById: sourceOwnerId,
      overriddenFields: overridden ? ['relationships'] : [],
      following: true,
    });

    const setup = (overridden = false) => {
      const partnerPeople = BaseService.create(PartnerPeopleService, sut);
      const [alice, bob] = [newUuid(), newUuid()];
      const [mumCopy, childCopy] = [c, d];
      const copies = [origin(bob, alice, mumCopy, a, overridden), origin(bob, alice, childCopy, b)];
      mocks.partnerOrigin.getPersonFollowers.mockImplementation((owner, group) =>
        Promise.resolve(owner === alice ? copies.filter((copy) => copy.sourcePersonGroupId === group) : []),
      );
      mocks.partnerOrigin.getPersonCopies.mockResolvedValue(copies);
      return { partnerPeople, alice, bob, mumCopy, childCopy };
    };

    it('gives the recipient the relationship between two copied people', async () => {
      const { partnerPeople, alice, bob, mumCopy, childCopy } = setup();
      mocks.person.getRelationships.mockImplementation((owner) =>
        Promise.resolve(owner === alice ? [parent(a, b, 'mother')] : []),
      );

      await partnerPeople.propagateRelationships(alice, a);

      expect(mocks.person.createRelationships).toHaveBeenCalledWith(bob, [parent(mumCopy, childCopy, 'mother')]);
    });

    it('removes it from the recipient when the partner removes it', async () => {
      const { partnerPeople, alice, bob, mumCopy, childCopy } = setup();
      mocks.person.getRelationships.mockImplementation((owner) =>
        Promise.resolve(owner === bob ? [parent(mumCopy, childCopy, 'mother')] : []),
      );

      await partnerPeople.propagateRelationships(alice, a);

      expect(mocks.person.deleteRelationship).toHaveBeenCalledWith(bob, mumCopy, childCopy);
    });

    it('leaves a copy alone once the recipient has edited its relationships', async () => {
      const { partnerPeople, alice } = setup(true);
      mocks.person.getRelationships.mockImplementation((owner) =>
        Promise.resolve(owner === alice ? [parent(a, b, 'mother')] : []),
      );

      await partnerPeople.propagateRelationships(alice, a);

      expect(mocks.person.createRelationships).not.toHaveBeenCalled();
      expect(mocks.person.deleteRelationship).not.toHaveBeenCalled();
    });
  });
});
