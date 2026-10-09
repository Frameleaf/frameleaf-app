import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { load } from 'js-yaml';

type Workflow = {
  on: { pull_request: { branches: string[]; paths?: string[]; 'paths-ignore'?: string[] } };
  jobs: Record<
    string,
    {
      uses?: string;
      steps?: { uses?: string; run?: string; with?: Record<string, unknown>; env?: Record<string, string> }[];
    }
  >;
};

test('Manager relies on the independent PR integration gate without running it a second time', () => {
  const manager = load(
    readFileSync(new URL('../../.github/workflows/manager.yml', import.meta.url), 'utf8'),
  ) as Workflow;
  const integration = load(
    readFileSync(new URL('../../.github/workflows/fork-integration.yml', import.meta.url), 'utf8'),
  ) as Workflow;
  const tests = load(readFileSync(new URL('../../.github/workflows/test.yml', import.meta.url), 'utf8')) as Workflow;

  for (const branch of manager.on.pull_request.branches) {
    assert.ok(integration.on.pull_request.branches.includes(branch), `Missing integration gate for ${branch}`);
    assert.ok(tests.on.pull_request.branches.includes(branch), `Missing medium test gate for ${branch}`);
  }
  assert.equal(integration.on.pull_request.paths, undefined);
  assert.equal(integration.on.pull_request['paths-ignore'], undefined);
  assert.equal(tests.on.pull_request.paths, undefined);
  assert.equal(tests.on.pull_request['paths-ignore'], undefined);
  const mediumSteps = tests.jobs['server-medium-tests'].steps;
  const mediumImage = 'frameleaf-medium:${{ github.sha }}';
  assert.ok(
    mediumSteps?.some(
      (step) =>
        step.uses?.startsWith('docker/build-push-action@') &&
        step.with?.context === '.' &&
        step.with?.file === 'server/Dockerfile' &&
        step.with?.target === 'medium-test' &&
        step.with?.load === true &&
        step.with?.tags === mediumImage,
    ),
    'Build and load the native medium runner for this commit',
  );
  const mediumRun = mediumSteps?.find((step) => step.env?.MEDIUM_IMAGE === mediumImage)?.run;
  assert.ok(mediumRun, 'Run the same medium image that was built');
  assert.match(mediumRun, /(?:^|\n)\s*docker run\b[^\n]*\\\n(?:[^\n]*\\\n)*\s*"\$MEDIUM_IMAGE"\s*$/);
  assert.ok(manager.jobs.manager, 'Keep the Manager architecture checks');
  assert.equal(
    Object.values(manager.jobs).some((job) => job.uses === './.github/workflows/fork-integration.yml'),
    false,
    'The independent PR workflow already runs this suite',
  );
});
