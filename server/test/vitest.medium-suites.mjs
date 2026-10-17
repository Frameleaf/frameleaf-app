import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The medium scale specs: the queue pipeline run and those that load `SCALE_ITEMS` rows
 * (test/medium/scale.ts: 25,000 by default, first sized at 500,000), with the two long library and
 * iCloud ledgers. They take about as long as every other medium spec together, so CI runs them as
 * one job of their own beside the rest (`FRAMELEAF_MEDIUM_SUITE`). A spec left off this list still
 * runs: `core` is every medium spec that is not listed here.
 */
export const MEDIUM_SCALE_SUITES = Object.freeze({
  scale: [
    'test/medium/specs/repositories/sql-queue.spec.ts',
    'test/medium/specs/repositories/queue-selection-lineage.spec.ts',
    'test/medium/specs/repositories/queue-selection-recovery.spec.ts',
    'test/medium/specs/repositories/queue-scale.spec.ts',
    'test/medium/specs/repositories/queue-reliability-acceptance.spec.ts',
    'test/medium/specs/repositories/queue-selection-scale.spec.ts',
    'test/medium/specs/repositories/library-atomic-admission.spec.ts',
    'test/medium/specs/repositories/icloud-identity-adoption.repository.spec.ts',
    'test/medium/specs/repositories/library-production-source.spec.ts',
    'test/medium/specs/repositories/library-public-summary.spec.ts',
    'test/medium/specs/immich-import/derived-work.spec.ts',
  ],
});

const ALL = ['test/medium/**/*.spec.ts'];

/** The vitest `include`/`exclude` of one suite: unset or `all` (everything), `core`, or `scale`. */
export const mediumSuite = (name, serverRoot) => {
  const scale = Object.values(MEDIUM_SCALE_SUITES).flat();
  // A renamed spec would otherwise leave the scale job without it, silently back in `core`.
  const missing = scale.filter((file) => !existsSync(resolve(serverRoot, file)));
  if (missing.length > 0) {
    throw new Error(`The medium scale suite lists specs that do not exist: ${missing.join(', ')}`);
  }
  if (!name || name === 'all') {
    return { include: ALL, exclude: [] };
  }
  if (name === 'core') {
    return { include: ALL, exclude: scale };
  }
  if (Object.hasOwn(MEDIUM_SCALE_SUITES, name)) {
    return { include: MEDIUM_SCALE_SUITES[name], exclude: [] };
  }
  throw new Error(
    `Unknown FRAMELEAF_MEDIUM_SUITE "${name}": use all, core, ${Object.keys(MEDIUM_SCALE_SUITES).join(' or ')}`,
  );
};
