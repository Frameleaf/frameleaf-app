/** Load replacement-local recovery authority before any application/configuration import. */
async function start() {
  const command = process.argv[2];
  if ((command === 'frameleaf-admin' || command === 'immich-admin') && process.argv[3] === 'buddy-backup') {
    const { buddyBackupCommand } = await import('./utils/buddy-backup-offline.js');
    await buddyBackupCommand(process.argv.slice(4));
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
