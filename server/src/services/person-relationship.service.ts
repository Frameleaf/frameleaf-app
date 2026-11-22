import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import {
  PersonRelationshipCreateDto,
  PersonRelationshipsResponseDto,
  PersonRelativeDto,
  mapPersonRelative,
} from 'src/dtos/person.dto.js';
import { Permission } from 'src/enum.js';
import { BaseService } from 'src/services/base.service.js';
import { PartnerPeopleService } from 'src/services/partner-people.service.js';
import { requireEntityAccess } from 'src/utils/access.js';
import {
  type PersonRelationshipEdge,
  type PersonRelationshipRefusal,
  groupRelationships,
  mergedRelationships,
  refuseRelationship,
  relationshipBetween,
  relationshipEdge,
} from 'src/utils/person-relationship.js';

type Named = { personGroupId: string; name: string };

const nameOf = (person: Named | undefined) => person?.name.trim() || 'This person';

/**
 * Why a relationship is refused, in the words the Family section shows (FL-816 mock). `parent` and `child` are
 * the two ends of a parent relationship; for the others they are simply the two people.
 */
const refusalMessage = (
  reason: PersonRelationshipRefusal,
  edges: PersonRelationshipEdge[],
  edge: PersonRelationshipEdge,
  people: Map<string, Named>,
): string => {
  const person = nameOf(people.get(edge.personGroupId));
  const related = nameOf(people.get(edge.relatedPersonGroupId));
  switch (reason) {
    case 'same-person': {
      return `${person} can't be related to themselves.`;
    }
    case 'duplicate': {
      return edge.kind === 'parent'
        ? `${person} is already ${related}'s parent.`
        : `${related} is already ${person}'s ${edge.kind}.`;
    }
    case 'inverse-parent': {
      return `${related} is already ${person}'s parent, so ${related} can't also be ${person}'s child. Remove that relationship first if it is wrong.`;
    }
    case 'other-relationship': {
      const existing = relationshipBetween(edges, edge.personGroupId, edge.relatedPersonGroupId);
      if (existing?.kind === 'parent') {
        const parent = nameOf(people.get(existing.personGroupId));
        const child = nameOf(people.get(existing.relatedPersonGroupId));
        return `${parent} is already ${child}'s parent, so they can't also be ${edge.kind}s. Remove that relationship first if it is wrong.`;
      }
      return `${related} is already ${person}'s ${existing?.kind ?? 'relative'}. Remove that relationship first if it is wrong.`;
    }
    case 'cycle': {
      return `${person} is descended from ${related}, so ${person} can't also be ${related}'s parent.`;
    }
    case 'mother-exists': {
      return `${related} already has a mother. Remove that relationship first if it is wrong.`;
    }
    case 'father-exists': {
      return `${related} already has a father. Remove that relationship first if it is wrong.`;
    }
    case 'two-parents': {
      return `${related} already has two parents. Remove one first.`;
    }
  }
};

/**
 * FL-842: how an owner's people are related (parents, children, partners, siblings). Everything here is the
 * caller's own: a relationship joins two of the caller's people, only they can read or change it, and a partner
 * receives a copy only between people copied to them (`PartnerPeopleService`).
 */
@Injectable()
export class PersonRelationshipService extends BaseService {
  async get(auth: AuthDto, personGroupId: string): Promise<PersonRelationshipsResponseDto> {
    await this.requirePerson(auth, Permission.PersonRead, personGroupId);
    return this.forPerson(auth, personGroupId);
  }

  /**
   * Records "`relatedPersonId` is this person's <relation>". Refused, with nothing changed, when it would relate a
   * person to themselves, repeat or contradict what is recorded for the pair, make someone their own ancestor, or
   * give a person a second mother, a second father or a third parent.
   */
  async create(
    auth: AuthDto,
    personGroupId: string,
    dto: PersonRelationshipCreateDto,
  ): Promise<PersonRelationshipsResponseDto> {
    await this.requirePerson(auth, Permission.PersonUpdate, personGroupId);
    const ownerId = auth.user.id;
    const edge = relationshipEdge(personGroupId, dto.relatedPersonId, dto.relation);
    if (personGroupId !== dto.relatedPersonId) {
      await this.requireOwnRelative(auth, dto.relatedPersonId);
    }
    const [edges, people] = await Promise.all([
      this.personRepository.getRelationships(ownerId),
      this.personRepository.getOwnPeople(ownerId, [personGroupId, dto.relatedPersonId]),
    ]);
    const reason = refuseRelationship(edges, edge);
    if (reason) {
      const named = new Map(people.map((person) => [person.personGroupId, person]));
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        message: refusalMessage(reason, edges, edge, named),
        reason,
      });
    }
    await this.personRepository.createRelationships(ownerId, [edge]);
    await this.afterEdit(ownerId, personGroupId, dto.relatedPersonId);
    return this.forPerson(auth, personGroupId);
  }

  /** Removes whatever relationship is recorded between the two people. Their photos are not touched. */
  async remove(auth: AuthDto, personGroupId: string, relatedPersonId: string): Promise<void> {
    await this.requirePerson(auth, Permission.PersonUpdate, personGroupId);
    if (personGroupId === relatedPersonId) {
      throw new BadRequestException("A person can't be related to themselves");
    }
    await this.requireOwnRelative(auth, relatedPersonId);
    if (!(await this.personRepository.deleteRelationship(auth.user.id, personGroupId, relatedPersonId))) {
      throw new NotFoundException('Relationship not found');
    }
    await this.afterEdit(auth.user.id, personGroupId, relatedPersonId);
  }

  /**
   * A merge keeps the union of both people's relationships: the person who stays gains the merged-away person's,
   * before that person (and their rows) is deleted. Runs inside the merge's write.
   */
  async onMerge(ownerId: string, fromPersonGroupId: string, toPersonGroupId: string): Promise<void> {
    const edges = await this.personRepository.getRelationships(ownerId);
    await this.personRepository.createRelationships(
      ownerId,
      mergedRelationships(edges, fromPersonGroupId, toPersonGroupId),
    );
  }

  /**
   * A person's family as the caller may see it. The person is the caller's own (checked by the caller of this);
   * a relative the session may not see (suppressed while it is not unlocked) is left out like any other read.
   */
  async forPerson(auth: AuthDto, personGroupId: string): Promise<PersonRelationshipsResponseDto> {
    const ownerId = auth.user.id;
    const groups = groupRelationships(await this.personRepository.getRelationships(ownerId), personGroupId);
    const ids = [
      ...groups.parents.map((parent) => parent.personId),
      ...groups.children.map((child) => child.personId),
      ...groups.partners,
      ...groups.siblings,
    ];
    const relatives = new Map<string, PersonRelativeDto>();
    if (ids.length > 0) {
      const allowed = await this.checkAccess({ auth, permission: Permission.PersonRead, ids });
      for (const person of await this.personRepository.getOwnPeople(ownerId, ids)) {
        if (allowed.has(person.personGroupId)) {
          relatives.set(person.personGroupId, mapPersonRelative(person));
        }
      }
    }
    const withRole = (entries: Array<{ personId: string; parentRole: string }>) =>
      entries.flatMap(({ personId, parentRole }) => {
        const person = relatives.get(personId);
        return person ? [{ person, parentRole }] : [];
      });
    const listed = (personIds: string[]) =>
      personIds.flatMap((personId) => {
        const person = relatives.get(personId);
        return person ? [person] : [];
      });
    return {
      parents: withRole(groups.parents),
      children: withRole(groups.children),
      partners: listed(groups.partners),
      siblings: listed(groups.siblings),
      inferredSiblingIds: groups.inferredSiblingIds.filter((id) => relatives.has(id)),
    };
  }

  /**
   * The access check for the person a route names (as `PersonService.requirePerson`): a missing person, someone
   * else's and one the session suppresses all answer the same 404.
   */
  private requirePerson(auth: AuthDto, permission: Permission, personGroupId: string) {
    return requireEntityAccess(this.accessRepository, { auth, permission, ids: [personGroupId] }, 'Person');
  }

  /** The other person must be the caller's own too, and one this session may see. */
  private async requireOwnRelative(auth: AuthDto, personGroupId: string) {
    const allowed = await this.checkAccess({ auth, permission: Permission.PersonUpdate, ids: [personGroupId] });
    const person = allowed.has(personGroupId)
      ? await this.personRepository.getByGroupId({ ownerId: auth.user.id, personGroupId })
      : undefined;
    if (!person) {
      throw new BadRequestException('Both people must be your own people');
    }
  }

  /**
   * FL-326 for relationships: an edit of a partner's person copy stops that copy's relationships following the
   * partner, and the people's own copies follow the change.
   */
  private async afterEdit(ownerId: string, personGroupId: string, relatedPersonGroupId: string) {
    const partnerPeople = BaseService.create(PartnerPeopleService, this);
    await partnerPeople.noteRelationshipEdit(ownerId, [personGroupId, relatedPersonGroupId]);
    await partnerPeople.propagateRelationships(ownerId, personGroupId);
  }
}
