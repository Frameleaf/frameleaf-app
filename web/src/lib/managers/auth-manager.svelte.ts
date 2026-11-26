import {
  getServerFeatures,
  getMyPreferences,
  getMyUser,
  isHttpError,
  logout,
  type UserAdminResponseDto,
  type UserPreferencesResponseDto,
} from '@frameleaf/sdk';
import { untrack } from 'svelte';
import { browser } from '$app/env';
import { goto } from '$app/navigation';
import { page } from '$app/state';
import { forgetOtherAccountsEagleImports } from '$lib/frameleaf/eagle/eagle-import-record';
import { keepExtensionContinue } from '$lib/frameleaf/extension-sign-in';
import { hasLocalOfflineAlbums } from '$lib/frameleaf/local-offline';
import { withoutLockedRuleIds } from '$lib/frameleaf/locked-rules';
import { clearPrivateBrowserState, getPrivateBrowserStateGeneration } from '$lib/frameleaf/private-browser-state';
import { retireStudioImportSessions } from '$lib/frameleaf/studio/import-retention';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { Route } from '$lib/route';
import { isFrameleafSignInRequired } from '$lib/utils/handle-error';
import { isSharedLinkRoute } from '$lib/utils/navigation';
import { revokeSessionView } from '$lib/utils/session-privacy';

/**
 * FL-1771: a sign-out the server refused because the session is already over (expired, revoked, or a
 * session remote access no longer accepts) still signs out here. Anything else (offline, a server
 * error) left the session alive.
 */
const sessionAlreadyEnded = (error: unknown) =>
  (isHttpError(error) && error.status === 401) || isFrameleafSignInRequired(error);

class AuthManager {
  isPurchased = $state(false);
  isSharedLink = $derived(isSharedLinkRoute(page.route?.id));
  params = $derived(this.isSharedLink ? { key: page.params.key, slug: page.params.slug } : {});

  #user = $state<UserAdminResponseDto>();
  #preferences = $state<UserPreferencesResponseDto>();
  #sessionGeneration = $state(0);
  #loading: Promise<void> | undefined;
  /** FL-1798: the preferences `refresh` just read, for one reader that would otherwise ask again. */
  #freshPreferences: { value: UserPreferencesResponseDto; at: number } | undefined;

  captureSession({ reactive = false }: { reactive?: boolean } = {}) {
    // Capturing an async guard must not subscribe its caller's effect and restart work at sign-out.
    const generation = untrack(() => this.#sessionGeneration);
    const privateGeneration = getPrivateBrowserStateGeneration();
    const current = () =>
      generation === this.#sessionGeneration && privateGeneration === getPrivateBrowserStateGeneration();
    // Only session-bound display state opts in; existing async guards remain nonreactive.
    return reactive ? current : () => untrack(current);
  }

  get authenticated() {
    return !!(this.#user && this.#preferences);
  }

  get user() {
    if (!this.#user) {
      throw new TypeError('AuthManager.user is undefined');
    }

    return this.#user;
  }

  get preferences() {
    if (!this.#preferences) {
      throw new TypeError('AuthManager.preferences is undefined');
    }

    return this.#preferences;
  }

  constructor() {
    eventManager.on({
      // FL-34: a deleted session discards every view, player and download it held, not only the route
      SessionDelete: () => {
        this.#freshPreferences = undefined;
        revokeSessionView(Route.logout());
      },
      // what the server withholds changes with the lock, so an answer from before it is not reused
      SessionLocked: () => (this.#freshPreferences = undefined),
      SessionAccessChanged: () => (this.#freshPreferences = undefined),
      UserPinCodeReset: () => (this.#freshPreferences = undefined),
    });
  }

  /** FL-1798: the layout's loader and each page's `authenticate()` share one read on a cold load. */
  load(): Promise<void> {
    if (this.authenticated || !this.#hasAuthCookie()) {
      return Promise.resolve();
    }
    if (!this.#loading) {
      const loading = this.refresh().finally(() => {
        if (this.#loading === loading) {
          this.#loading = undefined;
        }
      });
      this.#loading = loading;
    }
    return this.#loading;
  }

  /**
   * FL-1798: the preferences as `refresh` read them within the last few seconds, handed out once, so
   * a store that opens with the app (saved searches) starts from that answer. Later readers ask the server.
   */
  takeFreshPreferences(maxAgeMs = 10_000): UserPreferencesResponseDto | undefined {
    const fresh = this.#freshPreferences;
    this.#freshPreferences = undefined;
    return fresh && Date.now() - fresh.at <= maxAgeMs ? fresh.value : undefined;
  }

  async refresh() {
    const isCurrent = this.captureSession();
    try {
      const [user, preferences] = await Promise.all([getMyUser(), getMyPreferences()]);
      if (!isCurrent()) {
        return;
      }
      this.setUser(user);
      this.setPreferences(preferences);
      this.#freshPreferences = { value: preferences, at: Date.now() };
      const isCurrentUser = this.captureSession();

      if (user.license?.activatedAt) {
        this.isPurchased = true;
      } else {
        // FL-156: a server supporter key (not a Frameleaf Cloud plan) gives everyone the badge
        const features = await getServerFeatures().catch(() => {});
        if (features) {
          eventManager.emit('ServerFeaturesLoaded', features);
        }
        if (!isCurrentUser()) {
          return;
        }
        // FL-1771: a removed licence or supporter key takes the badge away on the next read; a failed
        // read keeps what the session shows
        if (features) {
          this.isPurchased = features.supporter;
        }
      }

      eventManager.emit('AuthUserLoaded', user);
      // FL-1771: another account's Eagle import records don't stay in this browser
      void Promise.resolve(forgetOtherAccountsEagleImports(user.id)).catch(() => {});
    } catch {
      // noop
    }
  }

  /**
   * FL-146 (FL-77): read this account's preferences again, after an administrator changed them in
   * another session. A failure keeps what this session has; its next save is still checked by the server.
   */
  async refreshPreferences() {
    if (!this.authenticated) {
      return;
    }
    const isCurrent = this.captureSession();
    try {
      const preferences = await getMyPreferences();
      if (!isCurrent()) {
        return;
      }
      this.setPreferences(preferences);
      eventManager.emit('UserPreferencesRemoteUpdate');
    } catch {
      // keep the preferences this session has
    }
  }

  setUser(user: UserAdminResponseDto) {
    if (this.#user?.id !== user.id) {
      this.#sessionGeneration++;
      this.isPurchased = false;
    }
    if (this.#user && this.#user.id !== user.id) {
      retireStudioImportSessions();
    }
    this.#user = user;
  }

  /**
   * FL-67: the session-wide preferences never hold the account's Locked people, pets and tags,
   * even when a response from an unlocked session includes them. Only the Locked rules editor reads
   * them, straight from the server while the session is unlocked.
   */
  setPreferences(preferences: UserPreferencesResponseDto) {
    this.#preferences = withoutLockedRuleIds(preferences);
  }

  /**
   * `continue`: where the sign-in page goes once someone signs in again (FL-655: "Not you?").
   * Resolves false when the server could not end the session (FL-1771): the person stays signed in
   * here rather than seeing a sign-out that the next page load would undo.
   */
  async logout(options: { continue?: string } = {}): Promise<boolean> {
    let redirectUri = Route.login(options.continue ? { continue: options.continue } : undefined);

    const attempt = async () => {
      try {
        const response = await logout();
        if (response.redirectUri) {
          redirectUri = response.redirectUri;
        }
        return true;
      } catch (error) {
        if (sessionAlreadyEnded(error)) {
          return true;
        }
        console.error('[authManager.logout]: the session could not be ended', error);
        return false;
      }
    };
    // one retry covers a dropped connection or a server that was restarting
    if (!(await attempt()) && !(await attempt())) {
      return false;
    }

    retireStudioImportSessions();

    // FL-80: the account's private browser state goes with the session, also when the provider's
    // sign-out page takes over (which skips the in-app reset below)
    clearPrivateBrowserState();

    // Signing out already deleted the session, which revokes its offline album grants on the server.
    // A provider sign-out page still has to run, so Desktop's revoke step is only used without one.
    if (hasLocalOfflineAlbums() && redirectUri.startsWith('/')) {
      this.reset();
      eventManager.emit('AuthLogout');
      revokeSessionView(Route.logout());
      return true;
    }

    if (redirectUri.startsWith('/')) {
      this.isPurchased = false;

      this.reset();
      eventManager.emit('AuthLogout');

      await goto(redirectUri);
    } else {
      // FL-655: the provider's sign-out page loses the way back to the Allow page; keep it here
      if (options.continue) {
        keepExtensionContinue(options.continue);
      }
      location.assign(redirectUri);
    }
    return true;
  }

  reset() {
    this.#sessionGeneration++;
    this.#loading = undefined;
    this.#freshPreferences = undefined;
    retireStudioImportSessions();
    this.isPurchased = false;
    this.#user = undefined;
    this.#preferences = undefined;
  }

  #hasAuthCookie() {
    if (!browser) {
      return;
    }

    for (const cookie of document.cookie.split('; ')) {
      const [name] = cookie.split('=', 1);
      if (name === 'immich_is_authenticated') {
        return true;
      }
    }

    return false;
  }
}

export const authManager = new AuthManager();
