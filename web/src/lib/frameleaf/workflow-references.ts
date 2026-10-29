import { getAllAlbums, getTagById, searchTags } from '@frameleaf/sdk';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';

/** The kinds of identifiers a workflow parameter can pick from (its schema's `uiHint.type`). */
export type WorkflowReferenceKind = 'TagId' | 'AlbumId';
export type WorkflowReference = { id: string; label: string };

/** How many matches a picker shows for what was typed. */
export const WORKFLOW_REFERENCE_RESULTS = 20;

export const isWorkflowReferenceKind = (value: unknown): value is WorkflowReferenceKind =>
  value === 'TagId' || value === 'AlbumId';

// Names already read on this page, so a saved workflow's choices are resolved once. They are kept per
// account: a lookup is filed under the account that started it, so a response that lands after a
// sign-out or account switch can never answer the next account. A session lock forgets them all
// (an unlocked session can read tags and albums a locked one cannot), and a lookup that was out when
// the lock came neither files nor returns what it read.
const names = new Map<string, string>();
let generation = 0;
let listening = false;
type Scope = { owner: string; generation: number };

/** Forget every name read so far; lookups already out are ignored when they land. */
export const forgetWorkflowReferences = () => {
  generation++;
  names.clear();
};

const scope = (): Scope => {
  if (!listening) {
    listening = true;
    eventManager.on({ SessionLocked: forgetWorkflowReferences, SessionLockedRemote: forgetWorkflowReferences });
  }
  return { owner: authManager.authenticated ? authManager.user.id : '', generation };
};
const current = (from: Scope) => from.generation === generation;
const key = (owner: string, kind: WorkflowReferenceKind, id: string) => `${owner}:${kind}:${id}`;
const remember = (from: Scope, kind: WorkflowReferenceKind, items: WorkflowReference[]) => {
  if (!current(from)) {
    return [];
  }
  for (const item of items) {
    names.set(key(from.owner, kind, item.id), item.label);
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
  const from = scope();
  const search = text.trim() || undefined;
  if (kind === 'TagId') {
    const tags = await searchTags({ search, take: WORKFLOW_REFERENCE_RESULTS }, { signal });
    return remember(
      from,
      kind,
      tags.map((tag) => ({ id: tag.id, label: tag.value })),
    );
  }
  const albums = await getAllAlbums({ search, take: WORKFLOW_REFERENCE_RESULTS }, { signal });
  return remember(
    from,
    kind,
    albums.map((album) => ({ id: album.id, label: album.albumName })),
  );
};

/** The names of chosen identifiers; one that cannot be read (deleted, not the caller's) is left out. */
export const resolveWorkflowReferences = async (
  kind: WorkflowReferenceKind,
  ids: readonly string[],
): Promise<WorkflowReference[]> => {
  const from = scope();
  const unknown = [...new Set(ids)].filter((id) => !names.has(key(from.owner, kind, id)));
  await Promise.all(
    unknown.map(async (id) => {
      try {
        if (kind === 'TagId') {
          const tag = await getTagById({ id });
          remember(from, kind, [{ id: tag.id, label: tag.value }]);
        } else {
          const [album] = await getAllAlbums({ id });
          if (album) {
            remember(from, kind, [{ id: album.id, label: album.albumName }]);
          }
        }
      } catch {
        // shown as an unavailable selection
      }
    }),
  );
  if (!current(from)) {
    return [];
  }
  return ids.flatMap((id) => {
    const label = names.get(key(from.owner, kind, id));
    return label === undefined ? [] : [{ id, label }];
  });
};

/** Tests: forget the names read so far. */
export const clearWorkflowReferenceNames = forgetWorkflowReferences;
