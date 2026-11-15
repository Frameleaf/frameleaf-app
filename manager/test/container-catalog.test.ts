// FL-1538: the Containers page's ranges must be ones the server starts with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { catalogEntry, valueIssue } from '../ui/src/container-catalog.js';
import { JOB_CAPACITY_LIMIT } from '../../server/src/queue/configuration.js';

test('Jobs at once stops at the server’s job capacity limit, with a plain message', () => {
  assert.equal(catalogEntry('FRAMELEAF_JOB_CAPACITY')?.max, JOB_CAPACITY_LIMIT);
  assert.equal(valueIssue('FRAMELEAF_JOB_CAPACITY', String(JOB_CAPACITY_LIMIT)), null);
  assert.equal(valueIssue('FRAMELEAF_JOB_CAPACITY', String(JOB_CAPACITY_LIMIT + 1)), `Between 1 and ${JOB_CAPACITY_LIMIT}.`);
});
