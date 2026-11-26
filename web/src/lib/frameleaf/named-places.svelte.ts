import {
  createUserPlace,
  deleteUserPlace,
  getUserPlaces,
  updateUserPlace,
  type UserPlaceCreateDto,
  type UserPlaceResponseDto,
  type UserPlaceUpdateDto,
} from '@frameleaf/sdk';
import { untrack } from 'svelte';
import { onLibraryAccessChange } from '$lib/frameleaf/library-access';
import { authManager } from '$lib/managers/auth-manager.svelte';

const byName = (a: UserPlaceResponseDto, b: UserPlaceResponseDto) => a.name.localeCompare(b.name);

/**
 * FL-1019: the signed-in person's named places, shared by the Map, Places and the viewer so a change in
 * one shows in the others without a reload. `revision` moves on every change: the viewer asks the server
 * again for the open item's place then. A shared link never loads them: its visitor is not their owner.
 */
class NamedPlacesManager {
  places = $state.raw<UserPlaceResponseDto[]>([]);
  loaded = $state(false);
  failed = $state(false);
  revision = $state(0);
  #request: Promise<void> | undefined;
  #generation = 0;
  #watching = false;

  /** Reads the list once; `force` asks again (Try again). Safe to call from an effect. */
  load(force = false): Promise<void> {
    return untrack(() => {
      if (authManager.isSharedLink) {
        return Promise.resolve();
      }
      if (!this.#watching) {
        this.#watching = true;
        // One account's names must never be shown to the next.
        onLibraryAccessChange((change) => {
          if (change === 'account' || change === 'revoked') {
            this.reset();
          }
        });
      }
      if (this.#request && !force) {
        return this.#request;
      }
      if (this.loaded && !force) {
        return Promise.resolve();
      }
      const generation = ++this.#generation;
      const request = (async () => {
        try {
          const places = await getUserPlaces();
          if (generation === this.#generation) {
            this.places = [...(places ?? [])].sort(byName);
            this.loaded = true;
            this.failed = false;
          }
        } catch {
          if (generation === this.#generation) {
            this.failed = true;
          }
        } finally {
          if (generation === this.#generation) {
            this.#request = undefined;
          }
        }
      })();
      this.#request = request;
      return request;
    });
  }

  async create(dto: UserPlaceCreateDto) {
    const place = await createUserPlace({ userPlaceCreateDto: dto });
    this.#changed([...this.places, place]);
    return place;
  }

  async update(id: string, dto: UserPlaceUpdateDto) {
    const place = await updateUserPlace({ id, userPlaceUpdateDto: dto });
    this.#changed(this.places.map((item) => (item.id === id ? place : item)));
    return place;
  }

  async remove(id: string) {
    await deleteUserPlace({ id });
    this.#changed(this.places.filter((item) => item.id !== id));
  }

  reset() {
    this.#generation++;
    this.#request = undefined;
    this.places = [];
    this.loaded = false;
    this.failed = false;
  }

  #changed(places: UserPlaceResponseDto[]) {
    this.places = [...places].sort(byName);
    this.revision += 1;
  }
}

export const namedPlaces = new NamedPlacesManager();
