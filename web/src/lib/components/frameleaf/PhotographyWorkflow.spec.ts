import '@testing-library/jest-dom/vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { loadBrand } from '$lib/frameleaf/photography/api';
import {
  workflowRequest,
  studioPresetsRequest,
  defaultPresentation,
  defaultWatermark,
  type Workflow,
} from '$lib/frameleaf/photography/workflow-api';
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
  watermarkPreview: vi.fn().mockResolvedValue(new Blob(['protected'], { type: 'image/jpeg' })),
}));
vi.mock('$lib/utils/file-uploader', () => ({ openFileUploadDialog: vi.fn() }));
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
