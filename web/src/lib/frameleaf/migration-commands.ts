/**
 * The exact operator commands, shared with the guide in
 * `docs/docs/administration/server-migration.md`. They are code, so they are not
 * translated; `node packages/cli/dist/index.js` is the command-line tool built from source.
 */
const cli = 'node packages/cli/dist/index.js migrate';
const ledger = '--ledger ./library-move.sqlite';
export const migrationCommands = {
  tool: [
    'pnpm install --frozen-lockfile',
    'pnpm --filter @frameleaf/sdk build',
    'pnpm --filter @frameleaf/cli build',
  ].join('\n'),
  keys: [
    'export FRAMELEAF_FROM_URL=https://old-server.example/api',
    'export FRAMELEAF_TO_URL=https://new-server.example/api',
    'read -rs FRAMELEAF_FROM_KEY && export FRAMELEAF_FROM_KEY',
    'read -rs FRAMELEAF_TO_KEY && export FRAMELEAF_TO_KEY',
  ].join('\n'),
  preflight: `${cli} --preflight ${ledger}`,
  dryRun: `${cli} --dry-run ${ledger}`,
  run: `${cli} ${ledger} --serve`,
  retry: `${cli} ${ledger} --retry-failed`,
  verify: `${cli} --verify ${ledger}`,
} as const;
