import { StudioRenderStage, MediaOperationKind, MediaOperationStatus, type MediaOperationDto } from '@frameleaf/sdk';
import { render, screen, cleanup } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { activityEtaSeconds, fromMediaOperation } from '$lib/frameleaf/activity';
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
  it('shows real phase, elapsed, FPS and last progress timestamp', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    render(StudioRenderProgress, props);
    expect(screen.getByText(/Rendering frames/)).toHaveTextContent('25 frames/s');
    expect(screen.getByText(/Rendering frames/)).toHaveTextContent('Elapsed:');
    expect(document.querySelector('time')).toHaveAttribute('datetime', progress.lastProgressAt);
    expect(screen.queryByText(/No measured progress/)).not.toBeInTheDocument();
  });
  it('explains a stale worker without asserting a failed job, and yields to disconnection', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    const stale = { ...progress, lastProgressAt: '2026-11-01T11:58:00Z' };
    render(StudioRenderProgress, { ...props, progress: stale });
    expect(screen.getByRole('status')).toHaveTextContent('This does not mean it has failed.');
    cleanup();
    render(StudioRenderProgress, { ...props, progress: stale, online: false });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
  it('keeps unknown speed and finalisation estimates honest', () => {
    render(StudioRenderProgress, {
      ...props,
      progress: { ...progress, framesPerSecond: null, remainingRenderSeconds: null },
    });
    expect(screen.getByText(/Measuring render speed/)).toBeInTheDocument();
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
    expect(screen.getByText(/Rendering time estimates do not include this stage/)).toBeInTheDocument();
    expect(screen.queryByText(/Measuring render speed/)).not.toBeInTheDocument();
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
