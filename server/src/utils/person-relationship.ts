/**
 * FL-842: the rules for how an owner's people are related, kept free of the database so the service, a merge and
 * a partner copy all apply the same ones.
 *
 * An edge is stored once per pair. `parent`: `personGroupId` is the parent of `relatedPersonGroupId`.
 * `partner` and `sibling` have no direction and are stored smaller id first.
 */
export type PersonRelationshipEdge = {
  personGroupId: string;
  relatedPersonGroupId: string;
  kind: string;
  parentRole: string | null;
};

/** How the related person is related to the person asked about: "the related person is their mother". */
export const PERSON_RELATIONS = ['mother', 'father', 'parent', 'child', 'partner', 'sibling'] as const;
export type PersonRelation = (typeof PERSON_RELATIONS)[number];

/** Why a relationship is refused. Sent with the refusal so a client can say it in its own words. */
export type PersonRelationshipRefusal =
  | 'same-person'
  | 'duplicate'
  | 'inverse-parent'
  | 'other-relationship'
  | 'cycle'
  | 'mother-exists'
  | 'father-exists'
  | 'two-parents';

/** More generations than any family tree holds; a walk that gets this far stops rather than run on. */
export const MAX_GENERATIONS = 64;

const symmetric = (personA: string, personB: string, kind: string): PersonRelationshipEdge =>
  personA < personB
    ? { personGroupId: personA, relatedPersonGroupId: personB, kind, parentRole: null }
    : { personGroupId: personB, relatedPersonGroupId: personA, kind, parentRole: null };

/** The edge to store for "`relatedId` is `personId`'s <relation>". */
export const relationshipEdge = (
  personId: string,
  relatedId: string,
  relation: PersonRelation,
): PersonRelationshipEdge => {
  switch (relation) {
    case 'mother':
    case 'father':
    case 'parent': {
      return { personGroupId: relatedId, relatedPersonGroupId: personId, kind: 'parent', parentRole: relation };
    }
    case 'child': {
      return { personGroupId: personId, relatedPersonGroupId: relatedId, kind: 'parent', parentRole: 'parent' };
    }
    default: {
      return symmetric(personId, relatedId, relation);
    }
  }
};

const joins = (edge: PersonRelationshipEdge, personA: string, personB: string) =>
  (edge.personGroupId === personA && edge.relatedPersonGroupId === personB) ||
  (edge.personGroupId === personB && edge.relatedPersonGroupId === personA);

/** The stored edge between two people, whichever way round it is. */
export const relationshipBetween = (edges: PersonRelationshipEdge[], personA: string, personB: string) =>
  edges.find((edge) => joins(edge, personA, personB));

export const sameRelationship = (a: PersonRelationshipEdge | undefined, b: PersonRelationshipEdge | undefined) =>
  !!a &&
  !!b &&
  a.personGroupId === b.personGroupId &&
  a.relatedPersonGroupId === b.relatedPersonGroupId &&
  a.kind === b.kind &&
  a.parentRole === b.parentRole;

/** Whether `ancestorId` is a parent, grandparent … of `personId`. */
export const isAncestor = (edges: PersonRelationshipEdge[], ancestorId: string, personId: string): boolean => {
  const seen = new Set<string>([personId]);
  let generation = [personId];
  for (let depth = 0; depth < MAX_GENERATIONS && generation.length > 0; depth++) {
    const parents: string[] = [];
    for (const edge of edges) {
      if (edge.kind !== 'parent' || !generation.includes(edge.relatedPersonGroupId) || seen.has(edge.personGroupId)) {
        continue;
      }
      if (edge.personGroupId === ancestorId) {
        return true;
      }
      seen.add(edge.personGroupId);
      parents.push(edge.personGroupId);
    }
    generation = parents;
  }
  // deeper than any real family: refuse rather than risk a loop
  return generation.length > 0;
};

/** Why `edge` cannot be added to `edges`, or undefined when it can. */
export const refuseRelationship = (
  edges: PersonRelationshipEdge[],
  edge: PersonRelationshipEdge,
): PersonRelationshipRefusal | undefined => {
  const { personGroupId, relatedPersonGroupId, kind } = edge;
  if (personGroupId === relatedPersonGroupId) {
    return 'same-person';
  }
  const existing = relationshipBetween(edges, personGroupId, relatedPersonGroupId);
  if (existing) {
    if (existing.kind !== kind) {
      return 'other-relationship';
    }
    return kind === 'parent' && existing.personGroupId !== personGroupId ? 'inverse-parent' : 'duplicate';
  }
  if (kind !== 'parent') {
    return;
  }
  if (isAncestor(edges, relatedPersonGroupId, personGroupId)) {
    return 'cycle';
  }
  const parents = edges.filter((other) => other.kind === 'parent' && other.relatedPersonGroupId === relatedPersonGroupId);
  if (edge.parentRole === 'mother' && parents.some((other) => other.parentRole === 'mother')) {
    return 'mother-exists';
  }
  if (edge.parentRole === 'father' && parents.some((other) => other.parentRole === 'father')) {
    return 'father-exists';
  }
  if (parents.length >= 2) {
    return 'two-parents';
  }
};

export type PersonRelationshipGroups = {
  parents: Array<{ personId: string; parentRole: string }>;
  children: Array<{ personId: string; parentRole: string }>;
  partners: string[];
  siblings: string[];
  /** The siblings listed only because they share a parent: there is no stored relationship to remove. */
  inferredSiblingIds: string[];
};

/** A person's relatives, grouped. Siblings are the stored ones plus everyone who shares a parent. */
export const groupRelationships = (edges: PersonRelationshipEdge[], personId: string): PersonRelationshipGroups => {
  const groups: PersonRelationshipGroups = {
    parents: [],
    children: [],
    partners: [],
    siblings: [],
    inferredSiblingIds: [],
  };
  for (const edge of edges) {
    const other =
      edge.personGroupId === personId
        ? edge.relatedPersonGroupId
        : edge.relatedPersonGroupId === personId
          ? edge.personGroupId
          : undefined;
    if (!other) {
      continue;
    }
    if (edge.kind === 'parent') {
      const entry = { personId: other, parentRole: edge.parentRole ?? 'parent' };
      (edge.relatedPersonGroupId === personId ? groups.parents : groups.children).push(entry);
    } else if (edge.kind === 'partner') {
      groups.partners.push(other);
    } else if (edge.kind === 'sibling') {
      groups.siblings.push(other);
    }
  }
  const parentIds = new Set(groups.parents.map((parent) => parent.personId));
  const related = new Set([
    personId,
    ...groups.siblings,
    ...groups.partners,
    ...parentIds,
    ...groups.children.map((child) => child.personId),
  ]);
  for (const edge of edges) {
    if (edge.kind === 'parent' && parentIds.has(edge.personGroupId) && !related.has(edge.relatedPersonGroupId)) {
      related.add(edge.relatedPersonGroupId);
      groups.siblings.push(edge.relatedPersonGroupId);
      groups.inferredSiblingIds.push(edge.relatedPersonGroupId);
    }
  }
  return groups;
};

/** The same edge between other people (a merge's survivor, a partner's copies), in stored order. */
export const mapRelationship = (
  edge: PersonRelationshipEdge,
  personOf: (personGroupId: string) => string,
): PersonRelationshipEdge => {
  const personGroupId = personOf(edge.personGroupId);
  const relatedPersonGroupId = personOf(edge.relatedPersonGroupId);
  return edge.kind === 'parent'
    ? { personGroupId, relatedPersonGroupId, kind: edge.kind, parentRole: edge.parentRole }
    : symmetric(personGroupId, relatedPersonGroupId, edge.kind);
};

/**
 * A merge keeps the union of both people's relationships: the edges of the merged-away person (`fromId`) that
 * the person who stays (`toId`) gains. An edge between the two would join the survivor to themselves and one the
 * survivor already has would be a duplicate, so both are left out, as is anything the rules refuse (a second
 * mother, a loop).
 */
export const mergedRelationships = (
  edges: PersonRelationshipEdge[],
  fromId: string,
  toId: string,
): PersonRelationshipEdge[] => {
  const kept = edges.filter((edge) => edge.personGroupId !== fromId && edge.relatedPersonGroupId !== fromId);
  const gained: PersonRelationshipEdge[] = [];
  for (const edge of edges) {
    if (edge.personGroupId !== fromId && edge.relatedPersonGroupId !== fromId) {
      continue;
    }
    const moved = mapRelationship(edge, (id) => (id === fromId ? toId : id));
    if (refuseRelationship([...kept, ...gained], moved)) {
      continue;
    }
    gained.push(moved);
  }
  return gained;
};
