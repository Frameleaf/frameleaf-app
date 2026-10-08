/** Normal media-root discovery shared by all startup workers and preboot recovery.
 * Discovery grants no authority: recovery separately verifies the original mounted directory.
 */
export const discoverMediaLocation = (configured: string | undefined, exists: (path: string) => boolean): string => {
  if (configured) return configured;
  const found = ['/data', '/usr/src/app/upload'].filter((candidate) => exists(candidate));
  return found.length === 1 ? found[0] : '/usr/src/app/upload';
};
