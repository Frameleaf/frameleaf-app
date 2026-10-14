/** Deployment-owned link only. No credentials or inferred host/port ever enter the browser. */
export function managerAccessUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  if (
    !/^[a-f0-9]{12}$/.test(env.FRAMELEAF_MANAGER_INSTALLATION ?? '') ||
    env.FRAMELEAF_MANAGER_TOKEN_FILE !== '/run/frameleaf/manager-token'
  )
    return null;
  try {
    const url = new URL(env.FRAMELEAF_MANAGER_URL ?? '');
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
      return null;
    return url.origin;
  } catch {
    return null;
  }
}
