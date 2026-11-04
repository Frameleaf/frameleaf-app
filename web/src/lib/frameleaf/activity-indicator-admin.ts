import { buildBackgroundWorkCards } from '$lib/frameleaf/background-work';
import { cloudWorkSession } from '$lib/frameleaf/cloud-work-session.svelte';
import { runningJobsSession } from '$lib/frameleaf/running-jobs-session.svelte';

/**
 * What the top-bar indicator adds for an administrator: the server's background work cards and cloud
 * backup rows, as Activity counts them. Loaded only for administrators, so every other page load
 * stays within its bundle budget.
 */
export const adminBackgroundWork = () => [
  ...buildBackgroundWorkCards(runningJobsSession.summary),
  ...cloudWorkSession.rows,
];

/** The cloud operations the rows show, so the indicator counts each once. */
export const adminCloudOperationIds = () => new Set(cloudWorkSession.rows.map((row) => row.operationId));

/** Watch both sources; returns the stop function. */
export const watchAdminWork = () => {
  const stopJobs = runningJobsSession.watch();
  const stopCloud = cloudWorkSession.watch();
  return () => {
    stopJobs();
    stopCloud();
  };
};
