import { Tag } from 'src/database.js';
import { TagRepository } from 'src/repositories/tag.repository.js';

type UpsertRequest = { userId: string; tags: string[] };

/** The value `upsertTags` stores for a tag path: empty segments dropped, so `a//b/` is `a/b`. */
export const normalizeTagValue = (tag: string) => tag.split('/').filter(Boolean).join('/');

export const upsertTags = async (repository: TagRepository, { userId, tags }: UpsertRequest) => {
  tags = [...new Set(tags)];

  const results: Tag[] = [];

  for (const tag of tags) {
    const parts = tag.split('/').filter(Boolean);
    let parent: Tag | undefined;

    for (const part of parts) {
      const value = parent ? `${parent.value}/${part}` : part;
      parent = await repository.upsertValue({ userId, value, parentId: parent?.id });
    }

    if (parent) {
      results.push(parent);
    }
  }

  return results;
};
