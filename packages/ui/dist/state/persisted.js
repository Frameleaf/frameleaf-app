import { browser } from '$app/environment';
import { createSubscriber } from 'svelte/reactivity';
export class PersistedBase {
    #value;
    #subscribe;
    #update = () => { };
    #write;
    get current() {
        this.#subscribe();
        return this.#value;
    }
    set current(value) {
        this.#write(value);
        this.#update();
        this.#value = value;
    }
    constructor(key, defaultValue, options) {
        const value = options.read(key);
        this.#value = value === undefined ? defaultValue : value;
        this.#write = (value) => options.write(key, value);
        this.#subscribe = createSubscriber((update) => {
            this.#update = update;
            return () => {
                this.#update = () => { };
            };
        });
    }
}
const merge = (defaultValue) => {
    return (value) => {
        if (typeof value === 'object') {
            value = { ...defaultValue, ...value };
        }
        return value;
    };
};
const identity = (value) => value;
export class PersistedLocalStorage extends PersistedBase {
    constructor(key, defaultValue, options = {}) {
        const valid = options.valid || (() => true);
        const upgrade = options.upgrade === 'merge' ? merge(defaultValue) : (options.upgrade ?? identity);
        const serializer = options.serializer || JSON;
        super(key, defaultValue, {
            read: (key) => {
                if (!browser) {
                    return;
                }
                const item = localStorage.getItem(key) ?? undefined;
                if (item === undefined) {
                    return;
                }
                const parsed = serializer.parse(item);
                if (!valid(parsed)) {
                    return;
                }
                return upgrade(parsed);
            },
            write: (key, value) => {
                if (browser) {
                    localStorage.setItem(key, serializer.stringify(value));
                }
            },
        });
    }
}
