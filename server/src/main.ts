/** Load replacement-local recovery authority before any application/configuration import. */
async function start() {
  const command = process.argv[2];
  if ((command === 'frameleaf-admin' || command === 'immich-admin') && process.argv[3] === 'prepare-library-import') {
    const [option, path, ...rest] = process.argv.slice(4);
    if (option !== '--config' || !path || rest.length > 0) throw new Error('Invalid preparation arguments');
    const { prepareLibraryImport } = await import('./library-import/prepare-command.js');
    console.log(JSON.stringify(await prepareLibraryImport(path)));
    return;
  }
  if ((command === 'frameleaf-admin' || command === 'immich-admin') && process.argv[3] === 'import-library') {
    const { loadLibraryImportConfig, parseLibraryImportArguments } = await import('./library-import/command-input.js');
    const { enterImportExecutionLock } = await import('./library-import/execution-lock.js');
    const args = parseLibraryImportArguments(process.argv.slice(4));
    const config = await loadLibraryImportConfig(args.configPath);
    if (!(await enterImportExecutionLock(config.stateDirectory))) return;
  }
  if ((command === 'frameleaf-admin' || command === 'immich-admin') && process.argv[3] === 'buddy-backup') {
    // FL-509: the offline command reports its own safe messages and usage; binding failures stay generic.
    const { runBuddyBackupCommand } = await import('./utils/buddy-backup-offline.js');
    await runBuddyBackupCommand(process.argv.slice(4));
    return;
  }
  // Other admin/deprecated commands retain their existing dispatch, without an overlay.
  if (!command) {
    const { loadBuddyBootBinding } = await import('./utils/buddy-boot-binding.js');
    await loadBuddyBootBinding();
  }
  await import('./supervisor.js');
}

void start().catch(() => {
  // Never print private paths, historical values, parser issues or secret-derived digests.
  console.error('Frameleaf startup configuration could not be validated');
  process.exitCode = 1;
});
