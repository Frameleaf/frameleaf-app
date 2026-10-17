import {
  getServerFeatures,
  getMyPreferences,
  getMyUser,
  logout,
  type UserAdminResponseDto,
  type UserPreferencesResponseDto,
} from '@frameleaf/sdk';
import { browser } from '$app/env';
import { goto } from '$app/navigation';
import { page } from '$app/state';
import { withoutLockedRuleIds } from '$lib/frameleaf/locked-rules';
import { clearPrivateBrowserState, getPrivateBrowserStateGeneration } from '$lib/frameleaf/private-browser-state';
import { retireStudioImportSessions } from '$lib/frameleaf/studio/import-retention';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { Route } from '$lib/route';
import { isSharedLinkRoute } from '$lib/utils/navigation';
import { revokeSessionView } from '$lib/utils/session-privacy';

class AuthManager {
  isPurchased = $state(false);
  isSharedLink = $derived(isSharedLinkRoute(page.route?.id));
  params = $derived(this.isSharedLink ? { key: page.params.key, slug: page.params.slug } : {});

  #user = $state<UserAdminResponseDto>();
  #preferences = $state<UserPreferencesResponseDto>();
  #sessionGeneration = 0;

  captureSession() {
    const generation = this.#sessionGeneration;
    const privateGeneration = getPrivateBrowserStateGeneration();
    return () => generation === this.#sessionGeneration && privateGeneration === getPrivateBrowserStateGeneration();
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
      SessionDelete: () => revokeSessionView(Route.logout()),
    });
  }

  async load() {
    if (authManager.authenticated) {
      return;
    }

    if (!this.#hasAuthCookie()) {
      return;
    }

    return this.refresh();
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
      const isCurrentUser = this.captureSession();

      if (user.license?.activatedAt) {
        this.isPurchased = true;
      } else {
        // FL-156: a server supporter key (not a Frameleaf Cloud plan) gives everyone the badge
        const features = await getServerFeatures().catch(() => {});
        if (!isCurrentUser()) {
          return;
        }
        if (features?.supporter) {
          this.isPurchased = true;
        }
      }

      eventManager.emit('AuthUserLoaded', user);
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

  async logout() {
    retireStudioImportSessions();
    let redirectUri = Route.login();

    try {
      const response = await logout();
      if (response.redirectUri) {
        redirectUri = response.redirectUri;
      }
    } catch {
      // noop
    }

    // FL-80: the account's private browser state goes with the session, also when the provider's
    // sign-out page takes over (which skips the in-app reset below)
    clearPrivateBrowserState();

    if (redirectUri.startsWith('/')) {
      this.isPurchased = false;

      this.reset();
      eventManager.emit('AuthLogout');

      await goto(redirectUri);
    } else {
      location.assign(redirectUri);
    }
  }

  reset() {
    this.#sessionGeneration++;
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
