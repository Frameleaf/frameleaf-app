import { searchWorkflows } from '@immich/sdk';
import { redirect } from '@sveltejs/kit';
import { pluginManager } from '$lib/managers/plugin-manager.svelte';
import { Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url, params }) => {
  await authenticate(url);
  const [workflows] = await Promise.all([searchWorkflows({}), pluginManager.ready()]);
  if (workflows.every(({ id }) => id !== params.workflowId)) {
    redirect(307, Route.workflows());
  }
  const $t = await getFormatter();
  return { workflows, workflowId: params.workflowId, meta: { title: $t('library_care_tool_workflows') } };
}) satisfies PageLoad;
