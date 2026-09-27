import type { MemoryResponseDto } from '@immich/sdk';
import { BrowserContext } from '@playwright/test';

export type MemoryChanges = {
  memoryDeletions: string[];
  assetRemovals: Map<string, string[]>;
  /** FL-62: memories the owner hid; listed only when the index asks for isHidden=true. */
  hiddenMemories?: string[];
  /** FL-62: the owner's title, item order and favorite, saved through PUT /memories/:id. */
  curations?: Map<string, { title?: string | null; assetOrder?: string[]; isSaved?: boolean }>;
  /** FL-62: private highlight export runs; a run started while `holdExports` is set stays running. */
  exports?: MemoryExportMock[];
  holdExports?: boolean;
};

type MemoryExportMock = {
  id: string;
  memoryId: string;
  ownerId: string;
  title: string;
  format: 'archive';
  status: 'pending' | 'running' | 'cancelling' | 'ready' | 'failed' | 'cancelled';
  assetCount: number;
  processedAssets: number;
  sizeInBytes: number | null;
  error: string | null;
  isDownloadable: boolean;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
};

const curate = (memory: MemoryResponseDto, changes: MemoryChanges): MemoryResponseDto => {
  const removedAssets = changes.assetRemovals.get(memory.id) ?? [];
  const curation = changes.curations?.get(memory.id) ?? {};
  let assets = memory.assets.filter((asset) => !removedAssets.includes(asset.id));
  if (curation.assetOrder) {
    const order = curation.assetOrder;
    assets = assets.toSorted((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  }
  return {
    ...memory,
    ...(curation.title !== undefined && { title: curation.title }),
    ...(curation.isSaved !== undefined && { isSaved: curation.isSaved }),
    isHidden: (changes.hiddenMemories ?? []).includes(memory.id),
    assets,
  };
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
        .map((memory) => curate(memory, changes))
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

      return route.fulfill({ status: 200, contentType: 'application/json', json: curate(memory, changes) });
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
      const body = request.postDataJSON() as {
        isHidden?: boolean;
        isSaved?: boolean;
        title?: string | null;
        assetOrder?: string[];
      };
      changes.curations ??= new Map();
      const { title, assetOrder, isSaved } = body;
      const curation = Object.fromEntries(
        Object.entries({ title, assetOrder, isSaved }).filter(([, value]) => value !== undefined),
      );
      changes.curations.set(id, { ...changes.curations.get(id), ...curation });
      changes.hiddenMemories ??= [];
      if (body.isHidden === true && !changes.hiddenMemories.includes(id)) {
        changes.hiddenMemories.push(id);
      }
      if (body.isHidden === false) {
        changes.hiddenMemories = changes.hiddenMemories.filter((item) => item !== id);
      }
      return route.fulfill({ status: 200, contentType: 'application/json', json: curate(memory, changes) });
    }
    await route.fallback();
  });

  // FL-62: the private highlight export's durable run, as the server keeps it.
  await context.route(/\/api\/memories\/(?:exports(?:\?.*)?$|exports\/.+|[^/]+\/exports$)/, async (route, request) => {
    const url = new URL(request.url());
    const pathname = url.pathname;
    changes.exports ??= [];
    const now = new Date().toISOString();

    const start = pathname.match(/^\/api\/memories\/([^/]+)\/exports$/);
    if (start && request.method() === 'POST') {
      const memory = memories.find((item) => item.id === start[1])!;
      const inFlight = changes.exports.find(
        (run) => run.memoryId === memory.id && ['pending', 'running', 'cancelling'].includes(run.status),
      );
      if (inFlight) {
        return route.fulfill({ status: 201, contentType: 'application/json', json: inFlight });
      }
      const held = !!changes.holdExports;
      const run: MemoryExportMock = {
        id: crypto.randomUUID(),
        memoryId: memory.id,
        ownerId: memory.ownerId,
        title: 'Memory',
        format: 'archive',
        status: held ? 'running' : 'ready',
        assetCount: memory.assets.length,
        processedAssets: held ? 1 : memory.assets.length,
        sizeInBytes: held ? null : 42,
        error: null,
        isDownloadable: !held,
        createdAt: now,
        updatedAt: now,
        startedAt: now,
        finishedAt: held ? null : now,
        expiresAt: held ? null : new Date(Date.now() + 86_400_000).toISOString(),
      };
      changes.exports.unshift(run);
      return route.fulfill({ status: 201, contentType: 'application/json', json: run });
    }

    if (pathname === '/api/memories/exports' && request.method() === 'GET') {
      const memoryId = url.searchParams.get('memoryId');
      const runs = changes.exports.filter((run) => !memoryId || run.memoryId === memoryId);
      return route.fulfill({ status: 200, contentType: 'application/json', json: runs });
    }

    const one = pathname.match(/^\/api\/memories\/exports\/([^/]+)(?:\/(cancel|download))?$/);
    const run = one ? changes.exports.find((item) => item.id === one[1]) : undefined;
    if (one && !run) {
      return route.fulfill({ status: 404 });
    }
    if (run && one?.[2] === 'cancel' && request.method() === 'POST') {
      Object.assign(run, { status: 'cancelled', isDownloadable: false, finishedAt: now, updatedAt: now });
      return route.fulfill({ status: 201, contentType: 'application/json', json: run });
    }
    if (run && one?.[2] === 'download' && request.method() === 'GET') {
      return run.isDownloadable
        ? route.fulfill({ status: 200, contentType: 'application/zip', body: Buffer.from('PK') })
        : route.fulfill({ status: 400 });
    }
    if (run && request.method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', json: run });
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
