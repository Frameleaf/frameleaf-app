import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Frameleaf Cloud's golden contract fixtures (`packages/contracts/fixtures`, see
 * `frameleaf-cloud-contracts/SOURCE.md`), read as the cloud published them.
 */
export const cloudContractFixture = <T = any>(name: string): T =>
  JSON.parse(readFileSync(join(import.meta.dirname, 'frameleaf-cloud-contracts', name), 'utf8')) as T;
