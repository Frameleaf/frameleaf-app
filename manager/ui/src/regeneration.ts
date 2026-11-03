type RegenerationStatus = {
  state: string;
  completed: number;
  total: number;
  failed: number;
  blocked: number;
  needsAttention: number;
};

const FINISHED = new Set(['completed', 'completed_with_errors', 'cancelled']);

export function regenerationPresentation(status: RegenerationStatus) {
  const labels: Record<string, string> = {
    pending_first_setup: 'Waiting for first setup prerequisites',
    running: 'Regenerating your imported library',
    waiting: 'Regeneration queued',
    retrying: 'Regeneration retrying',
    delayed: 'Regeneration waiting to retry',
    paused: 'Regeneration paused',
    blocked: 'Regeneration waiting for prerequisites',
    unavailable: 'Waiting for a processing worker',
    needs_attention: 'Regeneration needs attention',
    completed: 'Regeneration complete',
    completed_with_errors: 'Regeneration finished with errors',
    cancelled: 'Regeneration cancelled',
  };
  return {
    label: labels[status.state] ?? 'Waiting for regeneration status',
    // Before the run is counted every figure is 0, which read as "0 files imported" on the success screen.
    detail:
      status.total === 0 && !FINISHED.has(status.state)
        ? 'Your photos are in place. Thumbnails, faces and search are rebuilt in the background once this starts.'
        : `${status.completed.toLocaleString()} of ${status.total.toLocaleString()} items complete · ${status.failed.toLocaleString()} failed · ${status.blocked.toLocaleString()} blocked · ${status.needsAttention.toLocaleString()} need attention`,
    attention: ['blocked', 'needs_attention', 'completed_with_errors', 'cancelled'].includes(status.state),
  };
}
