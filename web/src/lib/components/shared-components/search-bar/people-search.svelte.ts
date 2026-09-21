import type { PersonResponseDto } from '@immich/sdk';
import { onMount, untrack } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { searchManager } from '$lib/managers/search-manager.svelte';
import { getPeople } from './search-bar-utils';

// Shared by the search dropdown and the full search-options modal.
export class PeopleSearch {
  people = $state<PersonResponseDto[]>();
  loading = $state(false);
  failed = $state(false);
  generation = $state(0);
  #blocked = $state(false);
  #request?: AbortController;
  #owner?: string;

  constructor(needed: () => boolean) {
    $effect(() => {
      const owner = authManager.authenticated ? authManager.user.id : undefined;
      untrack(() => {
        if (this.#owner === owner) {
          return;
        }
        if (this.#owner !== undefined) {
          this.clear();
        }
        this.#owner = owner;
        this.#blocked = !owner;
      });
    });
    $effect(() => {
      if (needed() && authManager.authenticated && !this.#blocked && !this.people && !this.loading && !this.failed) {
        void untrack(() => this.load());
      }
    });
    onMount(() => {
      const clear = () => this.clear();
      const revoke = () => {
        this.clear();
        this.#blocked = true;
      };
      const stop = eventManager.on({
        SessionLocked: clear,
        SessionAccessChanged: clear,
        UserPinCodeReset: clear,
        AssetsMarkNsfw: clear,
        AssetsDelete: clear,
        PersonUpdate: clear,
        PersonThumbnailReady: clear,
        PersonAssetDelete: clear,
        AuthLogout: revoke,
        SessionDelete: revoke,
        AuthUserLoaded: ({ id }) => {
          if (id === this.#owner) {
            return;
          }
          this.clear();
          this.#owner = id;
          this.#blocked = false;
        },
      });
      return () => {
        stop();
        this.#request?.abort();
      };
    });
  }

  clear() {
    this.generation++;
    this.#request?.abort();
    this.#request = undefined;
    this.people = undefined;
    this.loading = this.failed = false;
    searchManager.filter.personIds.clear();
  }

  async load() {
    if (!authManager.authenticated || this.#blocked) {
      return;
    }
    this.#request?.abort();
    const request = new AbortController();
    const owner = authManager.user.id;
    this.#request = request;
    this.loading = true;
    this.failed = false;
    try {
      const people = await getPeople(searchManager.filter.personIds, request.signal);
      if (request.signal.aborted || !authManager.authenticated || authManager.user.id !== owner) {
        return;
      }
      const allowedIds = new SvelteSet(people.map((person) => person.id));
      for (const id of searchManager.filter.personIds) {
        if (!allowedIds.has(id)) {
          searchManager.filter.personIds.delete(id);
        }
      }
      this.people = people;
    } catch {
      if (!request.signal.aborted) {
        this.failed = true;
      }
    } finally {
      if (this.#request === request) {
        this.loading = false;
      }
    }
  }

  discard(personId: string) {
    searchManager.filter.personIds.delete(personId);
    this.people = this.people?.filter((person) => person.id !== personId);
    this.failed = true;
  }
}
