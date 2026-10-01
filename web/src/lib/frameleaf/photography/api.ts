import { defaults, getBaseUrl } from '@immich/sdk';

export const shootStages = ['Imported', 'Selected', 'Edited', 'Proofing', 'Delivered'] as const;
export const shootTypes = [
  'Family portrait',
  'Wedding',
  'Portrait',
  'Editorial',
  'Commercial',
  'Event',
  'Personal',
] as const;
export type Shoot = {
  id: string;
  albumId: string | null;
  name: string;
  client: string;
  type: (typeof shootTypes)[number];
  date: string;
  stage: (typeof shootStages)[number];
  unavailable: boolean;
  coverAssetId: string | null;
  assetCount: number | null;
};
export type Workspace = { revision: string | null; shoots: Shoot[] };
export type Photo = {
  id: string;
  fileName: string;
  rating: number | null;
  canRate: boolean;
  stackCount: number;
  currentRevisionId: string | null;
};
export type PhotoPage = { nextCursor: string | null; photos: Photo[] };

// Reuse the configured SDK transport, headers and base URL until SDK generation adds these new routes.
const request = async <T,>(path: string, method = 'GET', body?: unknown): Promise<T> => {
  const headers = new Headers(defaults.headers as HeadersInit);
  headers.set('Accept', 'application/json');
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await (defaults.fetch ?? fetch)(`${getBaseUrl()}/photography/shoots${path}`, {
    method,
    headers,
    credentials: 'include',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(
      response.status === 409
        ? 'Shoots changed in another window. Reload before saving.'
        : 'The request could not be completed. Try again.',
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
};
export const loadWorkspace = () => request<Workspace>('');
export const saveWorkspace = (workspace: Workspace) =>
  request<Workspace>('', 'PUT', {
    expectedRevision: workspace.revision,
    shoots: workspace.shoots.map(({ id, albumId, name, client, type, date, stage }) => ({
      id,
      albumId,
      name,
      client,
      type,
      date,
      stage,
    })),
  });
export const loadPhotos = (id: string, cursor?: string | null) =>
  request<PhotoPage>(`/${encodeURIComponent(id)}/photos${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`);
export const ratePhoto = (id: string, assetId: string, rating: number | null) =>
  request<void>(`/${encodeURIComponent(id)}/rating`, 'PATCH', { assetId, rating });
