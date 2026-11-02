<script lang="ts">
  import { ALBUM_COLORS, type AlbumColor } from '$lib/frameleaf/album-tree';
  import { Icon } from '@frameleaf/ui';
  import { mdiCancel, mdiCheck } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * "No colour" and the eight album colours as one radio group (prototype `ColourChoice`). Each
   * choice is a native radio with its name written under the swatch, so arrow keys move between
   * them and the colour is never the only way to tell them apart.
   */
  interface Props {
    value: AlbumColor | null;
    onChange: (value: AlbumColor | null) => void;
    /** Distinguishes the group when two forms are on one page. */
    name?: string;
  }

  let { value, onChange, name = 'album-color' }: Props = $props();
</script>

<fieldset class="color-choice">
  <legend>{$t('frameleaf_album_color_label')}</legend>
  <div class="options">
    <label class="option">
      <input type="radio" {name} checked={value === null} onchange={() => onChange(null)} />
      <span class="swatch none" aria-hidden="true"><Icon icon={mdiCancel} size="16" /></span>
      <span class="name">{$t('frameleaf_album_color_none')}</span>
    </label>
    {#each ALBUM_COLORS as color (color.id)}
      <label class="option">
        <input type="radio" {name} checked={value === color.id} onchange={() => onChange(color.id)} />
        <span class="swatch" style="--swatch-light: {color.light}; --swatch-dark: {color.dark};" aria-hidden="true">
          {#if value === color.id}<Icon icon={mdiCheck} size="14" />{/if}
        </span>
        <span class="name">{$t(color.labelKey)}</span>
      </label>
    {/each}
  </div>
</fieldset>

<style>
  .color-choice {
    margin: 0;
    padding: 0;
    border: 0;
    min-width: 0;
  }
  legend {
    margin-block-end: var(--fl-space-2);
    padding: 0;
    color: var(--fl-muted);
    font-size: 0.75rem;
    font-weight: 600;
  }
  .options {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
  .option {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    min-width: 44px;
    padding: 4px 2px;
    border-radius: var(--fl-radius);
    cursor: pointer;
  }
  .option input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
  }
  .swatch {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: var(--swatch-light);
    color: #fff;
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 12%);
  }
  :global([data-theme='dark']) .swatch:not(.none) {
    background: var(--swatch-dark);
    color: #111;
  }
  .swatch.none {
    background: var(--fl-raised);
    color: var(--fl-muted);
    box-shadow: inset 0 0 0 1px var(--fl-border);
  }
  .name {
    color: var(--fl-muted);
    font-size: 0.6875rem;
    line-height: 1.2;
  }
  .option:has(input:checked) .swatch {
    outline: 2px solid var(--fl-text);
    outline-offset: 2px;
  }
  .option:has(input:checked) .name {
    color: var(--fl-text);
    font-weight: 600;
  }
  .option:has(input:focus-visible) {
    outline: 2px solid var(--fl-accent);
    outline-offset: 1px;
  }
  .option:hover {
    background: var(--fl-raised);
  }
</style>
