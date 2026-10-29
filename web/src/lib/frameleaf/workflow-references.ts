import { getAllAlbums, getTagById, searchTags } from '@frameleaf/sdk';

/** The kinds of identifiers a workflow parameter can pick from (its schema's `uiHint.type`). */
export type WorkflowReferenceKind = 'TagId' | 'AlbumId';
export type WorkflowReference = { id: string; label: string };

/** How many matches a picker shows for what was typed. */
export const WORKFLOW_REFERENCE_RESULTS = 20;

export const isWorkflowReferenceKind = (value: unknown): value is WorkflowReferenceKind =>
  value === 'TagId' || value === 'AlbumId';

// Names already read on this page, so a saved workflow's choices are resolved once.
const names = new Map<string, string>();
const remember = (kind: WorkflowReferenceKind, items: WorkflowReference[]) => {
  for (const item of items) {
    names.set(`${kind}:${item.id}`, item.label);
  }
  return items;
};

/**
 * FL-647: the tags or albums whose name contains what was typed, read from the server a page at a
 * time instead of loading every tag and album when the designer opens.
 */
export const searchWorkflowReferences = async (
  kind: WorkflowReferenceKind,
  text: string,
  signal?: AbortSignal,
): Promise<WorkflowReference[]> => {
  const search = text.trim() || undefined;
  if (kind === 'TagId') {
    const tags = await searchTags({ search, take: WORKFLOW_REFERENCE_RESULTS }, { signal });
    return remember(
      kind,
      tags.map((tag) => ({ id: tag.id, label: tag.value })),
    );
  }
  const albums = await getAllAlbums({ search, take: WORKFLOW_REFERENCE_RESULTS }, { signal });
  return remember(
    kind,
    albums.map((album) => ({ id: album.id, label: album.albumName })),
  );
};

/** The names of chosen identifiers; one that cannot be read (deleted, not the caller's) is left out. */
export const resolveWorkflowReferences = async (
  kind: WorkflowReferenceKind,
  ids: readonly string[],
): Promise<WorkflowReference[]> => {
  const unknown = [...new Set(ids)].filter((id) => !names.has(`${kind}:${id}`));
  await Promise.all(
    unknown.map(async (id) => {
      try {
        if (kind === 'TagId') {
          const tag = await getTagById({ id });
          remember(kind, [{ id: tag.id, label: tag.value }]);
        } else {
          const [album] = await getAllAlbums({ id });
          if (album) {
            remember(kind, [{ id: album.id, label: album.albumName }]);
          }
        }
      } catch {
        // shown as an unavailable selection
      }
    }),
  );
  return ids.flatMap((id) => {
    const label = names.get(`${kind}:${id}`);
    return label === undefined ? [] : [{ id, label }];
  });
};

/** Tests: forget the names read so far. */
export const clearWorkflowReferenceNames = () => names.clear();
