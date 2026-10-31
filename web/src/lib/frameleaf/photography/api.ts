import { defaults, getBaseUrl } from '@frameleaf/sdk';
import { PhotographyError } from './errors';
import type { Watermark } from './workflow-api';

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
const request = async <T>(path: string, method = 'GET', body?: unknown): Promise<T> => {
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
    throw new PhotographyError(response.status === 409 ? 'settings_changed' : 'request_failed', response.status);
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

export type Brand = {
  name: string;
  tagline: string;
  email: string;
  phone: string;
  logoInitials: string;
  logoAssetId: string | null;
  color: string;
  background: string;
  textColor: string;
  font: 'editorial' | 'modern' | 'classic';
  watermarkColor: string;
  watermarkOpacity: number;
  watermarkPosition: 'bottom-right' | 'bottom-left' | 'center' | 'top-right';
  watermarkSize: number;
  watermarkPresets?: { id: string; name: string; version: number; watermark: Watermark }[];
  webWatermarkPresetId?: string | null;
  proofWatermarkPresetId?: string | null;
  exportWatermarkPresetId?: string | null;
};
export type Branding = { revision: string | null; brand: Brand; logoUnavailable: boolean };
export type LogoPage = { nextCursor: string | null; logos: { id: string; fileName: string }[] };
export const loadBrand = () => request<Branding>('/branding');
export const saveBrand = (
  revision: string | null,
  brand: Omit<Brand, 'logoAssetId'> & { logoAssetId?: string | null },
) => request<Branding>('/branding', 'PUT', { expectedRevision: revision, brand });
export const loadLogos = (cursor?: string | null) =>
  request<LogoPage>(`/branding/logos${cursor ? '?cursor=' + encodeURIComponent(cursor) : ''}`);
export const logoThumbnailUrl = (id: string) =>
  `${getBaseUrl()}/photography/shoots/branding/logos/${encodeURIComponent(id)}/thumbnail`;
