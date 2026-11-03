import type { AlbumKind, UpdateAlbumDto } from '@frameleaf/sdk';
import { chunk } from 'lodash-es';
import type { ServerClient } from 'src/commands/migrate/client';
import type { Controller } from 'src/commands/migrate/controller';
import type { Ledger } from 'src/commands/migrate/ledger';
import { collectAssetIds } from 'src/commands/migrate/search';
import type { MigrateOptions } from 'src/commands/migrate/types';

// Identity of an album as a user sees it: its name within its parent. Joined with a NUL,
// which (unlike a space) cannot occur in a name, so "A" / "B C" can't collide with "A B" / "C".
const albumKey = (parentId: string | null | undefined, name: string) => `${parentId ?? ''}\u{0}${name}`;

/**
 * Phase 6: recreate albums (the top priority) — nested parents first — then link each
 * album's assets and set its thumbnail. Album membership is a per-album set; ordering is
 * only an asc/desc sort direction, copied via PATCH. `sortOrder` positions nested siblings.
 */
export async function migrateAlbums(
  from: ServerClient,
  to: ServerClient,
  ledger: Ledger,
  options: MigrateOptions,
  controller: Controller,
) {
  controller.setPhase('albums');
  const albums = ledger.allAlbums();
  if (albums.length === 0) {
    return;
  }

  // Order parents before children so parentId can be mapped at creation time.
  const byId = new Map(albums.map((a) => [a.aId, a]));
  const depthOf = (aId: string, seen = new Set<string>()): number => {
    const album = byId.get(aId);
    if (!album || !album.parentAId || seen.has(aId) || !byId.has(album.parentAId)) {
      return 0;
    }
    seen.add(aId);
    return 1 + depthOf(album.parentAId, seen);
  };
  const ordered = albums.toSorted((a, b) => depthOf(a.aId) - depthOf(b.aId));

  // The destination user's own albums not yet claimed by this ledger, so a crash between
  // createAlbum and setAlbumBId can't produce a duplicate on resume. Keyed by name + parent,
  // which is what identifies an album to a user. Albums other users share are never
  // candidates, and each one is claimed once, so same-named source albums stay apart.
  const claimed = new Set(albums.map((a) => a.bId));
  const existing = new Map<string, string[]>();
  for (const a of await to.getAllAlbums()) {
    if (!claimed.has(a.id)) {
      const key = albumKey(a.parentId, a.albumName);
      existing.set(key, [...(existing.get(key) ?? []), a.id]);
    }
  }

  // 1. Create albums (parents first) and copy order/sortOrder.
  for (const album of ordered) {
    if (album.bId) {
      continue;
    }
    await controller.gate();
    if (controller.stopped) {
      return;
    }
    const parentBId = album.parentAId ? ledger.albumBId(album.parentAId) : undefined;
    if (album.parentAId && byId.has(album.parentAId) && !parentBId) {
      // Its collection failed to be created; making this one top-level would lose the nesting.
      controller.log(`album ${album.name}: skipped until its collection exists on destination`);
      continue;
    }
    try {
      const reuseId = existing.get(albumKey(parentBId, album.name))?.shift();
      const createdAlbum = reuseId
        ? { id: reuseId }
        : await to.createAlbum({
            albumName: album.name,
            kind: album.kind as AlbumKind | undefined,
            description: album.description || undefined,
            icon: album.icon ?? undefined,
            parentId: parentBId,
          });
      ledger.setAlbumBId(album.aId, createdAlbum.id);
      const patch: UpdateAlbumDto = {};
      if (album.order) {
        patch.order = album.order as UpdateAlbumDto['order'];
      }
      if (album.sortOrder != undefined) {
        patch.sortOrder = album.sortOrder;
      }
      if (Object.keys(patch).length > 0) {
        await to.updateAlbum(createdAlbum.id, patch);
      }
    } catch (error) {
      // Not recorded, so a later run retries it; the audit lists it as unresolved meanwhile.
      controller.log(`album ${album.name}: failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // 2. Link assets and set the thumbnail (assets must exist on B first).
  for (const album of ordered) {
    if (album.linked) {
      continue;
    }
    await controller.gate();
    if (controller.stopped) {
      return;
    }
    const bAlbumId = ledger.albumBId(album.aId);
    if (!bAlbumId) {
      continue;
    }
    try {
      const memberAIds = await collectAssetIds(from, { albumIds: [album.aId] }, options.includeTrashed);
      const bAssetIds: string[] = [];
      let pending = 0;
      for (const aId of memberAIds) {
        const bId = ledger.bId(aId);
        if (bId) {
          bAssetIds.push(bId);
        } else if (ledger.hasAsset(aId)) {
          pending++; // enumerated but not on B yet (failed or still to transfer)
        }
      }
      for (const part of chunk(bAssetIds, 500)) {
        await to.addAssetsToAlbum(bAlbumId, part);
      }
      if (album.thumbAId) {
        const thumbBId = ledger.bId(album.thumbAId);
        if (thumbBId) {
          await to.updateAlbum(bAlbumId, { albumThumbnailAssetId: thumbBId });
        }
      }
      if (pending > 0) {
        // Adding members is idempotent, so leave the album pending: a later run (for example
        // with --retry-failed) adds the late assets, and the audit lists it until then.
        controller.log(`album ${album.name}: ${pending} member(s) not on destination yet`);
        continue;
      }
      ledger.setAlbumLinked(album.aId);
      controller.log(`album linked: ${album.name}`);
    } catch (error) {
      // Not marked linked, so a later run retries this album. Keep going: albums are the
      // most important thing to preserve, and one failure shouldn't cost the rest.
      controller.log(`album ${album.name}: failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
