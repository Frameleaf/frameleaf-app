import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { loadBrand } from '$lib/frameleaf/photography/api';
import {
  galleryPreviewSession,
  workflowRequest,
  studioPresetsRequest,
  defaultPresentation,
  defaultWatermark,
  type Workflow,
} from '$lib/frameleaf/photography/workflow-api';
import { fileUploadHandler } from '$lib/utils/file-uploader';
import PhotographyWorkflow from './PhotographyWorkflow.svelte';

vi.mock('$lib/frameleaf/photography/api', async (original) => ({
  ...(await original<typeof import('$lib/frameleaf/photography/api')>()),
  loadBrand: vi.fn(),
  loadLogos: vi.fn().mockResolvedValue({ logos: [], nextCursor: null }),
}));
vi.mock('$lib/frameleaf/photography/workflow-api', async (original) => ({
  ...(await original<typeof import('$lib/frameleaf/photography/workflow-api')>()),
  workflowRequest: vi.fn(),
  studioPresetsRequest: vi.fn(),
  galleryPreviewSession: vi.fn(),
  watermarkPreview: vi.fn().mockResolvedValue(new Blob(['protected'], { type: 'image/jpeg' })),
}));
vi.mock('$lib/utils/file-uploader', () => ({ openFileUploadDialog: vi.fn(), fileUploadHandler: vi.fn() }));
vi.mock('$lib/managers/server-config-manager.svelte', () => ({
  serverConfigManager: { value: { externalDomain: '' } },
}));
beforeAll(() => addMessages('dev', en));
const shoot = {
  id: 'shoot',
  albumId: 'album',
  name: 'Portraits',
  client: 'Jamie',
  type: 'Portrait',
  date: '2026-10-02',
  stage: 'Imported',
  unavailable: false,
  coverAssetId: null,
  assetCount: 1,
} as const;
const workflow = {
  revision: 'gallery-revision',
  shootId: 'shoot',
  config: {
    title: 'Portraits',
    mode: 'sell-by-photo',
    paymentTiming: 'before-editing',
    currency: 'CAD',
    includedCount: 1,
    additionalPrice: 2500,
    collectionPrice: null,
    bundles: [],
    terms: '',
    selectionDeadline: null,
    expiresAt: null,
    turnaroundDays: 7,
    proofWatermark: defaultWatermark('North Studio', true),
    webWatermark: null,
    downloadWatermark: null,
    presentation: defaultPresentation,
  },
  captures: [
    {
      id: 'capture',
      number: 1,
      assetId: 'asset',
      assetIds: ['asset'],
      fileName: 'photo.CR3',
      camera: 'Camera',
      capturedAt: null,
      offsetSeconds: 42,
      photographer: 'Avery',
      chapterId: null,
      position: 0,
      withheld: false,
      rating: 4,
      isRaw: true,
      eligible: true,
      exclusion: null,
      processing: 'ready',
      proofRevisionId: null,
      approvedRevisionId: null,
      state: 'proof',
    },
  ],
  chapters: [{ id: 'chapter', title: 'Portraits', description: '', position: 0, coverCaptureId: null }],
  presets: [],
  studioPresets: { revision: 'studio-revision', presets: [] },
  approvedVersions: [],
  pendingEdits: 0,
  recipients: [],
  rounds: [],
  orders: [],
  publication: null,
  ordering: 'chronological',
  approvals: [],
  receipts: [],
} satisfies Workflow;
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(workflowRequest).mockResolvedValue(structuredClone(workflow));
  vi.mocked(loadBrand).mockResolvedValue({
    revision: null,
    logoUnavailable: false,
    brand: { name: 'North Studio' },
  } as never);
});
it('saves human-readable prices in integer minor units and a studio preset with the separate studio revision', async () => {
  vi.mocked(studioPresetsRequest).mockResolvedValue({ revision: 'saved-preset', presets: [] });
  render(PhotographyWorkflow, { shoot, panel: 'workflow' });
  const price = await screen.findByRole('spinbutton', { name: 'Additional photo price' });
  expect(price).toHaveValue(25);
  await fireEvent.change(price, { target: { value: '39.95' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Save client workflow' }));
  await waitFor(() =>
    expect(workflowRequest).toHaveBeenCalledWith(
      'shoot',
      '/config',
      'PUT',
      expect.objectContaining({
        expectedRevision: 'gallery-revision',
        config: expect.objectContaining({ additionalPrice: 3995 }),
      }),
    ),
  );
  await fireEvent.input(screen.getByRole('textbox', { name: 'Preset name' }), { target: { value: 'Portrait sales' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Save studio preset' }));
  await waitFor(() =>
    expect(studioPresetsRequest).toHaveBeenCalledWith(
      'POST',
      expect.objectContaining({ expectedRevision: 'studio-revision', id: null, name: 'Portrait sales' }),
    ),
  );
});
it('assigns a chapter without overwriting existing photographer or camera-clock values', async () => {
  render(PhotographyWorkflow, { shoot, panel: 'intake' });
  await screen.findByRole('heading', { name: 'Assemble selected captures' });
  await fireEvent.click(screen.getByRole('button', { name: 'Select the available captures shown' }));
  const chapter = screen
    .getAllByRole('combobox', { name: 'Chapter' })
    .find((element) => [...(element as HTMLSelectElement).options].some((option) => option.value === '__unchanged'))!;
  await fireEvent.change(chapter, { target: { value: 'chapter' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Apply to 1 capture' }));
  await fireEvent.click(screen.getAllByRole('button', { name: 'Save assembly' })[0]);
  await waitFor(() =>
    expect(workflowRequest).toHaveBeenCalledWith(
      'shoot',
      '/assembly',
      'PUT',
      expect.objectContaining({
        captures: [
          expect.objectContaining({ id: 'capture', chapterId: 'chapter', photographer: 'Avery', offsetSeconds: 42 }),
        ],
      }),
    ),
  );
});
it('saves reordered explicit story photos and requires an explicit reset to the assembled sequence', async () => {
  const configured: Workflow = structuredClone(workflow);
  configured.captures.push({
    ...configured.captures[0],
    id: 'second',
    number: 2,
    assetId: 'asset-2',
    assetIds: ['asset-2'],
  });
  configured.config.presentation.blocks = [
    { id: 'pair', type: 'pair', chapterId: null, selection: 'explicit', captureIds: ['capture', 'second'], text: '' },
  ];
  vi.mocked(workflowRequest).mockResolvedValue(configured);
  render(PhotographyWorkflow, { shoot, panel: 'presentation' });
  await fireEvent.click(await screen.findByText('Photographs (2)'));
  await fireEvent.click(screen.getByRole('button', { name: 'Move selected photo 2 earlier' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Save presentation' }));
  await waitFor(() =>
    expect(workflowRequest).toHaveBeenCalledWith(
      'shoot',
      '/config',
      'PUT',
      expect.objectContaining({
        config: expect.objectContaining({
          presentation: expect.objectContaining({
            blocks: [expect.objectContaining({ selection: 'explicit', captureIds: ['second', 'capture'] })],
          }),
        }),
      }),
    ),
  );
  await fireEvent.click(screen.getByRole('button', { name: 'Use assembled sequence' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Save presentation' }));
  await waitFor(() =>
    expect(workflowRequest).toHaveBeenLastCalledWith(
      'shoot',
      '/config',
      'PUT',
      expect.objectContaining({
        config: expect.objectContaining({
          presentation: expect.objectContaining({
            blocks: [expect.objectContaining({ selection: 'automatic', captureIds: [] })],
          }),
        }),
      }),
    ),
  );
});
it('starts the client workflow with the three ways of working and saves the one chosen', async () => {
  render(PhotographyWorkflow, { shoot, panel: 'workflow' });
  const journeys = await screen.findByRole('group', { name: 'Choose the client journey' });
  const sell = within(journeys).getByRole('button', { name: /Sell by the photograph/ });
  expect(sell).toHaveAttribute('aria-pressed', 'true');
  await fireEvent.click(within(journeys).getByRole('button', { name: /Edited delivery/ }));
  expect(within(journeys).getByRole('button', { name: /Edited delivery/ })).toHaveAttribute('aria-pressed', 'true');
  expect(sell).toHaveAttribute('aria-pressed', 'false');
  await fireEvent.click(screen.getByRole('button', { name: 'Save client workflow' }));
  await waitFor(() =>
    expect(workflowRequest).toHaveBeenCalledWith(
      'shoot',
      '/config',
      'PUT',
      expect.objectContaining({ config: expect.objectContaining({ mode: 'edited-delivery' }) }),
    ),
  );
});
it('opens the published gallery as the client sees it from Client preview', async () => {
  const published: Workflow = {
    ...structuredClone(workflow),
    publication: { id: 'live', status: 'ready', completed: 1, total: 1, error: null },
  };
  vi.mocked(workflowRequest).mockResolvedValue(published);
  vi.mocked(galleryPreviewSession).mockResolvedValue({ session: 'look', expiresAt: '2026-10-16T12:00:00.000Z' });
  const tab = { opener: {}, closed: false, location: { href: '' }, close: vi.fn() };
  const open = vi.spyOn(globalThis, 'open').mockReturnValue(tab as unknown as Window);
  render(PhotographyWorkflow, { shoot, panel: 'orders', onSection: vi.fn() });
  await screen.findByText(/1 eligible proof/);
  await fireEvent.click(screen.getByRole('button', { name: 'Client preview' }));
  await waitFor(() => expect(tab.location.href).toContain('/photography/gallery/shoot#preview=look'));
  expect(galleryPreviewSession).toHaveBeenCalledWith('shoot');
  expect(tab.opener).toBeNull();
  open.mockRestore();
});
it('saves the welcome message, reminders, selection limit and proof collection with the workflow', async () => {
  render(PhotographyWorkflow, { shoot, panel: 'workflow' });
  await fireEvent.input(await screen.findByRole('textbox', { name: 'Welcome message' }), {
    target: { value: 'Take your time.' },
  });
  await fireEvent.click(screen.getByRole('checkbox', { name: 'Selection reminder' }));
  await fireEvent.click(screen.getByRole('checkbox', { name: 'Let guests find their photos with a selfie' }));
  await fireEvent.change(screen.getByRole('spinbutton', { name: 'Maximum client selections' }), {
    target: { value: '25' },
  });
  await fireEvent.change(screen.getByRole('combobox', { name: /Proof collection/ }), { target: { value: 'selected' } });
  await fireEvent.click(screen.getByRole('button', { name: 'Save client workflow' }));
  await waitFor(() =>
    expect(workflowRequest).toHaveBeenCalledWith(
      'shoot',
      '/config',
      'PUT',
      expect.objectContaining({
        config: expect.objectContaining({
          welcomeMessage: 'Take your time.',
          selfieSearch: true,
          reminders: { selection: true, paymentAndExpiry: false },
          maxSelections: 25,
          proofCollection: 'selected',
        }),
      }),
    ),
  );
});
it('emails an invitation when an address is given and says so', async () => {
  vi.mocked(workflowRequest).mockImplementation(async (_id, path) =>
    path === '/recipients'
      ? ({
          workflow: structuredClone(workflow),
          invitation: { recipientId: 'r', token: 'secret', emailed: true },
        } as never)
      : (structuredClone(workflow) as never),
  );
  render(PhotographyWorkflow, { shoot, panel: 'publishing' });
  await fireEvent.input(await screen.findByRole('textbox', { name: 'Email (optional)' }), {
    target: { value: 'jamie@example.com' },
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Create invitation' }));
  await waitFor(() =>
    expect(workflowRequest).toHaveBeenCalledWith(
      'shoot',
      '/recipients',
      'POST',
      expect.objectContaining({ email: 'jamie@example.com' }),
    ),
  );
  expect(await screen.findByText(/Invitation emailed to jamie@example.com/)).toBeInTheDocument();
});
it('saves the shoot brief through the workspace', async () => {
  const onSaveBrief = vi.fn().mockResolvedValue(true);
  render(PhotographyWorkflow, { shoot, panel: 'intake', onSaveBrief });
  await fireEvent.input(await screen.findByRole('textbox', { name: 'Client notes' }), {
    target: { value: 'Grandparents first.' },
  });
  await fireEvent.click(screen.getByRole('button', { name: 'Save brief' }));
  expect(onSaveBrief).toHaveBeenCalledWith({ notes: 'Grandparents first.', deliveryTarget: null });
});
it('shows the running total by currency and, before any selection, leads to the client preview', async () => {
  const ordered: Workflow = structuredClone(workflow);
  const order = (id: string, total: number, status: string) => ({
    id,
    recipientId: 'r',
    roundId: null,
    captureIds: [],
    status,
    currency: 'CAD',
    total,
    terms: '',
    paymentTiming: 'after-approval',
    createdAt: '2026-11-01T00:00:00Z',
    acceptedAt: null,
    readyCount: 0,
    editingBlocked: false,
    items: [],
    pricing: { includedCount: 0, additionalPrice: 0, collectionPrice: null, bundles: [], option: 'package' },
  });
  ordered.orders = [order('o1', 2500, 'quoted'), order('o2', 1000, 'cancelled')];
  vi.mocked(workflowRequest).mockResolvedValue(ordered);
  const onSection = vi.fn();
  render(PhotographyWorkflow, { shoot, panel: 'orders', onSection });
  expect(await screen.findByRole('heading', { name: 'Waiting for the first selection' })).toBeInTheDocument();
  expect(screen.getByText('Order total so far').closest('p')).toHaveTextContent('25.00');
  await fireEvent.click(screen.getByRole('button', { name: 'Configure the package' }));
  expect(onSection).toHaveBeenCalledWith('workflow');
});
it('uploads photographs dropped on the intake zone into the shoot, then reads it again', async () => {
  vi.mocked(fileUploadHandler).mockResolvedValue([]);
  render(PhotographyWorkflow, { shoot, panel: 'intake' });
  const zone = await screen.findByRole('button', { name: /Add photographs or a camera folder/ });
  const file = new File(['x'], 'IMG_1.CR3');
  await fireEvent.drop(zone, { dataTransfer: { files: [file], types: ['Files'] } });
  await waitFor(() => expect(fileUploadHandler).toHaveBeenCalledWith({ files: [file], albumId: 'album' }));
  await waitFor(() => expect(workflowRequest).toHaveBeenCalledWith('shoot', '/intake', 'POST', expect.anything()));
});
it('lays the Gallery out as the client sees it, with the settings beside it', async () => {
  const shared: Workflow = structuredClone(workflow);
  shared.config.maxSelections = 3;
  shared.recipients = [
    {
      id: 'r',
      name: 'Jamie',
      revoked: false,
      passwordProtected: true,
      choices: ['capture'],
      canProof: true,
      canDownload: false,
      expiresAt: null,
      captureIds: null,
    },
  ];
  vi.mocked(workflowRequest).mockResolvedValue(shared);
  render(PhotographyWorkflow, { shoot, panel: 'publishing' });
  expect(await screen.findByText('Password protected')).toBeInTheDocument();
  expect(screen.getByText(/1 of 3 selected/)).toBeInTheDocument();
  const settings = screen.getByRole('complementary', { name: 'Gallery settings' });
  expect(within(settings).getByRole('button', { name: 'Create invitation' })).toBeInTheDocument();
  await fireEvent.change(within(settings).getByRole('spinbutton', { name: 'Selection limit' }), {
    target: { value: '5' },
  });
  await fireEvent.click(within(settings).getByRole('button', { name: 'Save gallery settings' }));
  await waitFor(() =>
    expect(workflowRequest).toHaveBeenCalledWith(
      'shoot',
      '/config',
      'PUT',
      expect.objectContaining({ config: expect.objectContaining({ maxSelections: 5 }) }),
    ),
  );
});
