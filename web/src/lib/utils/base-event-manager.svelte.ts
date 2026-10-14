type EventsBase = Record<string, unknown[]>;
type PromiseLike<T> = Promise<T> | T;

export type EventMap<E extends EventsBase> = { [K in keyof E]?: EventCallback<E, K> };
export type EventCallback<E extends EventsBase, T extends keyof E> = (...args: E[T]) => PromiseLike<unknown>;
export type EventItem<E extends EventsBase, T extends keyof E = keyof E> = {
  id: number;
  event: T;
  callback: EventCallback<E, T>;
};

let count = 1;
const nextId = () => count++;

export class BaseEventManager<Events extends EventsBase> {
  #callbacks = new Map<keyof Events, EventItem<Events>[]>();
  // Listener reads and subscription writes keep the original global Svelte dependency.
  #revision = $state.raw(0);

  on(subscriptions: EventMap<Events>): () => void {
    const items: EventItem<Events>[] = [];
    for (const [event, callback] of Object.entries(subscriptions)) {
      const item = this.#onEvent(event as keyof Events, callback as EventCallback<Events, keyof Events>);
      if (item) {
        items.push(item);
      }
    }

    return () => {
      for (const item of items) {
        this.#offEvent(item);
      }
    };
  }

  #onEvent(event: keyof Events, callback?: EventCallback<Events, keyof Events>) {
    if (!callback) {
      return;
    }

    const item = { id: nextId(), event, callback };
    this.#callbacks.set(event, [...(this.#callbacks.get(event) ?? []), item]);
    this.#revision++;

    return item;
  }

  #offEvent(item: EventItem<Events>) {
    const remaining = (this.#callbacks.get(item.event) ?? []).filter((current) => current.id !== item.id);
    if (remaining.length > 0) {
      this.#callbacks.set(item.event, remaining);
    } else {
      this.#callbacks.delete(item.event);
    }
    this.#revision++;
  }

  emit<T extends keyof Events>(event: T, ...params: Events[T]) {
    const listeners = this.getListeners(event);
    for (const item of listeners) {
      const listener = item.callback as EventCallback<Events, T>;
      void listener(...params);
    }
  }

  hasListeners<T extends keyof Events>(event: T) {
    void this.#revision;
    return this.#callbacks.has(event);
  }

  private getListeners<T extends keyof Events>(event: T) {
    void this.#revision;
    return this.#callbacks.get(event) ?? [];
  }
}
