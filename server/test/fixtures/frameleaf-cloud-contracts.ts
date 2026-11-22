import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Frameleaf Cloud's golden contract fixtures (`packages/contracts/fixtures`, see
 * `frameleaf-cloud-contracts/SOURCE.md`), read as the cloud published them.
 */
export const cloudContractFixture = <T = any>(name: string): T =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'frameleaf-cloud-contracts', name), 'utf8')) as T;

/**
 * FL-1676: a repository grant (FC-284) for an operation. Cloud publishes the upload one; the others differ only
 * in the operation their credentials are for.
 */
export const cloudRepositoryGrant = <T = any>(operation: 'upload' | 'restore' | 'prune' = 'upload'): T => {
  const grant = cloudContractFixture<{ capability: { operation: string } }>('backup/capability-repository-upload.json');
  grant.capability.operation = operation;
  return grant as T;
};
