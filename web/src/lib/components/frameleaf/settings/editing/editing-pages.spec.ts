import {
  MediaOperationKind,
  RestorationStyle,
  ToneMapping,
  VideoTrimMode,
  type AdminConfigDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
import en from '../../../../../../../i18n/en.json';
import AiRestoration from './AiRestoration.svelte';
import EditedMasters from './EditedMasters.svelte';
import StudioStatus from './StudioStatus.svelte';

const draft = vi.hoisted(() => ({ store: undefined as unknown }));
const flags = vi.hoisted(() => ({ configFile: false }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({ featureFlagsManager: { value: flags } }));
vi.mock('$lib/frameleaf/system-config-draft.svelte', async (original) => ({
  ...(await original<object>()),
  requireSystemConfigDraft: () => draft.store,
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

const config = (tonemap = ToneMapping.Hable) =>
  ({
    ffmpeg: { tonemap },
    editing: { trimMode: VideoTrimMode.Precise, restoration: { style: RestorationStyle.Faithful } },
  }) as unknown as AdminConfigDto;

const useDraft = (tonemap?: ToneMapping) => {
  const store = new SystemConfigDraftStore(
    { config: config(tonemap), revision: 'r1' },
    { defaults: config(), load: vi.fn(), save: vi.fn() },
  );
  draft.store = store;
  return store;
};

beforeAll(() => addMessages('dev', en));
beforeEach(() => {
  flags.configFile = false;
});

describe('Edited masters (FL-422)', () => {
  it('sets how trims are cut, and says back the choice', async () => {
    const store = useDraft();
    render(EditedMasters);

    expect(screen.getByText(/cuts exactly where you choose/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Fast · keyframe aligned' }));
    expect(store.draft.editing!.trimMode).toBe(VideoTrimMode.Fast);
    expect(screen.getByText(/saves in seconds when a trim is the only change/)).toBeInTheDocument();
  });

  it('shows size and audio as guarantees, not choices', () => {
    useDraft();
    render(EditedMasters);

    expect(screen.getByText('Original size')).toBeInTheDocument();
    expect(screen.getByText('Every channel')).toBeInTheDocument();
    // The trim choice is the page's only control.
    expect(screen.getAllByRole('button')).toHaveLength(2);
  });

  it('says what happens to HDR edits, which follows HDR on regular screens', () => {
    useDraft();
    const { unmount } = render(EditedMasters);
    expect(screen.getByText('Standard range')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /HDR on regular screens/ })).toHaveAttribute(
      'href',
      '/user-settings?area=editing&section=video-transcoding',
    );
    unmount();

    useDraft(ToneMapping.Disabled);
    render(EditedMasters);
    expect(screen.getByText('HDR kept')).toBeInTheDocument();
  });

  it('holds the choice when settings come from a file', () => {
    flags.configFile = true;
    useDraft();
    render(EditedMasters);

    expect(screen.getByRole('button', { name: 'Fast · keyframe aligned' })).toBeDisabled();
  });
});

describe('AI restoration (FL-422)', () => {
  it('sets the style a restoration starts on, with the promises beside it', async () => {
    const store = useDraft();
    render(AiRestoration);

    await fireEvent.click(screen.getByRole('button', { name: 'Creative' }));
    expect(store.draft.editing!.restoration.style).toBe(RestorationStyle.Creative);
    expect(screen.getByText(/rebuilds fine detail/)).toBeInTheDocument();
    expect(screen.getByText('Restored videos are at most 4K')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Where work runs' })).toBeInTheDocument();
  });
});

describe('Studio & Dolby Vision (FL-422)', () => {
  it('says whether Studio exports can run on this server', async () => {
    sdkMock.getRenderWorkerCompatibility.mockResolvedValue({
      qualified: [MediaOperationKind.StudioExport],
      unavailable: [],
    });
    render(StudioStatus);

    expect(await screen.findByText('Ready')).toBeInTheDocument();
    expect(screen.getByText('Automatic')).toBeInTheDocument();
    expect(screen.getByText('Not yet')).toBeInTheDocument();
    // No switch to hide Studio: it is on for everyone in this version.
    expect(screen.queryByRole('switch')).toBeNull();
  });

  it('says when no computer can make them, or when the check fails', async () => {
    sdkMock.getRenderWorkerCompatibility.mockResolvedValue({
      qualified: [],
      unavailable: [MediaOperationKind.StudioExport],
    });
    const { unmount } = render(StudioStatus);
    expect(await screen.findByText('Can’t run yet')).toBeInTheDocument();
    unmount();

    sdkMock.getRenderWorkerCompatibility.mockRejectedValue(new Error('offline'));
    render(StudioStatus);
    expect(await screen.findByText('Couldn’t check')).toBeInTheDocument();
  });
});
