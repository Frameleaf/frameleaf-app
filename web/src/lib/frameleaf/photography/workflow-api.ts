import { defaults, getBaseUrl } from '@frameleaf/sdk';
import { codeForStatus, PhotographyError } from './errors';

export type Watermark = {
  type: 'text' | 'logo' | 'both';
  text: string;
  secondLine: string;
  font: 'script' | 'serif' | 'sans';
  pattern: 'signature' | 'centre' | 'diagonal' | 'tile';
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
  logoPosition: 'above' | 'below' | 'left' | 'right';
  alignment: 'left' | 'center' | 'right';
  size: number;
  logoScale: number;
  color: string;
  opacity: number;
  rotation: number;
  margin: number;
  spacing: number;
  outline: boolean;
  backing: boolean;
  logoVariant: 'original' | 'light' | 'dark';
  logoAssetId: string | null;
};
export type Presentation = {
  template: 'wedding' | 'portrait' | 'fine-art' | 'proofing';
  coverCaptureId: string | null;
  coverTreatment: 'full' | 'split' | 'quiet';
  coverFocal: number;
  font: 'editorial' | 'modern' | 'script';
  palette: 'studio' | 'ivory' | 'charcoal';
  spacing: 'compact' | 'comfortable' | 'airy';
  introduction: string;
  showChapters: boolean;
  showNumbers: boolean;
  blocks?: PresentationBlock[];
};
export type PresentationBlock = {
  id: string;
  type: 'chapter' | 'grid' | 'full' | 'pair' | 'caption' | 'slideshow';
  chapterId: string | null;
  captureIds: string[];
  text: string;
  selection?: 'automatic' | 'explicit';
};
export type WorkflowConfig = {
  title: string;
  mode: 'edited-delivery' | 'select-before-editing' | 'sell-by-photo';
  paymentTiming: 'before-editing' | 'after-approval';
  currency: string;
  includedCount: number;
  additionalPrice: number;
  collectionPrice: number | null;
  bundles: { count: number; price: number }[];
  terms: string;
  selectionDeadline: string | null;
  expiresAt: string | null;
  turnaroundDays: number;
  proofWatermark: Watermark;
  webWatermark: Watermark | null;
  downloadWatermark: Watermark | null;
  downloadOutputs?: OutputDefinition[];
  presentation: Presentation;
};
export type OutputDefinition = {
  key: string;
  label: string;
  kind: 'print' | 'web' | 'social';
  maxEdge: number;
  watermark: Watermark | null;
};
export type DeliveryOutput = {
  id: string;
  label: string;
  kind: OutputDefinition['kind'];
  revisionId: string | null;
  approved: boolean;
  clientApprovalRequired: boolean;
  ready: boolean;
  renderStatus: 'awaiting-approval' | 'preparing' | 'ready';
  branded: boolean;
  exportSpec: { format: 'jpeg'; quality: 90; maxEdge: number };
  url: string;
  approvalPreviewUrl: string | null;
};
export type Annotation = { x: number; y: number; width: number; height: number; text: string };
export type PhotoNote = { captureId: string; text: string; annotations?: Annotation[] };
export type StudioPresets = {
  revision: string | null;
  presets: { id: string; name: string; config: WorkflowConfig }[];
};
export type Capture = {
  id: string;
  number: number;
  assetId: string | null;
  assetIds: string[];
  fileName: string | null;
  checksum?: string | null;
  camera: string | null;
  capturedAt: string | null;
  offsetSeconds: number;
  photographer: string;
  chapterId: string | null;
  position: number;
  withheld: boolean;
  rating: number | null;
  isRaw: boolean | null;
  eligible: boolean;
  exclusion: string | null;
  processing: string;
  proofRevisionId: string | null;
  approvedRevisionId: string | null;
  state: string;
};
export type Chapter = {
  id: string;
  title: string;
  description: string;
  position: number;
  coverCaptureId: string | null;
};
export type Round = {
  id: string;
  recipientId: string;
  number: number;
  captureIds: string[];
  notes: PhotoNote[];
  createdAt: string;
};
export type Order = {
  id: string;
  recipientId: string;
  roundId: string | null;
  captureIds: string[];
  status: string;
  currency: string;
  total: number;
  terms: string;
  paymentTiming: string;
  createdAt: string;
  acceptedAt: string | null;
  readyCount: number;
  editingBlocked: boolean;
  items: {
    captureId: string;
    revisionId: string | null;
    approved: boolean;
    clientApprovalRequired: boolean;
    ready: boolean;
    outputs?: DeliveryOutput[];
  }[];
  pricing: {
    includedCount: number;
    additionalPrice: number;
    collectionPrice: number | null;
    bundles: { count: number; price: number }[];
    option: string;
  };
};
export type Publication = {
  id: string | null;
  status: string;
  completed: number;
  total: number;
  error: string | null;
  failedCaptureId?: string | null;
};
export type Workflow = {
  revision: string | null;
  shootId: string;
  config: WorkflowConfig;
  presets: { id: string; name: string; config: WorkflowConfig }[];
  studioPresets?: StudioPresets;
  approvedVersions?: { captureId: string; revisionId: string; approvedAt: string }[];
  pendingEdits?: number;
  captures: Capture[];
  chapters: Chapter[];
  recipients: {
    id: string;
    name: string;
    revoked: boolean;
    canProof: boolean;
    canDownload: boolean;
    expiresAt: string | null;
    captureIds: string[] | null;
  }[];
  rounds: Round[];
  orders: Order[];
  publication: Publication | null;
  ordering: 'chronological' | 'photographer' | 'manual' | 'chapters';
  approvals: {
    recipientId: string;
    captureId: string;
    revisionId: string;
    approved: boolean;
    note: string;
    createdAt: string;
  }[];
  receipts: {
    id: string;
    orderId: string | null;
    recipientId: string;
    createdAt: string;
    action: string;
    reference: string;
  }[];
};
export type WorkflowSummary = {
  shootId: string;
  revision: string;
  title: string;
  mode: WorkflowConfig['mode'];
  selectionDeadline: string | null;
  expiresAt: string | null;
  published: boolean;
  submittedRounds: number;
  unpaidOrders: number;
  readyCount: number;
  pendingEdits?: number;
};
export type GuestPhoto = {
  id: string;
  number: number;
  chapterId: string | null;
  status: string;
  previewUrl: string;
  thumbnailUrl: string;
  canDownload: boolean;
  approvalRevisionId: string | null;
  blockedReason: null | 'permission' | 'order' | 'payment' | 'approval' | 'render';
  outputs?: (DeliveryOutput & Pick<GuestPhoto, 'canDownload' | 'blockedReason'>)[];
};
export type GuestGallery = {
  revision: string;
  title: string;
  mode: WorkflowConfig['mode'];
  checkoutAvailable: boolean;
  chapters: Chapter[];
  photos: GuestPhoto[];
  recipient: { id: string; name: string; canDownload: boolean };
  choices: string[];
  notes: PhotoNote[];
  receipts?: Workflow['receipts'];
  rounds: Round[];
  orders: Order[];
  publication: Publication | null;
  publishedGenerationId?: string | null;
  presentation: Presentation;
  pricing: {
    currency: string;
    includedCount: number;
    additionalPrice: number;
    collectionPrice: number | null;
    bundles: { count: number; price: number }[];
    terms: string;
    selectionDeadline: string | null;
  };
  brand: PublicBrand;
};
export type PublicBrand = {
  name: string;
  tagline: string;
  email: string;
  phone: string;
  color: string;
  background: string;
  textColor: string;
  font: string;
  logoUrl: string | null;
};
export type Site = {
  enabled: boolean;
  title: string;
  about: string;
  services: string;
  contact: string;
  portfolio: { shootId: string; captureId: string; consent: true }[];
  presentation: {
    layout: 'editorial' | 'grid' | 'slideshow';
    spacing: 'compact' | 'comfortable' | 'airy';
    font: 'editorial' | 'modern' | 'script';
    palette: 'studio' | 'ivory' | 'charcoal';
  };
};
export type StudioSite = { revision: string | null; site: Site; url?: string };
export type PublicSite = Omit<Site, 'portfolio'> & {
  portfolio: { shootId: string; captureId: string; url: string }[];
  brand: PublicBrand;
};

export async function workflowRequest<T>(id: string, path = '', method = 'GET', body?: unknown): Promise<T> {
  return ownerRequest<T>(`/workflows/${encodeURIComponent(id)}${path}`, method, body);
}
export async function siteRequest(method = 'GET', body?: unknown): Promise<StudioSite> {
  return ownerRequest<StudioSite>('/site', method, body);
}
export const studioPresetsRequest = (method = 'GET', body?: unknown) =>
  ownerRequest<StudioPresets>('/presets', method, body);
export const loadWorkflowSummaries = () => ownerRequest<{ galleries: WorkflowSummary[] }>('/workflows', 'GET');
async function ownerRequest<T>(path: string, method: string, body?: unknown): Promise<T> {
  const headers = new Headers(defaults.headers as HeadersInit);
  headers.set('Accept', 'application/json');
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await (defaults.fetch ?? fetch)(`${getBaseUrl()}/photography${path}`, {
    method,
    headers,
    credentials: 'include',
    cache: 'no-store',
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  checkResponse(response);
  return response.status === 204 ? (undefined as T) : response.json();
}
export async function galleryLogo(id: string, session: string): Promise<Blob> {
  const response = await galleryFetch(id, session, '/logo');
  const blob = await response.blob();
  if (blob.type !== 'image/png') {
    throw new PhotographyError('logo_unavailable');
  }
  return blob;
}
export async function publicStudio(ownerId: string): Promise<PublicSite> {
  const response = await (defaults.fetch ?? fetch)(
    `${getBaseUrl()}/photography/studios/${encodeURIComponent(ownerId)}`,
    { headers: { Accept: 'application/json' }, credentials: 'omit', cache: 'no-store' },
  );
  checkResponse(response);
  return response.json();
}
export const publicStudioMediaUrl = (ownerId: string, path: string) =>
  `${getBaseUrl()}/photography/studios/${encodeURIComponent(ownerId)}${path}`;
export type GalleryRequestOptions = {
  /**
   * Let the request outlive the page (a save started as the tab closes). The browser limits the
   * body of such a request to 64 KB in total, so use it for the small choices save only.
   */
  keepalive?: boolean;
};
export async function galleryRequest<T>(
  id: string,
  session: string,
  path = '',
  method = 'GET',
  body?: unknown,
  options?: GalleryRequestOptions,
): Promise<T> {
  const response = await galleryFetch(id, session, path, method, body, options);
  return response.status === 204 ? (undefined as T) : response.json();
}
export async function galleryMedia(
  id: string,
  captureId: string,
  kind: 'thumbnail' | 'preview' | 'download',
  session: string,
): Promise<Blob> {
  return galleryFile(id, session, `/photos/${encodeURIComponent(captureId)}/${kind}`, false);
}

function checkResponse(response: Response): void {
  if (response.ok) {
    return;
  }
  throw new PhotographyError(codeForStatus(response.status), response.status);
}

async function galleryFetch(
  id: string,
  session: string,
  path: string,
  method = 'GET',
  body?: unknown,
  options?: GalleryRequestOptions,
): Promise<Response> {
  // Gallery invitations must never inherit the owner's SDK Authorization header or browser cookies.
  const headers = new Headers({ Accept: 'application/json' });
  if (session) {
    headers.set('X-Photography-Session', session);
  }
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await (defaults.fetch ?? fetch)(
    `${getBaseUrl()}/photography/galleries/${encodeURIComponent(id)}${path}`,
    {
      method,
      headers,
      credentials: 'omit',
      cache: 'no-store',
      body: body === undefined ? undefined : JSON.stringify(body),
      ...(options?.keepalive && { keepalive: true }),
    },
  );
  checkResponse(response);
  return response;
}

export async function galleryFile(id: string, session: string, path: string, zip: boolean): Promise<Blob> {
  const response = await galleryFetch(id, session, path);
  const blob = await response.blob();
  if (!(zip ? ['application/zip', 'application/octet-stream'].includes(blob.type) : blob.type === 'image/jpeg')) {
    throw new PhotographyError('not_ready');
  }
  return blob;
}

export const defaultWatermark = (text: string, proof = false): Watermark => ({
  type: 'text',
  text,
  secondLine: proof ? 'PROOF' : '',
  font: 'script',
  pattern: proof ? 'tile' : 'signature',
  position: 'bottom-right',
  logoPosition: 'above',
  alignment: 'center',
  size: proof ? 9 : 4,
  logoScale: 1,
  color: '#ffffff',
  opacity: proof ? 60 : 45,
  rotation: proof ? -24 : 0,
  margin: 4,
  spacing: 6,
  outline: false,
  backing: false,
  logoVariant: 'original',
  logoAssetId: null,
});
export const defaultPresentation: Presentation = {
  template: 'portrait',
  coverCaptureId: null,
  coverTreatment: 'split',
  coverFocal: 50,
  font: 'editorial',
  palette: 'studio',
  spacing: 'comfortable',
  introduction: '',
  showChapters: true,
  showNumbers: true,
};

export async function watermarkPreview(
  watermark: Watermark,
  orientation: 'portrait' | 'landscape',
  background: 'light' | 'dark',
): Promise<Blob> {
  const headers = new Headers(defaults.headers as HeadersInit);
  headers.set('Content-Type', 'application/json');
  const response = await (defaults.fetch ?? fetch)(`${getBaseUrl()}/photography/shoots/branding/preview`, {
    method: 'POST',
    headers,
    credentials: 'include',
    cache: 'no-store',
    body: JSON.stringify({ watermark, orientation, background }),
  });
  checkResponse(response);
  const blob = await response.blob();
  if (blob.type !== 'image/jpeg') {
    throw new PhotographyError('watermark_preview');
  }
  return blob;
}
