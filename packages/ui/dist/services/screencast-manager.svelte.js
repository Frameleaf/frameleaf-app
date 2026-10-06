import { PersistedLocalStorage } from '../state/persisted.js';
import { DateTime } from 'luxon';
class ScreencastManager {
    #enabled = new PersistedLocalStorage('show-keys', false);
    #cursor = $state();
    #events = $state([]);
    get cursor() {
        return this.#cursor;
    }
    get events() {
        return this.#events.map(({ event }) => event);
    }
    get enabled() {
        return this.#enabled.current;
    }
    toggle() {
        this.#enabled.current = !this.#enabled.current;
        this.#events = [];
        this.#cursor = undefined;
    }
    onTick() {
        if (!this.#enabled.current) {
            return;
        }
        const now = DateTime.now();
        this.#events = this.#events.filter(({ expiresAt }) => expiresAt > now);
    }
    onKeyDown(event) {
        if (!this.#enabled.current) {
            return;
        }
        this.#events.push({ event, expiresAt: DateTime.now().plus({ millisecond: 1500 }) });
        this.onTick();
    }
    onMouseDown(event) {
        if (!this.#enabled.current) {
            return;
        }
        this.#cursor = { event, moving: false };
    }
    onMouseMove(event) {
        if (!this.#enabled.current) {
            return;
        }
        if (this.#cursor) {
            this.#cursor = { event, moving: true };
        }
    }
    onMouseUp(_event) {
        if (!this.#enabled.current) {
            return;
        }
        this.#cursor = undefined;
    }
}
export const screencastManager = new ScreencastManager();
