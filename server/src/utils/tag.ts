import { Tag } from 'src/database.js';
import { TagRepository } from 'src/repositories/tag.repository.js';

type UpsertRequest = { userId: string; tags: string[] };

/** The value `upsertTags` stores for a tag path: empty segments dropped, so `a//b/` is `a/b`. */
export const normalizeTagValue = (tag: string) => tag.split('/').filter(Boolean).join('/');

export const upsertTags = async (repository: Pick<TagRepository, 'upsertValue'>, { userId, tags }: UpsertRequest) => {
  const results: Tag[] = [];
  const paths = new Map<string, Tag>();

  for (const tag of new Set(tags)) {
    const parts = tag.split('/').filter(Boolean);
    let parent: Tag | undefined;

    for (const part of parts) {
      const value = parent ? `${parent.value}/${part}` : part;
      const existing = paths.get(value);
      parent = existing ?? (await repository.upsertValue({ userId, value, parentId: parent?.id }));
      if (!existing) {
        paths.set(value, parent);
      }
    }

    if (parent) {
      results.push(parent);
    }
  }

  return results;
};
