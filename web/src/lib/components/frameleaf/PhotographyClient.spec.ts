import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import {
  galleryRequest,
  galleryMedia,
  galleryFile,
  defaultPresentation,
  type GuestGallery,
} from '$lib/frameleaf/photography/workflow-api';
import PhotographyClient from './PhotographyClient.svelte';

vi.mock('$lib/frameleaf/photography/workflow-api', async (original) => ({
  ...(await original<typeof import('$lib/frameleaf/photography/workflow-api')>()),
  galleryRequest: vi.fn(),
  galleryMedia: vi.fn(),
  galleryFile: vi.fn(),
}));
const view: GuestGallery = {
  revision: 'loaded',
  title: 'The wedding collection',
  mode: 'select-before-editing',
  checkoutAvailable: false,
  chapters: [],
  photos: [
    {
      id: 'capture',
      number: 7,
      chapterId: null,
      status: 'selected',
      previewUrl: '/never-direct',
      thumbnailUrl: '/never-direct',
      canDownload: false,
      approvalRevisionId: null,
      blockedReason: 'order',
    },
  ],
  recipient: { id: 'recipient', name: 'Jamie', canDownload: false },
  choices: [],
  notes: [],
  rounds: [],
  orders: [],
  publication: { id: 'published', status: 'ready', completed: 1, total: 1, error: null },
  presentation: defaultPresentation,
  pricing: {
    currency: 'CAD',
    includedCount: 1,
    additionalPrice: 2500,
    collectionPrice: null,
    bundles: [],
    terms: 'Studio terms',
    selectionDeadline: null,
  },
  brand: {
    name: 'North Studio',
    tagline: 'Portraits & weddings',
    email: '',
    phone: '',
    color: '#577059',
    background: '#f5f3ed',
    textColor: '#263329',
    font: 'editorial',
    logoUrl: null,
  },
};
beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  history.replaceState(null, '', '/photography/gallery/shoot');
  sessionStorage.setItem(
    'photography-gallery:shoot',
    JSON.stringify({ session: 'scoped', expiresAt: new Date(Date.now() + 60_000).toISOString() }),
  );
  vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:protected-pixels');
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.mocked(galleryMedia).mockResolvedValue(new Blob(['jpeg'], { type: 'image/jpeg' }));
  vi.mocked(galleryRequest).mockResolvedValue(structuredClone(view));
});
it('saves the actual scoped capture choices and current server revision without exposing a source URL', async () => {
  render(PhotographyClient, { galleryId: 'shoot' });
  await screen.findByText('The wedding collection');
  await fireEvent.click(screen.getByRole('button', { name: 'Add photo 7 to favourites' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Save favourites' }));
  await waitFor(() =>
    expect(galleryRequest).toHaveBeenCalledWith('shoot', 'scoped', '/choices', 'PUT', {
      expectedRevision: 'loaded',
      captureIds: ['capture'],
      notes: [],
    }),
  );
  expect(document.querySelector('img[src="/never-direct"]')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
  expect(galleryMedia).toHaveBeenCalledWith('shoot', 'capture', 'preview', 'scoped');
});
it('drops protected images and the stored session when the server revokes access', async () => {
  render(PhotographyClient, { galleryId: 'shoot' });
  await screen.findByRole('img', { name: 'Photo 7' });
  vi.mocked(galleryRequest).mockRejectedValueOnce(
    Object.assign(new Error('Gallery access has ended.'), { status: 403 }),
  );
  await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('img', { name: 'Photo 7' })).toBeNull();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:protected-pixels');
  expect(sessionStorage.getItem('photography-gallery:shoot')).toBeNull();
});
it('requires acceptance of the quoted amount and terms before offering payment', async () => {
  const order = {
    id: 'order',
    recipientId: 'recipient',
    roundId: 'round',
    captureIds: ['capture'],
    status: 'quoted',
    currency: 'CAD',
    total: 2500,
    terms: 'Confirmed price',
    paymentTiming: 'before-editing',
    createdAt: new Date().toISOString(),
    acceptedAt: null,
    readyCount: 0,
    editingBlocked: true,
    items: [],
    pricing: { includedCount: 0, additionalPrice: 2500, collectionPrice: null, bundles: [], option: 'package' },
  };
  vi.mocked(galleryRequest).mockResolvedValueOnce({ ...structuredClone(view), orders: [order] });
  render(PhotographyClient, { galleryId: 'shoot' });
  const accept = await screen.findByRole('button', { name: 'Accept order & terms' });
  expect(screen.queryByRole('button', { name: 'Pay securely' })).toBeNull();
  await fireEvent.click(accept);
  await waitFor(() =>
    expect(galleryRequest).toHaveBeenCalledWith('shoot', 'scoped', '/orders/order/accept', 'POST', {
      expectedRevision: 'loaded',
    }),
  );
});

it('retains existing image annotations when saving a changed selection', async () => {
  const annotation = { x: 0.2, y: 0.3, width: 0.25, height: 0.2, text: 'Soften this area' };
  vi.mocked(galleryRequest).mockResolvedValueOnce({
    ...structuredClone(view),
    notes: [{ captureId: 'capture', text: 'Warm finish', annotations: [annotation] }],
  });
  render(PhotographyClient, { galleryId: 'shoot' });
  await screen.findByText('The wedding collection');
  await fireEvent.click(screen.getByRole('button', { name: 'Add photo 7 to favourites' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Save favourites' }));
  await waitFor(() =>
    expect(galleryRequest).toHaveBeenCalledWith('shoot', 'scoped', '/choices', 'PUT', {
      expectedRevision: 'loaded',
      captureIds: ['capture'],
      notes: [{ captureId: 'capture', text: 'Warm finish', annotations: [annotation] }],
    }),
  );
});
it('requests only the exact entitled selected outputs in a ZIP', async () => {
  const output = (id: string, kind: 'print' | 'web', canDownload: boolean) => ({
    id,
    label: kind,
    kind,
    revisionId: 'approved',
    approved: true,
    clientApprovalRequired: false,
    ready: true,
    renderStatus: 'ready' as const,
    branded: false,
    exportSpec: { format: 'jpeg' as const, quality: 90 as const, maxEdge: kind === 'print' ? 65_535 : 2048 },
    url: '/not-used',
    approvalPreviewUrl: null,
    canDownload,
    blockedReason: canDownload ? null : ('payment' as const),
  });
  const configured = {
    ...structuredClone(view),
    photos: [
      {
        ...view.photos[0],
        canDownload: true,
        outputs: [output('print-id', 'print', true), output('web-id', 'web', true), output('blocked-id', 'web', false)],
      },
    ],
  };
  vi.mocked(galleryRequest)
    .mockResolvedValueOnce(configured)
    .mockResolvedValueOnce({ id: 'zip-id' } as never);
  vi.mocked(galleryFile).mockResolvedValue(new Blob(['zip'], { type: 'application/zip' }));
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(PhotographyClient, { galleryId: 'shoot' });
  await screen.findByText('Choose your files');
  const sizes = screen.getAllByRole('checkbox');
  const web = sizes.find((element) => element.parentElement?.textContent?.includes('2048px'))!;
  await fireEvent.click(web);
  await fireEvent.click(screen.getByRole('button', { name: 'Download selected files' }));
  await waitFor(() =>
    expect(galleryRequest).toHaveBeenCalledWith('shoot', 'scoped', '/zip', 'POST', {
      outputs: [
        { captureId: 'capture', outputId: 'print-id' },
        { captureId: 'capture', outputId: 'web-id' },
      ],
    }),
  );
  expect(galleryFile).toHaveBeenCalledWith('shoot', 'scoped', '/zip/zip-id', true);
  expect(screen.queryByText('blocked-id')).toBeNull();
});
