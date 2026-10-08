import { getBaseUrl } from '@frameleaf/sdk';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { websocketEvents, websocketStore } from '$lib/stores/websocket';
import { generatedMediaAlias, generatedMediaIds, type StudioGeneratedMedia } from './generated-media';

const positive = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

export interface StudioGeneratedAccess {
  admit(projectId: string | undefined, graph: unknown, revision?: number): Promise<StudioGeneratedMedia[]>;
  recheck(): Promise<boolean>;
  dispose(): void;
}

/** One frame owns its requests; revocation aborts admission and destroys that frame's caches. */
export function createStudioGeneratedAccess(
  onRevoked: (error: Error) => void,
  fetchImpl: typeof fetch = fetch,
): StudioGeneratedAccess {
  const controller = new AbortController();
  let project: string | undefined;
  let ids: string[] = [];
  let admitted: StudioGeneratedMedia[] = [];
  let revoked = false;
  let admissionKey = '';
  let connected = false;
  let hasGenerated = false;
  const requestedProjects = new Set<string>();
  const requestedIds = new Set<string>();
  let generation = 0;
  let admissions: Promise<void> = Promise.resolve();
  const revoke = () => {
    if (revoked || !hasGenerated) {
      return;
    }
    revoked = true;
    controller.abort();
    onRevoked(new Error('Generated Studio media access changed. Reload the project to check access again.'));
  };
  // ponytail: conservatively invalidate all generated media on access-affecting events;
  // use project/source-specific revocation events when available.
  const unsubscribe = eventManager.on({
    AuthLogout: revoke,
    SessionDelete: revoke,
    SessionLocked: revoke,
    SessionLockedRemote: revoke,
    SessionAccessChanged: revoke,
    AssetUpdate: revoke,
    AssetsDelete: revoke,
    AssetsMarkNsfw: revoke,
    AlbumDelete: revoke,
    AlbumUserDelete: revoke,
    PartnerRevoke: revoke,
  });
  const socketUnsubscribers = [
    websocketEvents.on('AssetLocalEffectsV1', ({ revokedOperationIds }) => {
      // An old local effect can only invalidate the admission that produced these exact files.
      if ([...requestedIds].some((id) => revokedOperationIds.includes(id.slice('reverse-'.length)))) {
        revoke();
      }
    }),
    websocketEvents.on('StudioProjectInvalidatedV1', ({ projectId }) => {
      if (projectId === null || requestedProjects.has(projectId)) {
        revoke();
      }
    }),
    websocketEvents.on('on_asset_delete', revoke),
    websocketEvents.on('on_asset_trash', revoke),
    websocketEvents.on('on_asset_update', revoke),
    websocketEvents.on('on_asset_hidden', revoke),
    websocketStore.connected.subscribe((value) => {
      connected = value;
      if (!connected) {
        revoke();
      }
    }),
  ];
  globalThis.addEventListener?.('offline', revoke);
  const resolve = async (projectId: string | undefined, wanted: string[]): Promise<StudioGeneratedMedia[]> => {
    if (wanted.length === 0) {
      return [];
    }
    if (!projectId || !connected || controller.signal.aborted) {
      throw new Error('Generated Studio admission was revoked');
    }
    return Promise.all(
      wanted.map(async (generatedId) => {
        const operationId = generatedId.slice('reverse-'.length);
        const base = `${getBaseUrl()}/media-operations/${encodeURIComponent(operationId)}`;
        const response = await fetchImpl(`${base}/reverse-result`, {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          throw new Error('Generated Studio admission binding was revoked');
        }
        if (!response.ok) {
          throw new Error('Generated Studio media is unavailable');
        }
        const result = record(await response.json());
        const frameRate = record(result.frameRate);
        const preview = record(result.browserPreview);
        if (
          controller.signal.aborted ||
          result.projectId !== projectId ||
          result.operationId !== operationId ||
          result.generatedId !== generatedId ||
          !positive(result.frames) ||
          !positive(frameRate.num) ||
          !positive(frameRate.den) ||
          !positive(result.width) ||
          !positive(result.height) ||
          preview.generatedId !== `reverse-preview-${operationId}` ||
          preview.contentType !== 'video/mp4' ||
          preview.delivery !== 'authenticated' ||
          preview.profile !== 'h264-main-3.2-aac-lc-v1' ||
          typeof preview.checksum !== 'string' ||
          !/^[a-f0-9]{64}$/.test(preview.checksum)
        ) {
          throw new Error('Invalid generated Studio result binding');
        }
        const durationNumerator = result.frames * frameRate.den;
        if (!Number.isSafeInteger(durationNumerator)) {
          throw new TypeError('Generated media duration exceeds safe precision');
        }
        return {
          id: generatedMediaAlias(generatedId),
          generatedId,
          checksum: preview.checksum,
          kind: 'video',
          name: `${generatedId}.mp4`,
          duration: { num: durationNumerator, den: frameRate.num },
          frameRate: { num: frameRate.num, den: frameRate.den },
          width: result.width,
          height: result.height,
          mimeType: 'video/mp4',
          thumbnailUrl: '',
          previewUrl: `${base}/reverse-preview`,
          playbackUrl: `${base}/reverse-preview`,
          isOffline: false,
        };
      }),
    );
  };
  const settleAdmissions = async () => {
    let pending: Promise<void>;
    do {
      pending = admissions;
      await pending;
    } while (pending !== admissions);
  };
  const api: StudioGeneratedAccess = {
    async admit(projectId, graph, revision) {
      const requested = generatedMediaIds(graph);
      hasGenerated ||= requested.length > 0;
      for (const id of requested) {
        requestedIds.add(id);
      }
      if (requested.length > 0 && projectId) {
        requestedProjects.add(projectId);
      }
      const task = admissions.then(async () => {
        if (revoked) {
          throw new Error('Generated Studio admission was revoked');
        }
        if (project !== undefined && project !== projectId && ids.length > 0) {
          revoke();
          throw new Error('Generated media belongs to another project');
        }
        const wanted = [...new Set([...ids, ...requested])].sort();
        const key = JSON.stringify([projectId, revision, wanted]);
        if (revision !== undefined && key === admissionKey) {
          return admitted;
        }
        try {
          const next = await resolve(projectId, wanted);
          if (controller.signal.aborted) {
            throw new Error('Generated Studio admission was revoked');
          }
          // Publish one authorized generation; a focus recheck must never see half an admission.
          project = projectId;
          ids = wanted;
          admitted = next;
          admissionKey = key;
          generation++;
          return admitted;
        } catch (error) {
          revoke();
          throw error;
        }
      });
      admissions = task.then(() => undefined).catch(() => undefined);
      return task;
    },
    async recheck() {
      while (true) {
        await settleAdmissions();
        if (revoked) {
          return false;
        }
        const checkedGeneration = generation;
        const expected = admitted;
        let current: StudioGeneratedMedia[] | undefined;
        try {
          current = await resolve(project, ids);
        } catch {
          // Judge a failure only after any overlapping admission has settled.
        }
        await settleAdmissions();
        if (revoked) {
          return false;
        }
        // A changed generation invalidates this read, including a denial. Freshly check the
        // complete current set before authorizing; a newer admission alone is not this check.
        if (checkedGeneration !== generation) {
          continue;
        }
        if (current && JSON.stringify(current) === JSON.stringify(expected)) {
          return true;
        }
        revoke();
        return false;
      }
    },
    dispose() {
      revoked = true;
      controller.abort();
      unsubscribe();
      for (const stop of socketUnsubscribers) {
        stop();
      }
      globalThis.removeEventListener?.('offline', revoke);
      globalThis.removeEventListener?.('focus', wake);
      globalThis.removeEventListener?.('online', wake);
    },
  };
  const wake = () => {
    void api.recheck();
  };
  globalThis.addEventListener?.('focus', wake);
  globalThis.addEventListener?.('online', wake);
  return api;
}
