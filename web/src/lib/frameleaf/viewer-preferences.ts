/**
 * Client-only Frameleaf viewer preferences (FL-35).
 *
 * The prototype persists a `frameleaf:viewer:v1` blob in local storage. Production only
 * needs the filmstrip toggle here: slideshow order, look, caption, transition, repeat and
 * progress already live in `$lib/stores/slideshow.store` and are edited through
 * `SlideshowSettingsPanel`. Nothing in this file reaches the server.
 */
import { persisted } from 'svelte-persisted-store';

export const showFilmstrip = persisted<boolean>('frameleaf-viewer-filmstrip', false);
