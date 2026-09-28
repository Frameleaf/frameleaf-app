import type { ServerClient } from 'src/commands/migrate/client';
import type { Controller } from 'src/commands/migrate/controller';
import type { Ledger } from 'src/commands/migrate/ledger';

/**
 * Phase 7: recreate stacks (grouped/burst photos) from their translated member IDs, primary
 * first. A stack waits while any enumerated member is not on B yet; one that ends up with
 * fewer than two members (the rest were never enumerated) is marked done.
 */
export async function migrateStacks(to: ServerClient, ledger: Ledger, controller: Controller) {
  controller.setPhase('stacks');
  for (const stack of ledger.stacksToDo()) {
    await controller.gate();
    if (controller.stopped) {
      return;
    }
    const orderedAIds = [stack.primaryAId, ...stack.memberAIds.filter((id) => id !== stack.primaryAId)];
    const bAssetIds: string[] = [];
    let pending = 0;
    for (const aId of orderedAIds) {
      const bId = ledger.bId(aId);
      if (bId) {
        bAssetIds.push(bId);
      } else if (ledger.hasAsset(aId)) {
        pending++;
      }
    }
    if (pending > 0) {
      // Creating the stack now would leave the late member out for good; wait for it.
      controller.log(`stack ${stack.primaryAId}: ${pending} member(s) not on destination yet`);
      continue;
    }
    if (bAssetIds.length < 2) {
      ledger.setStackDone(stack.primaryAId, '');
      continue;
    }
    try {
      const created = await to.createStack(bAssetIds);
      ledger.setStackDone(stack.primaryAId, created.id);
    } catch (error) {
      // Leave it un-done so a later run retries. One rejected stack must not abort the
      // phase, which would also skip the audit that proves the assets themselves landed.
      controller.log(`stack ${stack.primaryAId}: failed — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
