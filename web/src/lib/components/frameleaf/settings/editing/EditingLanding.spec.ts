import { ImageFormat, QueueName, TranscodePolicy, type QueueResponseDto } from '@frameleaf/sdk';
import { render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import EditingLanding from '$lib/components/frameleaf/settings/editing/EditingLanding.svelte';
import type { SettingsHostSection } from '$lib/frameleaf/settings-areas';
import en from '../../../../../../../i18n/en.json';

const draft = vi.hoisted(() => ({ store: undefined as unknown }));

vi.mock('$lib/frameleaf/system-config-draft.svelte', async (original) => ({
  ...(await original<object>()),
  getSystemConfigDraft: () => draft.store,
}));

const baseline = (transcode = TranscodePolicy.Required) => ({
  baseline: {
    image: {
      thumbnail: { format: ImageFormat.Webp, size: 250, quality: 80, progressive: false },
      preview: { format: ImageFormat.Jpeg, size: 1440, quality: 80, progressive: false },
    },
    ffmpeg: { transcode, targetResolution: '1080', crf: 23, preset: 'medium' },
  },
});

const queue = (name: QueueName, waiting: number) =>
  ({
    name,
    isPaused: false,
    hasUnfinishedWork: waiting > 0,
    statistics: { active: 0, completed: 0, delayed: 0, failed: 0, paused: 0, waiting },
  }) as QueueResponseDto;

const sections = [
  { key: 'image', title: 'Image output', subtitle: 'old', icon: '' },
  { key: 'video-transcoding', title: 'Video playback proxies', subtitle: 'old', icon: '' },
] as SettingsHostSection[];

describe('Editing & playback landing (FL-366)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    sdkMock.getQueue.mockReset().mockImplementation(({ name }) => Promise.resolve(queue(name, 0)));
  });

  it('opens on the answer with the two choices and a row for each page', () => {
    draft.store = baseline();
    render(EditingLanding, { sections });

    const status = within(screen.getByRole('region', { name: 'Viewing status' }));
    expect(status.getByRole('heading', { name: 'Photos and videos are ready to view' })).toBeInTheDocument();
    expect(status.getByText('Balanced')).toBeInTheDocument();
    expect(status.getByText('Better (1080p)')).toBeInTheDocument();

    expect(screen.getByRole('link', { name: /Image previews/ })).toHaveAttribute(
      'href',
      '/user-settings?area=editing&section=image',
    );
    expect(screen.getByRole('link', { name: /Video playback copies/ })).toHaveAttribute(
      'href',
      '/user-settings?area=editing&section=video-transcoding',
    );
  });

  it('says copies are being made while work is waiting', async () => {
    sdkMock.getQueue.mockImplementation(({ name }) =>
      Promise.resolve(queue(name, name === QueueName.VideoConversion ? 3 : 2)),
    );
    draft.store = baseline();
    render(EditingLanding, { sections });

    expect(await screen.findByRole('heading', { name: 'Making previews and playback copies' })).toBeInTheDocument();
    expect(screen.getByText(/5 items are waiting/)).toBeInTheDocument();
  });

  it('says when playback copies are off', () => {
    draft.store = baseline(TranscodePolicy.Disabled);
    render(EditingLanding, { sections });

    expect(screen.getByText('Never make copies')).toBeInTheDocument();
  });
});
