import {
  getAllPeople,
  getAllTags,
  getClassificationSettings,
  type ClassificationSettingsDto,
  type PersonResponseDto,
  type TagResponseDto,
} from '@immich/sdk';

/** The owner's named people and tags a rule can choose from, and the server's rule settings (FL-60). */
export type RuleSources = {
  people: PersonResponseDto[];
  tags: TagResponseDto[];
  settings?: ClassificationSettingsDto;
};

export const loadRuleSources = async (): Promise<RuleSources> => {
  const [people, tags, settings] = await Promise.allSettled([
    getAllPeople({ withHidden: false, size: 500 }),
    getAllTags(),
    getClassificationSettings(),
  ]);
  return {
    people: people.status === 'fulfilled' ? people.value.people.filter((person) => person.name) : [],
    tags: tags.status === 'fulfilled' ? [...tags.value].sort((a, b) => a.value.localeCompare(b.value)) : [],
    settings: settings.status === 'fulfilled' ? settings.value : undefined,
  };
};
