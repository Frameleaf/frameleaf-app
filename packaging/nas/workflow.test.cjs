const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { createRequire } = require('node:module');
const { load } = createRequire(path.resolve(__dirname, '../../server/package.json'))('js-yaml');

test('NAS dispatch authenticates component and optional application before retaining installers', () => {
  const workflow = load(fs.readFileSync(path.join(__dirname, '../../.github/workflows/nas-packages.yml'), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.permissions.contents, 'read');
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  const job = workflow.jobs.package;
  assert.match(job.if, /refs\/heads\/main/);
  const steps = job.steps;
  const manager = steps.findIndex(step => step.run?.includes('node packaging/nas/build-manager.cjs'));
  const application = steps.findIndex(step => step.run?.includes('node packaging/nas/build.cjs'));
  const upload = steps.findIndex(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert(manager >= 0 && application > manager && upload > application);
  assert.equal(steps[application].if, "inputs['application-tag'] != ''");
  assert.match(steps[manager].run, /\.tag == \$tag/);
  assert.match(steps[application].run, /isDraft or \.isPrerelease/);
  assert(!JSON.stringify(workflow).includes('secrets.'));
  assert(!JSON.stringify(workflow).includes('frameleaf-synology'));
  for (const step of steps) {
    if (step.uses?.startsWith('actions/checkout@')) assert.equal(step.with['persist-credentials'], false);
    assert.doesNotMatch(step.run ?? '', /\$\{\{.*inputs/);
  }
});
