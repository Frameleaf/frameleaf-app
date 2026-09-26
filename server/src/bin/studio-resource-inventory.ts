#!/usr/bin/env node
/**
 * Print the Studio graph resource inventory (FL-90) as JSON.
 *
 * The checked-in copy lives at `studio/resource-inventory.json`; regenerate it after changing
 * `server/src/utils/studio-resources.ts`:
 *
 *   pnpm --dir server exec tsx src/bin/studio-resource-inventory.ts > studio/resource-inventory.json
 *
 * `server/src/utils/studio-resources.spec.ts` fails when the two drift apart.
 */
import { buildStudioResourceInventory } from 'src/utils/studio-resources.js';

process.stdout.write(`${JSON.stringify(buildStudioResourceInventory(), null, 2)}\n`);
