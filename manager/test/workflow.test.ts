import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { load } from 'js-yaml';

type Workflow = {
  on: { pull_request: { branches: string[]; paths?: string[]; 'paths-ignore'?: string[] } };
  jobs: Record<string, { uses?: string; steps?: { run?: string }[] }>;
};

test('Manager relies on the independent PR integration gate without running it a second time', () => {
  const manager = load(
    readFileSync(new URL('../../.github/workflows/manager.yml', import.meta.url), 'utf8'),
  ) as Workflow;
  const integration = load(
    readFileSync(new URL('../../.github/workflows/fork-integration.yml', import.meta.url), 'utf8'),
  ) as Workflow;

  for (const branch of manager.on.pull_request.branches) {
    assert.ok(integration.on.pull_request.branches.includes(branch), `Missing integration gate for ${branch}`);
  }
  assert.equal(integration.on.pull_request.paths, undefined);
  assert.equal(integration.on.pull_request['paths-ignore'], undefined);
  assert.ok(integration.jobs.integration.steps?.some((step) => step.run?.includes('test:medium')));
  assert.ok(manager.jobs.manager, 'Keep the Manager architecture checks');
  assert.equal(
    Object.values(manager.jobs).some((job) => job.uses === './.github/workflows/fork-integration.yml'),
    false,
    'The independent PR workflow already runs this suite',
  );
});
