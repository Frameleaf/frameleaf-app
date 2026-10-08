import { render, screen, fireEvent, waitFor, within } from '@testing-library/svelte';
import { tick } from 'svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
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
beforeAll(() => addMessages('dev', en));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(galleryRequest).mockReset();
  vi.mocked(galleryFile).mockReset();
  vi.mocked(galleryMedia).mockReset();
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
  // no Save button to find: the favourite saves by itself a moment later, with a quiet status
  expect(screen.queryByRole('button', { name: /Save/ })).toBeNull();
  expect(screen.getByText('Saving…')).toBeInTheDocument();
  await waitFor(
    () =>
      expect(galleryRequest).toHaveBeenCalledWith('shoot', 'scoped', '/choices', 'PUT', {
        expectedRevision: 'loaded',
        captureIds: ['capture'],
        notes: [],
      }),
    { timeout: 3000 },
  );
  expect(await screen.findByText('Saved')).toBeInTheDocument();
  expect(document.querySelector('img[src="/never-direct"]')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
  expect(galleryMedia).toHaveBeenCalledWith('shoot', 'capture', 'preview', 'scoped');
});
it('saves at once in a request that outlives the page when the tab is hidden with unsaved choices', async () => {
  render(PhotographyClient, { galleryId: 'shoot' });
  await screen.findByText('The wedding collection');
  await fireEvent.click(screen.getByRole('button', { name: 'Add photo 7 to favourites' }));
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  try {
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() =>
      expect(galleryRequest).toHaveBeenCalledWith(
        'shoot',
        'scoped',
        '/choices',
        'PUT',
        { expectedRevision: 'loaded', captureIds: ['capture'], notes: [] },
        { keepalive: true },
      ),
    );
  } finally {
    visibility.mockRestore();
  }
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
  await waitFor(
    () =>
      expect(galleryRequest).toHaveBeenCalledWith('shoot', 'scoped', '/choices', 'PUT', {
        expectedRevision: 'loaded',
        captureIds: ['capture'],
        notes: [{ captureId: 'capture', text: 'Warm finish', annotations: [annotation] }],
      }),
    { timeout: 3000 },
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

it('replaces cached proofs only when the live published generation changes', async () => {
  const old = { ...structuredClone(view), publishedGenerationId: 'live-old' };
  const pending = { ...old, publication: { ...old.publication!, id: 'pending-new', status: 'pending' as const } };
  const ready = {
    ...pending,
    publishedGenerationId: 'live-new',
    publication: { ...pending.publication, status: 'ready' as const },
  };
  vi.mocked(galleryRequest).mockResolvedValueOnce(old).mockResolvedValueOnce(pending).mockResolvedValueOnce(ready);
  render(PhotographyClient, { galleryId: 'shoot' });
  await screen.findByRole('img', { name: 'Photo 7' });
  await waitFor(() => expect(galleryMedia).toHaveBeenCalledTimes(2));
  await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(galleryRequest).toHaveBeenCalledTimes(2));
  await tick();
  expect(URL.revokeObjectURL).not.toHaveBeenCalled();
  expect(galleryMedia).toHaveBeenCalledTimes(2);
  await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  await waitFor(() => expect(galleryMedia).toHaveBeenCalledTimes(4));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:protected-pixels');
});

it('keeps an exact historical preview when an earlier ordinary preview finishes late', async () => {
  let finishOrdinary!: (blob: Blob) => void;
  const ordinary = new Promise<Blob>((resolve) => {
    finishOrdinary = resolve;
  });
  const configured = structuredClone(view);
  configured.presentation = { ...configured.presentation, coverTreatment: 'quiet' };
  configured.photos[0].outputs = [
    {
      id: 'old-edit',
      label: 'Earlier edit',
      kind: 'print',
      revisionId: 'old-revision',
      approved: false,
      clientApprovalRequired: true,
      ready: false,
      renderStatus: 'awaiting-approval',
      branded: false,
      exportSpec: { format: 'jpeg', quality: 90, maxEdge: 65_535 },
      url: '/not-used',
      approvalPreviewUrl: '/protected-exact-preview',
      canDownload: false,
      blockedReason: 'approval',
    },
  ];
  vi.mocked(galleryRequest).mockResolvedValue(configured);
  vi.mocked(galleryMedia).mockImplementation(async (_gallery, _capture, kind) =>
    kind === 'preview' ? ordinary : new Blob(['thumb']),
  );
  const historical = new Blob(['old-edit'], { type: 'image/jpeg' });
  vi.mocked(galleryFile).mockResolvedValue(historical);
  vi.mocked(URL.createObjectURL).mockImplementation((blob) =>
    blob === historical ? 'blob:historical' : 'blob:ordinary',
  );
  render(PhotographyClient, { galleryId: 'shoot' });
  await fireEvent.click(await screen.findByRole('button', { name: 'View photo 7' }));
  await fireEvent.click(await screen.findByRole('button', { name: 'Review Earlier edit' }));
  const dialog = screen.getByRole('dialog');
  await waitFor(() =>
    expect(within(dialog).getByRole('img', { name: 'Photo 7' }).getAttribute('src')).toBe('blob:historical'),
  );
  finishOrdinary(new Blob(['ordinary'], { type: 'image/jpeg' }));
  await tick();
  expect(within(dialog).getByRole('img', { name: 'Photo 7' }).getAttribute('src')).toBe('blob:historical');
});

it('uses the saved explicit block order across pagination and keeps filtered-empty blocks empty', async () => {
  const configured = structuredClone(view);
  configured.photos = Array.from({ length: 100 }, (_, index) => ({
    ...view.photos[0],
    id: `capture-${index + 1}`,
    number: index + 1,
  }));
  configured.presentation = {
    ...configured.presentation,
    coverTreatment: 'quiet',
    blocks: [
      {
        id: 'pair',
        type: 'pair',
        chapterId: null,
        selection: 'explicit',
        captureIds: ['capture-100', 'capture-3'],
        text: '',
      },
      { id: 'empty', type: 'grid', chapterId: null, selection: 'explicit', captureIds: [], text: '' },
    ],
  };
  vi.mocked(galleryRequest).mockResolvedValue(configured);
  render(PhotographyClient, { galleryId: 'shoot' });
  await screen.findByRole('button', { name: 'View photo 100' });
  expect(
    screen.getAllByRole('button', { name: /^View photo/ }).map((button) => button.getAttribute('aria-label')),
  ).toEqual(['View photo 100', 'View photo 3']);
  await waitFor(() => expect(galleryMedia).toHaveBeenCalledWith('shoot', 'capture-100', 'thumbnail', 'scoped'));
});

it.each([false, true])('offers explicit bounded ZIP parts for 1500 photographs (outputs: %s)', async (outputs) => {
  const configured = structuredClone(view);
  configured.photos = Array.from({ length: 1500 }, (_, index) => ({
    ...view.photos[0],
    id: `capture-${index}`,
    number: index + 1,
    canDownload: true,
    ...(outputs && {
      outputs: [
        {
          id: `output-${index}`,
          label: 'Print',
          kind: 'print' as const,
          revisionId: 'approved',
          approved: true,
          clientApprovalRequired: false,
          ready: true,
          renderStatus: 'ready' as const,
          branded: false,
          exportSpec: { format: 'jpeg' as const, quality: 90 as const, maxEdge: 65_535 },
          url: '/not-used',
          approvalPreviewUrl: null,
          canDownload: true,
          blockedReason: null,
        },
      ],
    }),
  }));
  vi.mocked(galleryRequest)
    .mockResolvedValueOnce(configured)
    .mockResolvedValueOnce({ id: 'part-two' } as never);
  vi.mocked(galleryFile).mockResolvedValue(new Blob(['zip'], { type: 'application/zip' }));
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  render(PhotographyClient, { galleryId: 'shoot' });
  await fireEvent.click(await screen.findByRole('button', { name: 'Download part 2 (500 files)' }));
  await waitFor(() =>
    expect(galleryRequest).toHaveBeenCalledWith(
      'shoot',
      'scoped',
      '/zip',
      'POST',
      outputs
        ? {
            outputs: configured.photos
              .slice(1000)
              .map((photo) => ({ captureId: photo.id, outputId: photo.outputs![0].id })),
          }
        : { captureIds: configured.photos.slice(1000).map((photo) => photo.id) },
    ),
  );
  expect(galleryFile).toHaveBeenCalledWith('shoot', 'scoped', '/zip/part-two', true);
});
