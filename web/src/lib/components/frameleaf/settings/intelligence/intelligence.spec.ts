import {
  ClassificationRuleAction,
  MachineLearningHardwareAcceleration,
  PlaceholderValidation,
  QueueName,
  Style,
  type AdminConfigDto,
  type EnrichmentOptionsResponseDto,
  type ImageDescriptionRequeueEstimateDto,
  type QueueResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
import en from '../../../../../../../i18n/en.json';
import Descriptions from './Descriptions.svelte';
import Faces from './Faces.svelte';
import LockedDetection from './LockedDetection.svelte';
import SearchLanding from './SearchLanding.svelte';
import SmartAlbums from './SmartAlbums.svelte';
import TextInPhotos from './TextInPhotos.svelte';
import VisualSearch from './VisualSearch.svelte';
import Words from './Words.svelte';

const draft = vi.hoisted(() => ({ store: undefined as unknown }));
const flags = vi.hoisted(() => ({ configFile: false }));
const address = vi.hoisted(() => ({ url: new URL('http://localhost/user-settings?area=intelligence') }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({ featureFlagsManager: { value: flags } }));
vi.mock('$lib/frameleaf/system-config-draft.svelte', async (original) => ({
  ...(await original<object>()),
  requireSystemConfigDraft: () => draft.store,
}));
vi.mock('$app/state', () => ({
  page: {
    get url() {
      return address.url;
    },
  },
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

const album = (name: string) => ({ enabled: true, name, tagTriggers: ['airport'], clipQueries: [], threshold: 0.28 });

const config = () =>
  ({
    machineLearning: {
      enabled: true,
      urls: ['http://frameleaf-machine-learning:3003'],
      availabilityChecks: { enabled: true, interval: 30_000, timeout: 2000 },
      clip: {
        enabled: true,
        modelName: 'ViT-B-16-SigLIP-384__webli',
        zeroShotTagging: { enabled: true, minSimilarity: 0.25, maxTags: 6 },
      },
      duplicateDetection: {},
      facialRecognition: { enabled: true, modelName: 'buffalo_l', minScore: 0.7, maxDistance: 0.5, minFaces: 3 },
      ocr: {
        enabled: true,
        modelName: 'PP-OCRv5_mobile',
        minDetectionScore: 0.5,
        minRecognitionScore: 0.8,
        maxResolution: 736,
        documentFields: false,
      },
      imageDescription: {
        enabled: true,
        acceleration: MachineLearningHardwareAcceleration.Auto,
        modelName: 'Qwen/Qwen2.5-VL-3B-Instruct',
        fallbackModelName: 'microsoft/Florence-2-base-ft',
        device: 'AUTO',
        videoMomentCaptions: false,
        prompt: {
          style: Style.Balanced,
          sentenceCountTarget: 3,
          lookFor: ['signs'],
          customVocabulary: [],
          customInstructions: '',
          nsfwIndicators: [],
          medicalIndicators: [],
          forbiddenInferences: [],
          identityInjection: { enabled: true, maxNames: 5, minFaceConfidence: 0.7 },
          advanced: { enabled: false, rawPromptTemplate: '', placeholderValidation: PlaceholderValidation.Strict },
        },
        pendingRequeueAt: null,
        lastConfigChangeAt: null,
      },
      nsfwDetection: {
        enabled: true,
        hideFromLibrary: true,
        modelName: 'onnx-community/nsfw_image_detection-ONNX',
        threshold: 0.85,
        device: 'AUTO',
      },
    },
    metadata: { faces: { import: false } },
    localFeatures: { askSearch: { enabled: true, maxResults: 100 } },
    libraryCare: { manualMetadata: true },
    smartAlbums: {
      enabled: true,
      rules: { visualCategories: true, defaultAction: ClassificationRuleAction.Review },
      builtIn: {
        travel: album('Travel'),
        documents: album('Documents'),
        food: { ...album('Food'), enabled: false },
        pets: album('Pets'),
        nature: album('Nature'),
        screenshots: { ...album('Screenshots'), enabled: false },
      },
    },
  }) as unknown as AdminConfigDto;

const useDraft = () => {
  const store = new SystemConfigDraftStore(
    { config: config(), revision: 'r1' },
    { defaults: config(), load: vi.fn(), save: vi.fn() },
  );
  draft.store = store;
  return store;
};

const queue = (name: QueueName, waiting: number) =>
  ({
    name,
    isPaused: false,
    hasUnfinishedWork: waiting > 0,
    statistics: { active: 0, waiting, paused: 0, delayed: 0, failed: 0, completed: 0 },
  }) as QueueResponseDto;

beforeAll(() => addMessages('dev', en));
beforeEach(() => {
  flags.configFile = false;
  address.url = new URL('http://localhost/user-settings?area=intelligence');
  sdkMock.getQueues.mockResolvedValue([]);
  sdkMock.getWorkerInventory.mockResolvedValue({ entries: [], machineLearningEnabled: true } as never);
  sdkMock.getImageDescriptionRequeueEstimate.mockResolvedValue({
    totalAssets: 100,
    withDescription: 100,
    withoutDescription: 0,
    estimatedTotalSeconds: 7200,
    rollingAvgSeconds: 72,
    activeBackend: 'auto',
    activeModel: 'Qwen/Qwen2.5-VL-3B-Instruct',
  } as ImageDescriptionRequeueEstimateDto);
  sdkMock.getEnrichmentOptions.mockResolvedValue({ framesPerVideo: 6 } as EnrichmentOptionsResponseDto);
  sdkMock.getMachineLearningHardware.mockResolvedValue({
    preferredAcceleration: MachineLearningHardwareAcceleration.Cuda,
  } as never);
});

describe('Search & intelligence landing', () => {
  it('says what is waiting, and the one switch turns everything off', async () => {
    sdkMock.getQueues.mockResolvedValue([queue(QueueName.SmartSearch, 120)]);
    const store = useDraft();
    render(SearchLanding, { sections: [] });

    expect(await screen.findByText(/120 photos are still waiting to be read/)).toBeInTheDocument();
    expect(screen.getByText('120 to read')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('switch', { name: 'Search and recognition' }));
    expect(store.draft.machineLearning.enabled).toBe(false);
    expect(screen.getByRole('heading', { name: 'Search and recognition are off' })).toBeInTheDocument();
    expect(screen.getAllByText('Comes back with the switch above')).toHaveLength(6);
  });

  it('turns one feature off by itself and links to its page', async () => {
    const store = useDraft();
    render(SearchLanding, { sections: [] });

    await fireEvent.click(screen.getByRole('switch', { name: 'Faces & identity' }));
    expect(store.draft.machineLearning.facialRecognition.enabled).toBe(false);
    expect(screen.getByRole('link', { name: 'Open Visual search' })).toHaveAttribute(
      'href',
      expect.stringContaining('section=smart-search'),
    );
  });

  it('keeps the helper address and the checks editable, in seconds', async () => {
    const store = useDraft();
    render(SearchLanding, { sections: [] });

    const every = screen.getByRole('spinbutton', { name: 'Checked every' });
    expect(every).toHaveValue(30);
    await fireEvent.input(every, { target: { value: '45' } });
    expect(store.draft.machineLearning.availabilityChecks.interval).toBe(45_000);

    await fireEvent.click(screen.getByRole('button', { name: 'Add address' }));
    expect(store.draft.machineLearning.urls).toHaveLength(2);
  });
});

describe('Visual search', () => {
  it('writes the search model for a quality and says the library is read again', async () => {
    const store = useDraft();
    render(VisualSearch);

    await fireEvent.click(screen.getByRole('button', { name: 'Most accurate' }));
    expect(store.draft.machineLearning.clip.modelName).toBe('ViT-SO400M-16-SigLIP2-384__webli');
    expect(screen.getByText('Saving this means reading all photos and videos again')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(store.draft.machineLearning.clip.modelName).toBe('ViT-B-16-SigLIP-384__webli');
  });

  it('says how long reading again takes and starts it from the save (FL-521)', async () => {
    const store = useDraft();
    const saveKeys = vi.spyOn(store, 'saveKeys').mockResolvedValue(true);
    sdkMock.getLibraryProgress.mockResolvedValue({
      measuredSince: '2026-10-22T08:00:00.000Z',
      features: [{ feature: 'search' as never, done: 1000, total: 4000, perHour: 2000, secondsLeft: 5400 }],
    });
    sdkMock.redoLibraryWork.mockResolvedValue({ tonight: [] });
    render(VisualSearch);

    await fireEvent.click(screen.getByRole('button', { name: 'Most accurate' }));
    expect(
      await screen.findByText('Saving this reads all 4,000 photos and videos again, about 2 hours'),
    ).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Save and start now' }));
    expect(saveKeys).toHaveBeenCalledWith(['machineLearning']);
    expect(sdkMock.redoLibraryWork).toHaveBeenCalledWith({ libraryRedoDto: { queue: 'smartSearch', when: 'now' } });
    expect(await screen.findByText(/Saved. Reading has started/)).toBeInTheDocument();
  });

  it('shows a model outside the three choices as Custom', async () => {
    const store = useDraft();
    store.draft.machineLearning.clip.modelName = 'my-model';
    render(VisualSearch);

    expect(screen.getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('Faces & identity', () => {
  it('writes the three numbers for a grouping and moves the people-tags switch here', async () => {
    const store = useDraft();
    render(Faces);

    await fireEvent.click(screen.getByRole('button', { name: 'Fewer mistakes' }));
    expect(store.draft.machineLearning.facialRecognition).toMatchObject({
      maxDistance: 0.4,
      minScore: 0.8,
      minFaces: 5,
    });
    expect(screen.getByText(/someone appears after 5 clear photos/)).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('switch', { name: 'Use people tags saved by other apps' }));
    expect(store.draft.metadata.faces.import).toBe(true);
  });
});

describe('Text, documents & receipts', () => {
  it('picks the model by language and writes the scores and the detail', async () => {
    const store = useDraft();
    render(TextInPhotos);

    await fireEvent.change(screen.getByRole('combobox', { name: 'Languages to read' }), {
      target: { value: 'korean' },
    });
    expect(store.draft.machineLearning.ocr.modelName).toBe('KOREAN__PP-OCRv5_mobile');

    await fireEvent.click(screen.getByRole('button', { name: 'Faint text too' }));
    expect(store.draft.machineLearning.ocr).toMatchObject({ minDetectionScore: 0.3, minRecognitionScore: 0.6 });

    await fireEvent.click(screen.getByRole('switch', { name: 'Read small print' }));
    expect(store.draft.machineLearning.ocr.maxResolution).toBe(1280);
  });
});

describe('Locked-content detection', () => {
  it('writes the number for how cautious to be, and links to Locked', async () => {
    const store = useDraft();
    render(LockedDetection);

    expect(screen.queryByText(/NSFW/)).not.toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Only the obvious' }));
    expect(store.draft.machineLearning.nsfwDetection?.threshold).toBe(0.95);
    expect(screen.getByRole('button', { name: 'Locked content' })).toBeInTheDocument();
  });
});

describe('Descriptions & tags', () => {
  it('opens on the server’s caption counts and writes a caption length', async () => {
    sdkMock.getImageDescriptionRequeueEstimate.mockResolvedValue({
      totalAssets: 100,
      withDescription: 40,
      withoutDescription: 60,
      estimatedTotalSeconds: 7200,
    } as ImageDescriptionRequeueEstimateDto);
    const store = useDraft();
    render(Descriptions);

    expect(await screen.findByRole('heading', { name: '40 of 100 photos have captions' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Short' }));
    expect(store.draft.machineLearning.imageDescription?.prompt).toMatchObject({
      style: Style.Terse,
      sentenceCountTarget: 1,
    });
    expect(await screen.findByText(/takes about 2 hours at the recent pace/)).toBeInTheDocument();
  });

  it('turns Describe moments in videos on in the draft, with the server’s frame count (FL-59)', async () => {
    const store = useDraft();
    render(Descriptions);

    const toggle = screen.getByRole('switch', { name: 'Describe moments in videos' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(await screen.findByText(/Adds captions to 6 moments in each video/)).toBeInTheDocument();
    await fireEvent.click(toggle);
    expect(store.draft.machineLearning.imageDescription?.videoMomentCaptions).toBe(true);
  });

  it('writes sample captions in place with the choices on the page, saving nothing (FL-537)', async () => {
    sdkMock.searchAssets.mockResolvedValue({
      assets: { items: [{ id: 'photo-1', thumbhash: null }] },
    } as never);
    sdkMock.previewEnrichment.mockResolvedValue({
      cloud: false,
      destinationId: 'local',
      destinationName: 'This server',
      modelName: 'model',
      samples: [
        {
          assetId: 'photo-1',
          candidate: 'A person paddles a yellow kayak across a calm lake.',
          tags: ['kayak', 'lake'],
          status: 'success',
        },
      ],
    } as never);
    useDraft();
    render(Descriptions);

    await fireEvent.click(screen.getByRole('button', { name: 'Short' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Try it' }));
    expect(await screen.findByText('A person paddles a yellow kayak across a calm lake.')).toBeInTheDocument();
    expect(screen.getByText('Tags: kayak, lake')).toBeInTheDocument();
    expect(sdkMock.previewEnrichment).toHaveBeenCalledWith({
      enrichmentPreviewRequestDto: expect.objectContaining({
        assetIds: ['photo-1'],
        prompt: expect.objectContaining({ style: Style.Terse, sentenceCountTarget: 1 }),
      }),
    });

    // a changed choice offers to write them again
    await fireEvent.click(screen.getByRole('button', { name: 'Detailed' }));
    expect(screen.getByRole('button', { name: 'Try again with these choices' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Hide the try-out' }));
    expect(screen.queryByText('Tags: kayak, lake')).not.toBeInTheDocument();
  });

  it('adds a thing to look out for and writes the number of tags', async () => {
    const store = useDraft();
    render(Descriptions);

    const look = screen.getByRole('group', { name: 'Things to look out for' });
    await fireEvent.input(within(look).getByRole('textbox'), { target: { value: 'landmarks' } });
    await fireEvent.click(within(look).getByRole('button', { name: 'Add' }));
    expect(store.draft.machineLearning.imageDescription?.prompt?.lookFor).toEqual(['signs', 'landmarks']);

    await fireEvent.click(screen.getByRole('button', { name: 'More tags' }));
    expect(store.draft.machineLearning.clip.zeroShotTagging).toMatchObject({ minSimilarity: 0.18, maxTags: 12 });
  });
});

describe('Categories & smart albums', () => {
  it('says which albums fill themselves and offers each one by its switch', async () => {
    const store = useDraft();
    render(SmartAlbums);

    expect(screen.getByRole('heading', { name: '4 smart albums are filling themselves' })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('switch', { name: 'Offer Food' }));
    expect(store.draft.smartAlbums?.builtIn.food.enabled).toBe(true);

    await fireEvent.click(screen.getByRole('button', { name: 'Tag it automatically' }));
    expect(store.draft.smartAlbums?.rules?.defaultAction).toBe(ClassificationRuleAction.Tag);
  });

  it('opens one album from the address and splits its words into tags and descriptions', async () => {
    address.url = new URL('http://localhost/user-settings?area=intelligence&section=smart-albums&album=travel');
    const store = useDraft();
    render(SmartAlbums);

    expect(screen.getByRole('heading', { name: 'Travel is offered' })).toBeInTheDocument();
    const words = screen.getByRole('group', { name: 'Words that add a photo' });
    await fireEvent.input(within(words).getByRole('textbox'), { target: { value: 'boarding pass' } });
    await fireEvent.click(within(words).getByRole('button', { name: 'Add' }));
    expect(store.draft.smartAlbums?.builtIn.travel).toMatchObject({
      tagTriggers: ['airport'],
      clipQueries: ['boarding pass'],
    });

    await fireEvent.click(screen.getByRole('button', { name: 'More photos' }));
    expect(store.draft.smartAlbums?.builtIn.travel.threshold).toBe(0.24);
    expect(screen.getByText('These choices apply to photos added from now on')).toBeInTheDocument();
  });

  it('says how many photos each album holds and how many people show it (FL-522)', async () => {
    address.url = new URL('http://localhost/user-settings?area=intelligence&section=smart-albums');
    sdkMock.getSmartAlbumOverview.mockResolvedValue({
      people: 3,
      albums: [{ kind: 'travel', count: 2140, people: 3, hiddenBy: 1, samples: ['a1'] }],
    });
    useDraft();
    render(SmartAlbums);

    expect(await screen.findByText('2,140 photos')).toBeInTheDocument();
    expect(screen.getByText('2 of 3 people show it')).toBeInTheDocument();
  });

  it('shows what a change would add and take out before saving (FL-522)', async () => {
    address.url = new URL('http://localhost/user-settings?area=intelligence&section=smart-albums&album=travel');
    sdkMock.previewSmartAlbumRule.mockResolvedValue({
      current: 10,
      matched: 12,
      adds: 3,
      removes: 1,
      addSamples: ['a1'],
      removeSamples: ['r1'],
      looksChecked: true,
    });
    useDraft();
    render(SmartAlbums);

    await fireEvent.click(screen.getByRole('button', { name: 'More photos' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Show me' }));
    expect(sdkMock.previewSmartAlbumRule).toHaveBeenCalledWith({
      smartAlbumPreviewDto: expect.objectContaining({ kind: 'travel', threshold: 0.24 }),
    });
    expect(
      await screen.findByText(/3 photos would join and 1 would leave, so the album would hold 12 photos/),
    ).toBeInTheDocument();
  });

  it('lets each person hide an album from their own library (FL-522)', async () => {
    address.url = new URL('http://localhost/user-settings?area=intelligence&section=smart-albums');
    const album = { kind: 'pets', name: 'Pets', albumId: 'p1', count: 40, samples: [], hidden: false };
    sdkMock.getMySmartAlbums.mockResolvedValue({ enabled: true, albums: [album] });
    sdkMock.setMySmartAlbumHidden.mockResolvedValue({ enabled: true, albums: [{ ...album, hidden: true }] });
    useDraft();
    render(SmartAlbums);

    await fireEvent.click(await screen.findByRole('switch', { name: 'Show Pets in my library' }));
    expect(sdkMock.setMySmartAlbumHidden).toHaveBeenCalledWith({ kind: 'pets', smartAlbumHiddenDto: { hidden: true } });
    expect(await screen.findByText('Hidden')).toBeInTheDocument();
  });
});

describe('Words', () => {
  it('shows a list that holds the same word twice, and removes it', async () => {
    const onChange = vi.fn();
    render(Words, { label: 'Look out for', words: ['dog', 'dog', 'cat'], onChange });

    const chips = within(screen.getByRole('group', { name: 'Look out for' })).getAllByRole('listitem');
    expect(chips).toHaveLength(3);
    await fireEvent.click(within(chips[0]).getByRole('button'));
    expect(onChange).toHaveBeenCalledWith(['cat']);
  });
});
