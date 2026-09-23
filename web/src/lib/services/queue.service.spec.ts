import { mdiImageSearchOutline } from '@mdi/js';
import { getQueuesActions } from '$lib/services/queue.service';

/**
 * The Jobs manager's header actions (`/admin/queues`). The design template's `JobsManager.jsx`
 * places "Enrichment tasks" between Concurrency and Create job (FL-59 follow-up); this only
 * checks the action's shape, not what its dialog does — that is `EnrichmentTasksModal.svelte`'s
 * job, and the flows it delegates to (description requeue, smart album re-evaluation) already
 * have their own coverage.
 */
describe('getQueuesActions', () => {
  it('offers Enrichment tasks alongside Concurrency and Create job', () => {
    const actions = getQueuesActions((key: string) => key, undefined);

    expect(actions.EnrichmentTasks).toBeDefined();
    expect(actions.EnrichmentTasks.icon).toBe(mdiImageSearchOutline);
    expect(actions.EnrichmentTasks.title).toBe('admin.enrichment_tasks');
    expect(actions.EnrichmentTasks.description).toBe('admin.enrichment_tasks_description');
  });

  it('keeps every existing header action', () => {
    const actions = getQueuesActions((key: string) => key, undefined);

    expect(Object.keys(actions)).toEqual(['ResumePaused', 'ManageConcurrency', 'EnrichmentTasks', 'CreateJob']);
  });
});
