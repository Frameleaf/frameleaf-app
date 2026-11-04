import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import ActivityIndicator from './ActivityIndicator.svelte';

const state = vi.hoisted(() => ({ loads: 0, watch: vi.fn(() => () => {}) }));
vi.mock('$lib/frameleaf/activity-session.svelte', () => ({
  activitySession: { operations: [], watch: () => () => {} },
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { authenticated: true, user: { isAdmin: true } },
}));
// The first load fails, as a chunk replaced by an update would; the next one succeeds.
vi.mock('$lib/frameleaf/activity-indicator-admin', () => {
  state.loads++;
  if (state.loads === 1) {
    throw new Error('Failed to fetch dynamically imported module');
  }
  return {
    adminBackgroundWork: () => [{ stage: 'running', progress: null }],
    adminCloudOperationIds: () => new Set<string>(),
    watchAdminWork: state.watch,
  };
});

describe('ActivityIndicator administrator work', () => {
  it('tries loading it again after a failed load, then counts it', async () => {
    vi.useFakeTimers();
    try {
      render(ActivityIndicator);
      await vi.advanceTimersByTimeAsync(0);
      expect(state.watch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(30_000);
      await vi.waitFor(() => expect(state.watch).toHaveBeenCalled());
      await tick();
      expect(screen.getByTestId('frameleaf-activity-indicator')).toHaveTextContent('1');
    } finally {
      vi.useRealTimers();
    }
  });
});
