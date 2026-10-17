import type { StudioAssetRef } from './host-contract';

const REVERSE_ID = /^reverse-[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const ALIAS = 'studio-generated:';

/** Browser-only identity. It is never a library mediaId in the stored graph. */
export interface StudioGeneratedMedia extends StudioAssetRef {
  generatedId: string;
  checksum: string;
  frameRate: { num: number; den: number };
}

export const generatedMediaAlias = (id: string): string => {
  if (!REVERSE_ID.test(id)) {
    throw new Error('Unsupported generated Studio resource');
  }
  return `${ALIAS}${id}`;
};

function mapGraph(graph: unknown, visit: (node: Record<string, unknown>) => Record<string, unknown>): unknown {
  let remaining = 100_000;
  const walk = (value: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 64) {
      throw new Error('Studio graph exceeds resource limits');
    }
    if (Array.isArray(value)) {
      return value.map((item) => walk(item, depth + 1));
    }
    if (!value || typeof value !== 'object') {
      return value;
    }
    return visit(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item, depth + 1)])));
  };
  return walk(graph, 0);
}

/** Remove browser aliases and all transient URLs before comparison, commands, or persistence. */
export function storeGeneratedMedia(graph: unknown): unknown {
  return mapGraph(graph, (node) => {
    const alias =
      typeof node.mediaId === 'string' && node.mediaId.startsWith(ALIAS) ? node.mediaId.slice(ALIAS.length) : null;
    const id = alias ?? node.generatedId;
    if (id === undefined) {
      return node;
    }
    if (
      typeof id !== 'string' ||
      !REVERSE_ID.test(id) ||
      (alias && node.generatedId !== undefined && node.generatedId !== alias)
    ) {
      throw new Error('Invalid generated Studio resource identity');
    }
    if (node.assetId !== undefined || (node.mediaId !== undefined && !alias)) {
      throw new Error('Generated media cannot also name a library asset');
    }
    const stored: Record<string, unknown> = { ...node, generatedId: id };
    for (const key of Object.keys(stored)) {
      if (
        ['mediaId', 'src', 'audioSrc', 'thumbnailUrl', 'waveformData'].includes(key) ||
        key.startsWith('reverseConform')
      ) {
        delete stored[key];
      }
    }
    return stored;
  });
}

export function generatedMediaIds(graph: unknown): string[] {
  const ids = new Set<string>();
  mapGraph(storeGeneratedMedia(graph), (node) => {
    if (typeof node.generatedId === 'string') {
      ids.add(node.generatedId);
    }
    return node;
  });
  if (ids.size > 200) {
    throw new Error('Too many generated Studio resources');
  }
  return [...ids].sort();
}

/** Admission must precede loading either engine runtime. Unknown generated media fails closed. */
export function hydrateGeneratedMedia(graph: unknown, admitted: readonly StudioGeneratedMedia[]): unknown {
  const byId = new Map(admitted.map((media) => [media.generatedId, media]));
  return mapGraph(storeGeneratedMedia(graph), (node) => {
    if (typeof node.generatedId !== 'string') {
      return node;
    }
    const media = byId.get(node.generatedId);
    if (!media || media.isOffline || media.id !== generatedMediaAlias(node.generatedId) || !media.playbackUrl) {
      throw new Error('Generated Studio media is not authorized');
    }
    return { ...node, mediaId: media.id, src: media.playbackUrl };
  });
}
