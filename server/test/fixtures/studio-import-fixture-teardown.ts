// The parent cannot authenticate the independent crash-window owner's final disposal decision.
export async function teardownRetentionFixture(
  crashWindowOwned: boolean,
  removeFiles: () => Promise<void>,
  closeDatabase: () => Promise<void>,
) {
  try {
    if (!crashWindowOwned) await removeFiles();
  } finally {
    await closeDatabase();
  }
}
