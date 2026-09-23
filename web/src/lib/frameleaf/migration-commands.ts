/**
 * The exact operator commands, shared with the guide in
 * `docs/docs/administration/server-migration.md`. They are code, so they are not
 * translated; `node packages/cli/dist/index.js` is the command-line tool built from source.
 */
const cli = 'node packages/cli/dist/index.js migrate';
const ledger = '--ledger ./library-move.sqlite';
export const migrationCommands = {
  tool: ['pnpm install --frozen-lockfile', 'pnpm --filter @immich/sdk build', 'pnpm --filter @immich/cli build'].join(
    '\n',
  ),
  keys: [
    'export IMMICH_FROM_URL=https://old-server.example/api',
    'export IMMICH_TO_URL=https://new-server.example/api',
    'read -rs IMMICH_FROM_KEY && export IMMICH_FROM_KEY',
    'read -rs IMMICH_TO_KEY && export IMMICH_TO_KEY',
  ].join('\n'),
  preflight: `${cli} --preflight ${ledger}`,
  dryRun: `${cli} --dry-run ${ledger}`,
  run: `${cli} ${ledger} --serve`,
  retry: `${cli} ${ledger} --retry-failed`,
  verify: `${cli} --verify ${ledger}`,
} as const;
