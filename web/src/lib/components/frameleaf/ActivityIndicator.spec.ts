import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadAssetsStore } from '$lib/stores/upload';
import ActivityIndicator from './ActivityIndicator.svelte';

const state = vi.hoisted(() => ({
  indicator: { count: 0, progress: null as number | null },
  isAdmin: false,
  cards: 0,
  watchRunningJobs: vi.fn(() => () => {}),
}));
vi.mock('$lib/frameleaf/activity', () => ({
  buildActivityList: () => [],
  activityIndicatorState: () => ({ progress: state.indicator.progress }),
  activityInProgressCount: (_items: unknown[], background: number) => state.indicator.count + background,
}));
vi.mock('$lib/frameleaf/activity-session.svelte', () => ({
  activitySession: { operations: [], watch: () => () => {} },
}));
vi.mock('$lib/frameleaf/background-work', () => ({
  buildBackgroundWorkCards: () => Array.from({ length: state.cards }),
}));
vi.mock('$lib/frameleaf/running-jobs-session.svelte', () => ({
  runningJobsSession: { summary: {}, watch: state.watchRunningJobs },
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    get authenticated() {
      return state.isAdmin;
    },
    get user() {
      return { isAdmin: state.isAdmin };
    },
  },
}));

/** The indicator reads the upload store, so writing to it makes the component ask again. */
const report = async (indicator: { count: number; progress: number | null }) => {
  state.indicator = indicator;
  uploadAssetsStore.reset();
  await tick();
};

/** Review finding 4 and motion item 6: one indicator, a ring that finishes. */
describe('ActivityIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.indicator = { count: 0, progress: null };
    state.isAdmin = false;
    state.cards = 0;
    state.watchRunningJobs.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it('is not drawn while nothing is running', () => {
    render(ActivityIndicator);
    expect(screen.queryByTestId('frameleaf-activity-indicator')).toBeNull();
  });

  it('links to Activity with the count, and fills the ring to the measured progress', async () => {
    const { container } = render(ActivityIndicator);
    await report({ count: 2, progress: 50 });

    const link = screen.getByRole('link', { name: 'frameleaf_activity_indicator_progress' });
    expect(link).toHaveAttribute('href', '/activity');
    expect(link).toHaveTextContent('2');
    const arc = container.querySelector('.fl-activity-arc')!;
    const ring = Number(arc.getAttribute('stroke-dasharray'));
    expect(Number(arc.getAttribute('stroke-dashoffset'))).toBeCloseTo(ring / 2, 3);
    expect(arc).not.toHaveClass('is-indeterminate');
  });

  it('counts an administrator’s background work, as Activity’s In progress does', async () => {
    state.isAdmin = true;
    state.cards = 2;
    render(ActivityIndicator);
    await report({ count: 1, progress: null });

    expect(state.watchRunningJobs).toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'frameleaf_activity_indicator' })).toHaveTextContent('3');
  });

  it('does not ask for background work for anyone else: the server sends them none', async () => {
    state.cards = 2;
    render(ActivityIndicator);
    await report({ count: 1, progress: null });

    expect(state.watchRunningJobs).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'frameleaf_activity_indicator' })).toHaveTextContent('1');
  });

  it('turns a quarter arc while the work reports no progress', async () => {
    const { container } = render(ActivityIndicator);
    await report({ count: 1, progress: null });

    expect(screen.getByRole('link', { name: 'frameleaf_activity_indicator' })).toBeInTheDocument();
    expect(container.querySelector('.fl-activity-arc')).toHaveClass('is-indeterminate');
  });

  it('closes into a tick when the last job ends, then goes away', async () => {
    const { container } = render(ActivityIndicator);
    await report({ count: 1, progress: 80 });
    await report({ count: 0, progress: null });

    const link = screen.getByRole('link', { name: 'frameleaf_activity_indicator_done' });
    expect(link).toHaveClass('is-done');
    expect(container.querySelector('.fl-activity-tick')).not.toBeNull();
    expect(container.querySelector('.fl-activity-arc')?.getAttribute('stroke-dashoffset')).toBe('0');
    expect(container.querySelector('.fl-activity-count')).toBeNull();

    vi.advanceTimersByTime(1500);
    await tick();
    expect(screen.queryByTestId('frameleaf-activity-indicator')).toBeNull();
  });

  it('goes straight back to the ring when work starts again during the tick', async () => {
    const { container } = render(ActivityIndicator);
    await report({ count: 1, progress: 80 });
    await report({ count: 0, progress: null });
    await report({ count: 3, progress: 10 });

    expect(container.querySelector('.fl-activity-tick')).toBeNull();
    expect(screen.getByRole('link', { name: 'frameleaf_activity_indicator_progress' })).toHaveTextContent('3');
    vi.advanceTimersByTime(2000);
    await tick();
    expect(screen.getByTestId('frameleaf-activity-indicator')).toBeInTheDocument();
  });
});
