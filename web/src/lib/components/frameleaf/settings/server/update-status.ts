import { isNewerVersion } from '$lib/frameleaf/version-check';

/**
 * The answer Server & updates and its Updates page open on (FL-368):
 * - `available`: the newest version Frameleaf published is newer than the one running;
 * - `current`: the server looked and found nothing newer;
 * - `off`: the server is not looking for updates;
 * - `failed`: a check asked for on the page did not get an answer;
 * - `waiting`: looking is on, and the server has not looked yet.
 */
export type UpdateState = 'available' | 'current' | 'off' | 'failed' | 'waiting';

export const updateState = (facts: {
  /** Whether the server looks for updates (`newVersionCheck.enabled`, as saved). */
  looking: boolean;
  /** The version running, as a name ("v3.2.0"); undefined until the server has said. */
  installed?: string;
  /** The newest version the server has seen, as a name; null when it has seen none. */
  newest?: string | null;
  /** When the server last looked. */
  checkedAt?: string | null;
  /** A check asked for on this page failed. */
  failed?: boolean;
  /** A check asked for on this page was answered, whether or not the server looks by itself. */
  justChecked?: boolean;
}): UpdateState => {
  if (facts.failed) {
    return 'failed';
  }
  if (facts.newest && facts.installed && isNewerVersion(facts.newest, facts.installed)) {
    return 'available';
  }
  if (!facts.looking && !facts.justChecked) {
    return 'off';
  }
  return facts.checkedAt ? 'current' : 'waiting';
};
