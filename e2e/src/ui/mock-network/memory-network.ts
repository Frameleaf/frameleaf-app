import type { MemoryResponseDto } from '@immich/sdk';
import { BrowserContext } from '@playwright/test';

export type MemoryChanges = {
  memoryDeletions: string[];
  assetRemovals: Map<string, string[]>;
  /** FL-62: memories the owner hid; listed only when the index asks for isHidden=true. */
  hiddenMemories?: string[];
};

export const setupMemoryMockApiRoutes = async (
  context: BrowserContext,
  memories: MemoryResponseDto[],
  changes: MemoryChanges,
) => {
  await context.route('**/api/memories*', async (route, request) => {
    const url = new URL(request.url());
    const pathname = url.pathname;

    if (pathname === '/api/memories' && request.method() === 'GET') {
      const hidden = changes.hiddenMemories ?? [];
      const wantHidden = url.searchParams.get('isHidden') === 'true';
      const activeMemories = memories
        .filter((memory) => !changes.memoryDeletions.includes(memory.id))
        .filter((memory) => hidden.includes(memory.id) === wantHidden)
        .map((memory) => {
          const removedAssets = changes.assetRemovals.get(memory.id) ?? [];
          return {
            ...memory,
            isHidden: hidden.includes(memory.id),
            assets: memory.assets.filter((asset) => !removedAssets.includes(asset.id)),
          };
        })
        .filter((memory) => memory.assets.length > 0);

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: activeMemories,
      });
    }

    const memoryMatch = pathname.match(/\/api\/memories\/([^/]+)$/);
    if (memoryMatch && request.method() === 'GET') {
      const memoryId = memoryMatch[1];
      const memory = memories.find((m) => m.id === memoryId);

      if (!memory || changes.memoryDeletions.includes(memoryId)) {
        return route.fulfill({ status: 404 });
      }

      const removedAssets = changes.assetRemovals.get(memoryId) ?? [];
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: {
          ...memory,
          assets: memory.assets.filter((asset) => !removedAssets.includes(asset.id)),
        },
      });
    }

    if (/\/api\/memories\/([^/]+)$/.test(pathname) && request.method() === 'DELETE') {
      const memoryId = pathname.split('/').pop()!;
      changes.memoryDeletions.push(memoryId);
      return route.fulfill({ status: 204 });
    }

    await route.fallback();
  });

  // FL-62: hide/restore and the owner's curation (PUT /memories/:id) and show-less rules.
  await context.route('**/api/memories/*', async (route, request) => {
    const url = new URL(request.url());
    const id = url.pathname.split('/').pop()!;
    if (id === 'show-less') {
      return request.method() === 'GET'
        ? route.fulfill({ status: 200, contentType: 'application/json', json: [] })
        : route.fulfill({ status: 204 });
    }
    const memory = memories.find((item) => item.id === id);
    if (memory && request.method() === 'PUT') {
      const body = request.postDataJSON() as { isHidden?: boolean; isSaved?: boolean; title?: string | null };
      changes.hiddenMemories ??= [];
      if (body.isHidden === true && !changes.hiddenMemories.includes(id)) {
        changes.hiddenMemories.push(id);
      }
      if (body.isHidden === false) {
        changes.hiddenMemories = changes.hiddenMemories.filter((item) => item !== id);
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        json: { ...memory, ...body, isHidden: changes.hiddenMemories.includes(id) },
      });
    }
    await route.fallback();
  });

  await context.route('**/api/memories/statistics*', async (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      json: {
        total: memories.length,
      },
    });
  });
};
