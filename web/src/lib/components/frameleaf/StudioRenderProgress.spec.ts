import { StudioRenderStage, MediaOperationKind, MediaOperationStatus, type MediaOperationDto } from '@frameleaf/sdk';
import { render, screen, cleanup } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { activityEtaSeconds, activityStatusText, fromMediaOperation } from '$lib/frameleaf/activity';
import StudioRenderProgress from './StudioRenderProgress.svelte';

beforeAll(async () => {
  register('en-US', () => import('$i18n/en.json'));
  await init({ fallbackLocale: 'en-US', initialLocale: 'en-US' });
  await waitLocale('en-US');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
const now = Date.parse('2026-11-01T12:00:00Z');
const progress = {
  stage: StudioRenderStage.Rendering,
  lastProgressAt: '2026-11-01T11:59:50Z',
  framesPerSecond: 25,
  remainingRenderSeconds: 40,
} as const;
const props = { progress, startedAt: now - 30_000, active: true, online: true };

describe('Studio measured progress in Activity', () => {
  it('shows elapsed work time and measured speed without repeating the stage', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    render(StudioRenderProgress, props);
    expect(screen.getByText(/Elapsed:/)).toHaveTextContent('25 frames per second');
    expect(screen.queryByText(/Rendering frames/)).not.toBeInTheDocument();
    expect(document.querySelector('time')).toBeNull();
    expect(screen.queryByText(/No progress for/)).not.toBeInTheDocument();
  });
  it('does not count time before a worker started', () => {
    render(StudioRenderProgress, { ...props, startedAt: undefined });
    expect(screen.queryByText(/Elapsed:/)).not.toBeInTheDocument();
  });
  it('explains a stuck render without asserting a failed job, and yields to disconnection', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const stale = { ...progress, lastProgressAt: '2026-11-01T11:58:00Z' };
    render(StudioRenderProgress, { ...props, progress: stale });
    expect(screen.getByRole('status')).toHaveTextContent(
      "No progress for 2 minutes. The export may still be working, so this doesn't mean it failed.",
    );
    expect(screen.getByText(/Elapsed:/)).not.toHaveTextContent('frames per second');
    cleanup();
    render(StudioRenderProgress, { ...props, progress: stale, online: false });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
  it('keeps unknown speed and finalisation estimates honest', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    render(StudioRenderProgress, {
      ...props,
      progress: { ...progress, framesPerSecond: null, remainingRenderSeconds: null },
    });
    expect(screen.getByText(/Measuring speed/)).toBeInTheDocument();
    cleanup();
    render(StudioRenderProgress, {
      ...props,
      progress: {
        ...progress,
        stage: StudioRenderStage.Finalising,
        framesPerSecond: null,
        remainingRenderSeconds: null,
      },
    });
    expect(screen.getByText(/no time-left estimate for this last step/)).toBeInTheDocument();
    expect(screen.queryByText(/Measuring speed/)).not.toBeInTheDocument();
  });
  it('gives a finished export its outcome and total render time, never its queue time', () => {
    const job = {
      id: 'job',
      kind: MediaOperationKind.StudioExport,
      status: MediaOperationStatus.Completed,
      progress: 100,
      settings: {},
      createdAt: new Date(now - 600_000).toISOString(),
      startedAt: new Date(now - 180_000).toISOString(),
      finishedAt: new Date(now).toISOString(),
      renderProgress: progress,
    } as unknown as MediaOperationDto;
    const options = {
      translate: (key: string, values?: { values?: Record<string, unknown> }) =>
        `${key}${values?.values ? JSON.stringify(values.values) : ''}`,
      formatDuration: (seconds: number) => `${seconds}s`,
    };
    expect(activityStatusText(fromMediaOperation(job), options)).toBe(
      'frameleaf_activity_render_done_in{"time":"180s"}',
    );
    expect(
      activityStatusText(fromMediaOperation({ ...job, status: MediaOperationStatus.Failed, error: 'x' }), options),
    ).toBe('frameleaf_activity_render_failed_after{"time":"180s"}');
  });
  it('uses the durable server ETA after reconnect and never falls back to percentage estimates', () => {
    const job = {
      id: 'job',
      kind: MediaOperationKind.StudioExport,
      status: MediaOperationStatus.Rendering,
      progress: 50,
      totalUnits: '100',
      processedUnits: '50',
      settings: {},
      createdAt: new Date(now - 60_000).toISOString(),
      startedAt: new Date(now - 60_000).toISOString(),
      renderProgress: progress,
    } as MediaOperationDto;
    const restored = fromMediaOperation(structuredClone(job));
    expect(activityEtaSeconds(restored, now)).toBe(40);
    expect(activityEtaSeconds(fromMediaOperation({ ...job, renderProgress: undefined }), now)).toBeNull();
    expect(
      activityEtaSeconds(
        fromMediaOperation({
          ...job,
          renderProgress: { ...progress, stage: StudioRenderStage.Finalising, remainingRenderSeconds: null },
        }),
        now,
      ),
    ).toBeNull();
    expect(
      fromMediaOperation({
        ...job,
        status: MediaOperationStatus.Cancelling,
        cancelRequestedAt: new Date(now).toISOString(),
        cancelAcknowledgedAt: null,
      }).statusKey,
    ).toContain('cancelling');
  });
});
