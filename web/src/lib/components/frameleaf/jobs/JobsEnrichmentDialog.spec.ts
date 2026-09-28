import { getMachineLearningHardware, MachineLearningHardwareAcceleration } from '@immich/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import JobsEnrichmentDialog from '$lib/components/frameleaf/jobs/JobsEnrichmentDialog.svelte';
import type { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
import en from '../../../../../../i18n/en.json';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getMachineLearningHardware: vi.fn(),
}));

const draftStore = () =>
  ({
    draft: {
      machineLearning: {
        imageDescription: {
          acceleration: MachineLearningHardwareAcceleration.Auto,
          modelName: 'mine',
          fallbackModelName: 'my-fallback',
          device: 'GPU.1',
          enabled: true,
        },
        nsfwDetection: {
          modelName: 'my-sensitive',
          device: 'CPU',
          enabled: true,
          hideFromLibrary: false,
          threshold: 1,
        },
      },
    },
  }) as unknown as SystemConfigDraftStore;

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
});

describe('JobsEnrichmentDialog (JobsManager.jsx EnrichmentJobDialog)', () => {
  it("hands the template's actions to the review", async () => {
    const onReview = vi.fn();
    render(JobsEnrichmentDialog, { open: true, onReview, onReviewSettings: vi.fn() });
    const dialog = screen.getByRole('dialog', { name: 'Enrichment tasks' });

    await fireEvent.click(within(dialog).getByRole('button', { name: 'Review task' }));
    expect(onReview).toHaveBeenLastCalledWith({ type: 'description-requeue' });
  });

  it('offers every built-in category and the whole set', async () => {
    const onReview = vi.fn();
    render(JobsEnrichmentDialog, { open: true, onReview, onReviewSettings: vi.fn() });
    const dialog = screen.getByRole('dialog', { name: 'Enrichment tasks' });

    await fireEvent.change(within(dialog).getByLabelText('Task'), { target: { value: 'smart-albums' } });
    const categories = within(dialog).getByLabelText('Categories');
    expect(within(categories).getAllByRole('option')).toHaveLength(7);
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Review task' }));

    expect(onReview).toHaveBeenLastCalledWith({ type: 'smart-album' });
  });

  it('keeps the model choices on Auto while no hardware is known', async () => {
    vi.mocked(getMachineLearningHardware).mockRejectedValue(new Error('offline'));
    const store = draftStore();
    render(JobsEnrichmentDialog, { open: true, store, onReview: vi.fn(), onReviewSettings: vi.fn() });
    const dialog = screen.getByRole('dialog', { name: 'Enrichment tasks' });

    await fireEvent.change(within(dialog).getByLabelText('Task'), { target: { value: 'hardware' } });
    await waitFor(() => expect(getMachineLearningHardware).toHaveBeenCalled());
    expect(within(dialog).getByText(/No hardware has been detected here/)).toBeInTheDocument();
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Add preset to settings review' }));

    expect(store.draft.machineLearning.imageDescription?.modelName).toBe('mine');
    expect(within(dialog).getByRole('status')).toHaveTextContent('Preset added to pending settings.');
  });

  it('writes the CUDA preset into the settings draft and opens the model settings', async () => {
    vi.mocked(getMachineLearningHardware).mockResolvedValue({
      preferredAcceleration: MachineLearningHardwareAcceleration.Auto,
    } as never);
    const store = draftStore();
    const onReviewSettings = vi.fn();
    render(JobsEnrichmentDialog, { open: true, store, onReview: vi.fn(), onReviewSettings });
    const dialog = screen.getByRole('dialog', { name: 'Enrichment tasks' });

    await fireEvent.change(within(dialog).getByLabelText('Task'), { target: { value: 'hardware' } });
    await fireEvent.change(within(dialog).getByLabelText('Acceleration'), { target: { value: 'cuda' } });
    expect(within(dialog).getByText(/The preset selects Qwen2.5-VL 3B/)).toBeInTheDocument();
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Add preset to settings review' }));

    const { imageDescription, nsfwDetection } = store.draft.machineLearning;
    expect(imageDescription).toMatchObject({
      acceleration: 'cuda',
      modelName: 'Qwen/Qwen2.5-VL-3B-Instruct',
      fallbackModelName: 'microsoft/Florence-2-base-ft',
      device: 'AUTO',
    });
    expect(nsfwDetection).toMatchObject({ modelName: 'onnx-community/nsfw_image_detection-ONNX', device: 'AUTO' });

    await fireEvent.click(within(dialog).getByRole('button', { name: 'Review model settings' }));
    expect(onReviewSettings).toHaveBeenCalled();
  });
});
