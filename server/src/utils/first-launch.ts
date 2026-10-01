import { ExitCode, ImmichWorker } from 'src/enum.js';

/** FL-295: the web UI's "Getting Ready…" screen. */
export const FIRST_LAUNCH_PAGE = '/getting-ready';

/** FL-295: the status the "Getting Ready…" screen polls; only the "Getting Ready…" worker answers it. */
export const FIRST_LAUNCH_STATUS_PATH = '/api/server/getting-ready';

/** FL-295: how long a client refused with 503 during "Getting Ready…" should wait before trying again. */
export const FIRST_LAUNCH_RETRY_AFTER_SECONDS = 5;

/**
 * FL-295: which workers the supervisor starts once maintenance mode is ruled out. On the first start on
 * a library the official server created, only the "Getting Ready…" worker; once it has handed over
 * (`prepared`), or on any other start, the configured workers. A failed check starts the configured
 * workers: their boot takes the safety copy itself, or refuses, before anything is migrated.
 */
export async function chooseBootWorkers({
  workers,
  prepared,
  isFirstLaunch,
}: {
  workers: ImmichWorker[];
  prepared: boolean;
  isFirstLaunch: () => Promise<boolean>;
}): Promise<ImmichWorker[]> {
  if (prepared) {
    return workers;
  }

  try {
    return (await isFirstLaunch()) ? [ImmichWorker.FirstLaunch] : workers;
  } catch (error) {
    console.error(`Could not check whether this is the first start on an existing library: ${error}`);
    return workers;
  }
}

/** FL-295: the "Getting Ready…" worker ended because the safety copy is done (or not needed). */
export function isFirstLaunchHandover(name: ImmichWorker, exitCode: number | null) {
  return name === ImmichWorker.FirstLaunch && exitCode === ExitCode.FirstLaunchReady;
}
