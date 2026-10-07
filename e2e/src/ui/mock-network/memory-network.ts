import { StudioExportFormat, type MemoryResponseDto } from '@frameleaf/sdk';
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
  /** FL-194: highlight videos saved to the library, by run id. */
  savedHighlights?: string[];
};

type MemoryExportMock = {
  id: string;
  memoryId: string;
  ownerId: string;
  title: string;
  format: 'archive' | 'highlight';
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
  /** FL-194: a highlight video's settings and render state. */
  highlight: {
    lengthSeconds: number;
    resolution: string;
    audio: string;
    destination: string;
    progress: number;
    savedAssetId: string | null;
  } | null;
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

  // FL-194: the render workers a highlight video's dialog judges its choices against.
  await context.route('**/api/ml-destinations/capabilities', async (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      json: {
        workloads: [],
        studio: {
          gpuWorker: true,
          renderWorker: true,
          restorationWorker: false,
          transcriptionWorker: false,
          render: [
            {
              destination: 'local',
              sessions: 1,
              gpuMemoryBytes: 16 * 1024 ** 3,
              codecs: ['hevc_nvenc', 'h264_nvenc'],
              maxBitDepth: 10,
              hdr10: true,
              dolbyVision: false,
              candidates: [
                {
                  gpuMemoryBytes: 16 * 1024 ** 3,
                  outputFormats: [StudioExportFormat.Mp4HevcMain10, StudioExportFormat.Mp4H264],
                  maxBitDepth: 10,
                  hdr10: true,
                  dolbyVision: false,
                },
              ],
            },
          ],
        },
        probedAt: new Date().toISOString(),
      },
    });
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
      const body = (request.postDataJSON() ?? {}) as {
        format?: 'archive' | 'highlight';
        highlight?: Partial<NonNullable<MemoryExportMock['highlight']>>;
      };
      const format = body.format ?? 'archive';
      const inFlight = changes.exports.find(
        (run) =>
          run.memoryId === memory.id &&
          run.format === format &&
          ['pending', 'running', 'cancelling'].includes(run.status),
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
        format,
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
        expiresAt: held || format === 'highlight' ? null : new Date(Date.now() + 86_400_000).toISOString(),
        highlight:
          format === 'highlight'
            ? {
                lengthSeconds: body.highlight?.lengthSeconds ?? 60,
                resolution: body.highlight?.resolution ?? '2160p',
                audio: body.highlight?.audio ?? 'original',
                destination: body.highlight?.destination ?? 'local',
                progress: held ? 30 : 100,
                savedAssetId: null,
              }
            : null,
      };
      changes.exports.unshift(run);
      return route.fulfill({ status: 201, contentType: 'application/json', json: run });
    }

    if (pathname === '/api/memories/exports' && request.method() === 'GET') {
      const memoryId = url.searchParams.get('memoryId');
      const runs = changes.exports.filter((run) => !memoryId || run.memoryId === memoryId);
      return route.fulfill({ status: 200, contentType: 'application/json', json: runs });
    }

    const one = pathname.match(/^\/api\/memories\/exports\/([^/]+)(?:\/(cancel|download|library))?$/);
    const run = one ? changes.exports.find((item) => item.id === one[1]) : undefined;
    if (one && !run) {
      return route.fulfill({ status: 404 });
    }
    if (run && one?.[2] === 'cancel' && request.method() === 'POST') {
      Object.assign(run, { status: 'cancelled', isDownloadable: false, finishedAt: now, updatedAt: now });
      return route.fulfill({ status: 201, contentType: 'application/json', json: run });
    }
    if (run && one?.[2] === 'download' && request.method() === 'GET') {
      if (!run.isDownloadable) {
        return route.fulfill({ status: 400 });
      }
      return run.format === 'highlight'
        ? route.fulfill({ status: 200, contentType: 'video/mp4', body: Buffer.from('mp4') })
        : route.fulfill({ status: 200, contentType: 'application/zip', body: Buffer.from('PK') });
    }
    if (run?.highlight && one?.[2] === 'library' && request.method() === 'POST') {
      run.highlight.savedAssetId = crypto.randomUUID();
      (changes.savedHighlights ??= []).push(run.id);
      return route.fulfill({ status: 200, contentType: 'application/json', json: run });
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
