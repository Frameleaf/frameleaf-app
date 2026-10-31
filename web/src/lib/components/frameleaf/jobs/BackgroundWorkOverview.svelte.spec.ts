import { QueueName, type QueueResponseDto, type ServerFeaturesDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import BackgroundWorkOverview from '$lib/components/frameleaf/jobs/BackgroundWorkOverview.svelte';
import { workRows } from '$lib/frameleaf/computers';
import type { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
import { presetNumbers } from '$lib/frameleaf/work-presets';
import en from '../../../../../../i18n/en.json';

const queue = (name: QueueName, statistics: Partial<QueueResponseDto['statistics']> = {}, isPaused = false) =>
  ({
    name,
    isPaused,
    statistics: { active: 0, completed: 0, delayed: 0, failed: 0, paused: 0, waiting: 0, ...statistics },
  }) as QueueResponseDto;

const numbers = (values: Record<string, number>) =>
  Object.fromEntries(Object.entries(values).map(([name, concurrency]) => [name, { concurrency }]));

/** A stand-in for the settings draft: the page only reads and writes `draft.job`. */
const store = (job: Record<string, { concurrency: number }>, saved = job) => {
  const draft = $state({ job });
  return {
    draft,
    baseline: { job: structuredClone(saved) },
    get changes() {
      return Object.keys(job)
        .filter((name) => draft.job[name].concurrency !== saved[name]?.concurrency)
        .map((name) => ({ path: `job.${name}.concurrency` }));
    },
  } as unknown as SystemConfigDraftStore;
};

const mount = (props: Partial<Parameters<typeof render<typeof BackgroundWorkOverview>>[1]> = {}) =>
  render(BackgroundWorkOverview, {
    rows: workRows([queue(QueueName.ThumbnailGeneration), queue(QueueName.FacialRecognition)]),
    flags: { facialRecognition: true } as ServerFeaturesDto,
    href: (name: QueueName) => `/work/${name}`,
    onPauseAll: vi.fn(),
    onResumeAll: vi.fn(),
    onTask: vi.fn(),
    onRetry: vi.fn(),
    ...props,
  });

const effort = () => within(screen.getByRole('group', { name: 'How hard this server works in the background' }));

describe('Background work, how hard this server works (FL-364)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  it('shows the server defaults as Balanced and says what that means', () => {
    mount({ store: store(numbers(presetNumbers('balanced'))) });

    expect(effort().getByRole('button', { name: 'Balanced' })).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByText(
        'A good fit for most servers. Balanced: up to 3 thumbnails, 1 video and 2 of each AI task at a time.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText('Custom')).not.toBeInTheDocument();
  });

  it('writes the existing numbers when a choice is made, and nothing else', async () => {
    const draft = store(numbers(presetNumbers('balanced')));
    mount({ store: draft });

    await fireEvent.click(effort().getByRole('button', { name: 'Fast' }));

    expect((draft.draft.job as unknown as Record<string, unknown>).thumbnailGeneration).toEqual({ concurrency: 6 });
    expect(draft.draft.job).toEqual(numbers(presetNumbers('fast')));
    expect(effort().getByRole('button', { name: 'Fast' })).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByText(/Fast: up to 6 thumbnails, 2 videos and 4 of each AI task at a time\./),
    ).toBeInTheDocument();
    expect(screen.getByText(/Not saved yet\. Save your changes to use it\./)).toBeInTheDocument();
  });

  it('shows numbers that match no choice as Custom, and leaves them alone until a choice replaces them', async () => {
    const draft = store(numbers({ ...presetNumbers('balanced'), thumbnailGeneration: 40 }));
    mount({ store: draft });

    expect(screen.getByText('Custom')).toBeInTheDocument();
    for (const name of ['Light', 'Balanced', 'Fast']) {
      expect(effort().getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
    }
    expect(screen.getByText(/Your own numbers: up to 40 thumbnails/)).toBeInTheDocument();
    // A number above what the page offers is shown and kept, not silently lowered.
    expect(screen.getByLabelText('Making thumbnails at the same time')).toHaveValue(40);
    expect(
      screen.getByText(/Making thumbnails is set to 40 at once, more than this page offers\./),
    ).toBeInTheDocument();
    expect(
      (draft.draft.job as unknown as Record<string, { concurrency: number }>).thumbnailGeneration.concurrency,
    ).toBe(40);

    await fireEvent.click(screen.getByRole('button', { name: 'Back to Balanced' }));
    expect(draft.draft.job).toEqual(numbers(presetNumbers('balanced')));
    expect(screen.queryByText('Custom')).not.toBeInTheDocument();
  });

  it('keeps each number under "Set each kind of work yourself", and names the ones that run one at a time', async () => {
    const draft = store(numbers(presetNumbers('balanced')));
    mount({ store: draft });

    const own = screen.getByText('Set each kind of work yourself').closest('details')!;
    expect(own).not.toHaveAttribute('open');
    const thumbnails = within(own).getByLabelText('Making thumbnails at the same time');
    await fireEvent.input(thumbnails, { target: { value: '5' } });
    expect(
      (draft.draft.job as unknown as Record<string, { concurrency: number }>).thumbnailGeneration.concurrency,
    ).toBe(5);
    expect(screen.getByText('Custom')).toBeInTheDocument();
    // More than the page offers is not accepted from the keyboard.
    await fireEvent.input(thumbnails, { target: { value: '400' } });
    expect(
      (draft.draft.job as unknown as Record<string, { concurrency: number }>).thumbnailGeneration.concurrency,
    ).toBe(5);
    expect(
      within(own).getByText('Always one at a time, because they must run in order: Recognising people.'),
    ).toBeInTheDocument();
  });

  it('does not offer the choice when a configuration file sets the numbers', () => {
    mount({ store: store(numbers(presetNumbers('balanced'))), locked: true });

    expect(effort().getByRole('button', { name: 'Fast' })).toBeDisabled();
    expect(screen.getByText(/set in the server’s configuration file/)).toBeInTheDocument();
  });

  it('says nothing about effort when the settings cannot be edited here', () => {
    mount();

    expect(screen.queryByText('How hard this server works')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Nothing is running' })).toBeInTheDocument();
  });
});
