import { MediaOperationKind } from 'src/enum.js';

/** Reserved scheduled bindings cannot become an ordinary run or a manual verification. */
export const hasWeeklyAuthorityInput = (snapshot: Record<string, unknown>): boolean =>
  ['grantId', 'grantGeneration', 'cohortId', 'memberOrdinal', 'batchOrdinal'].some((key) =>
    Object.hasOwn(snapshot, key),
  );

/** Generic operation surfaces carry no private scheduled authority or resource evidence. */
export const isPrivateICloudOperation = (operation: { kind: string; snapshot: Record<string, unknown> }): boolean =>
  operation.kind === MediaOperationKind.ICloudSync &&
  (hasWeeklyAuthorityInput(operation.snapshot) ||
    (Object.hasOwn(operation.snapshot, 'task') && operation.snapshot.task !== 'identity-audit') ||
    (Object.hasOwn(operation.snapshot, 'purpose') &&
      !(operation.snapshot.task === 'identity-audit' && operation.snapshot.purpose === 'manual-session')));
