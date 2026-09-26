import { faker } from '@faker-js/faker';
import type { PeopleListItemDto, PersonResponseDto } from '@immich/sdk';
import { Sync } from 'factory.ts';

export const personFactory = Sync.makeFactory<PersonResponseDto>({
  birthDate: Sync.each(() => faker.date.past().toISOString()),
  id: Sync.each(() => faker.string.uuid()),
  isHidden: Sync.each(() => faker.datatype.boolean()),
  name: Sync.each(() => faker.person.fullName()),
  thumbnailPath: Sync.each(() => faker.system.filePath()),
  updatedAt: Sync.each(() => faker.date.recent().toISOString()),
});

/** A person as `GET /people` lists them, with the FL-37 per-person counts. */
export const peopleListItemFactory = Sync.makeFactory<PeopleListItemDto>({
  ...personFactory.build(),
  id: Sync.each(() => faker.string.uuid()),
  name: Sync.each(() => faker.person.fullName()),
  assetCount: Sync.each(() => faker.number.int({ min: 1, max: 50 })),
  lastSeenAt: Sync.each(() => faker.date.past().toISOString()),
});
