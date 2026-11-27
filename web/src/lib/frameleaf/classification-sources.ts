import {
  getAllPeople,
  getAllTags,
  getClassificationSettings,
  type ClassificationSettingsDto,
  type PersonResponseDto,
  type TagResponseDto,
} from '@frameleaf/sdk';
import { readEveryPage } from '$lib/frameleaf/all-people';

/** The owner's named people and tags a rule can choose from, and the server's rule settings (FL-60). */
export type RuleSources = {
  people: PersonResponseDto[];
  tags: TagResponseDto[];
  settings?: ClassificationSettingsDto;
};

export const loadRuleSources = async (): Promise<RuleSources> => {
  const [people, tags, settings] = await Promise.allSettled([
    // FL-1803: every page, so a rule can name anyone. ponytail: the full person rows, because the rule
    // components take them; the picker list (`getPeoplePicker`) once they take its smaller shape.
    readEveryPage((page) => getAllPeople({ withHidden: false, page, size: 1000 })),
    getAllTags(),
    getClassificationSettings(),
  ]);
  return {
    people: people.status === 'fulfilled' ? people.value.filter((person) => person.name) : [],
    tags: tags.status === 'fulfilled' ? [...tags.value].sort((a, b) => a.value.localeCompare(b.value)) : [],
    settings: settings.status === 'fulfilled' ? settings.value : undefined,
  };
};
